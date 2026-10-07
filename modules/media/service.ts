import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Database } from '../../packages/database';
import { RedisService } from '../../packages/redis';
import { AccessService } from '../../packages/access';
import { ApiError, invariant } from '../../packages/contracts/errors';
import { PresignDto } from './dto';
import { sanitizeCourtImage } from './processing';

export interface CourtImage {
  id: string; branchId: string; yardId: string | null; url: string; width: number; height: number;
}

@Injectable()
export class MediaService {
  private s3?: S3Client;
  constructor(private readonly db: Database, private readonly redis: RedisService, private readonly access: AccessService) {}

  private storage() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const bucket = process.env.R2_BUCKET;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
      throw new ApiError('INTEGRATION_NOT_CONFIGURED', 'R2 S3 credentials or bucket are not configured', 503);
    }
    invariant(/^[a-f0-9]{32}$/i.test(accountId) && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket),
      'INVALID_R2_CONFIG', 'R2 account or bucket configuration is invalid', 503);
    const endpoint = process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;
    invariant(new RegExp(`^https://${accountId}(?:\\.(?:eu|us|fedramp))?\\.r2\\.cloudflarestorage\\.com$`, 'i').test(endpoint),
      'INVALID_R2_CONFIG', 'R2 endpoint must belong to the configured account', 503);
    this.s3 ||= new S3Client({ region: 'auto', endpoint, forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey }, requestChecksumCalculation: 'WHEN_REQUIRED' });
    return { bucket, client: this.s3 };
  }

  private async signUpload(userId: string, dto: PresignDto, branchId?: string, yardId?: string) {
    const { bucket, client } = this.storage();
    await this.redis.rateLimit(`media:presign:${userId}`, 20, 3600000);
    const id = randomUUID();
    const key = branchId ? `quarantine/courts/${branchId}/${id}` : `quarantine/users/${userId}/${id}`;
    let url: string;
    try {
      url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: dto.mimeType }),
        { expiresIn: 120, signableHeaders: new Set(['content-type']) });
    } catch { throw new ApiError('STORAGE_UNAVAILABLE', 'R2 signing is unavailable', 503); }
    await this.db.query(`INSERT INTO media.uploads(id,user_id,object_key,source_key,mime_type,expected_size,purpose,branch_id,yard_id)
      VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8)`,
      [id, userId, key, dto.mimeType, dto.size, branchId ? 'COURT' : 'GENERAL', branchId || null, yardId || null]);
    return { uploadId: id, method: 'PUT', url, headers: { 'Content-Type': dto.mimeType }, expiresIn: 120,
      status: 'PENDING', note: 'PUT raw bytes, then call complete; URLs are never stored in the catalog' };
  }

  async presign(userId: string, dto: PresignDto) { return this.signUpload(userId, dto); }

  async presignCourt(userId: string, branchId: string, dto: PresignDto, yardId?: string, requestId?: string) {
    await this.access.owner(userId, branchId);
    const branch = await this.db.query('SELECT 1 FROM catalog.branches WHERE id=$1', [branchId]);
    invariant(branch.rowCount, 'NOT_FOUND', 'Branch not found', 404);
    if (yardId) {
      const yard = await this.db.query('SELECT 1 FROM catalog.yards WHERE id=$1 AND branch_id=$2', [yardId, branchId]);
      invariant(yard.rowCount, 'NOT_FOUND', 'Yard does not belong to branch', 404);
    }
    const signed = await this.signUpload(userId, dto, branchId, yardId);
    await this.db.transaction(tx => this.access.audit(tx, userId, 'court_image.presign', 'media', signed.uploadId, requestId,
      { branchId, yardId: yardId || null }));
    return signed;
  }

  private async readBounded(client: S3Client, bucket: string, key: string, maxBytes: number) {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    invariant(response.Body, 'UPLOAD_NOT_FOUND', 'R2 object is unavailable', 409);
    const parts: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      invariant(total <= maxBytes, 'UPLOAD_TOO_LARGE', 'Uploaded file exceeds declared size', 400);
      parts.push(Buffer.from(chunk));
    }
    return Buffer.concat(parts);
  }

  async complete(userId: string, uploadId: string) {
    const { bucket, client } = this.storage();
    const row = (await this.db.query('SELECT * FROM media.uploads WHERE id=$1 AND user_id=$2', [uploadId, userId])).rows[0];
    invariant(row, 'NOT_FOUND', 'Upload not found', 404);
    if (row.status === 'UPLOADED' || row.status === 'CLEAN') return { uploadId, status: row.status };
    invariant(row.status === 'PENDING', 'UPLOAD_REJECTED', 'Upload is not available');
    let metadata;
    try { metadata = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: row.source_key || row.object_key })); }
    catch { throw new ApiError('UPLOAD_NOT_FOUND', 'Object is not available in R2', 409); }
    if (metadata.ContentLength !== row.expected_size || metadata.ContentType !== row.mime_type) {
      await this.db.query("UPDATE media.uploads SET status='REJECTED',completed_at=now() WHERE id=$1 AND status='PENDING'", [uploadId]);
      return { uploadId, status: 'REJECTED' };
    }
    if (row.purpose === 'GENERAL') {
      await this.db.query("UPDATE media.uploads SET status='UPLOADED',completed_at=now() WHERE id=$1 AND status='PENDING'", [uploadId]);
      return { uploadId, status: 'UPLOADED', note: 'Not public until a separate review process approves it' };
    }
    let original: Buffer;
    try { original = await this.readBounded(client, bucket, row.source_key || row.object_key, row.expected_size); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('STORAGE_UNAVAILABLE', 'Unable to read uploaded image from R2', 503);
    }
    invariant(original.length === row.expected_size, 'UPLOAD_SIZE_MISMATCH', 'Uploaded file size changed', 409);
    let processed;
    try { processed = await sanitizeCourtImage(original); }
    catch { throw new ApiError('INVALID_IMAGE', 'Uploaded file is not a supported raster image', 400); }
    const cleanKey = `courts/${row.branch_id}/${uploadId}.webp`;
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: cleanKey, Body: processed.body,
        ContentType: 'image/webp', CacheControl: 'private, max-age=600' }));
    } catch { throw new ApiError('STORAGE_UNAVAILABLE', 'Unable to publish sanitized image to R2', 503); }
    const updated = await this.db.query(`UPDATE media.uploads SET status='CLEAN',object_key=$2,mime_type='image/webp',
      expected_size=$3,width=$4,height=$5,completed_at=now() WHERE id=$1 AND status='PENDING' RETURNING id`,
      [uploadId, cleanKey, processed.body.length, processed.width, processed.height]);
    if (!updated.rowCount) {
      const current = (await this.db.query('SELECT status,width,height FROM media.uploads WHERE id=$1', [uploadId])).rows[0];
      invariant(current?.status === 'CLEAN', 'UPLOAD_REJECTED', 'Upload was rejected while processing');
      return { uploadId, status: 'CLEAN', width: current.width, height: current.height };
    }
    return { uploadId, status: 'CLEAN', width: processed.width, height: processed.height };
  }

  async completeCourt(userId: string, branchId: string, uploadId: string, requestId?: string) {
    await this.access.owner(userId, branchId);
    const row = (await this.db.query(`SELECT id FROM media.uploads WHERE id=$1 AND user_id=$2 AND branch_id=$3
      AND purpose='COURT' AND archived_at IS NULL`, [uploadId, userId, branchId])).rows[0];
    invariant(row, 'NOT_FOUND', 'Court image upload not found', 404);
    const result = await this.complete(userId, uploadId);
    if (result.status === 'CLEAN') await this.db.transaction(tx => this.access.audit(tx, userId,
      'court_image.published', 'media', uploadId, requestId, { branchId }));
    return result;
  }

  async archiveCourt(userId: string, branchId: string, uploadId: string, requestId?: string) {
    return this.db.transaction(async tx => {
      await this.access.owner(userId, branchId, tx);
      const result = await tx.query(`UPDATE media.uploads SET archived_at=coalesce(archived_at,now())
        WHERE id=$1 AND branch_id=$2 AND purpose='COURT' RETURNING id`, [uploadId, branchId]);
      invariant(result.rowCount, 'NOT_FOUND', 'Court image not found', 404);
      await this.access.audit(tx, userId, 'court_image.archive', 'media', uploadId, requestId, { branchId });
      return { archived: true };
    });
  }

  async courtImages(branchIds: string[]): Promise<CourtImage[]> {
    if (!branchIds.length) return [];
    const rows = (await this.db.query(`SELECT id,branch_id,yard_id,object_key,width,height FROM media.uploads
      WHERE purpose='COURT' AND status='CLEAN' AND archived_at IS NULL AND branch_id=ANY($1::uuid[])
      ORDER BY created_at,id`, [branchIds])).rows;
    if (!rows.length) return [];
    const { bucket, client } = this.storage();
    return Promise.all(rows.map(async row => ({ id: row.id, branchId: row.branch_id, yardId: row.yard_id,
      url: await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: row.object_key }), { expiresIn: 600 }),
      width: row.width, height: row.height })));
  }

  async get(userId: string, uploadId: string) {
    const row = (await this.db.query(`SELECT id,mime_type,expected_size,status,purpose,branch_id,yard_id,width,height,
      created_at,completed_at,archived_at FROM media.uploads WHERE id=$1 AND user_id=$2`, [uploadId, userId])).rows[0];
    invariant(row, 'NOT_FOUND', 'Upload not found', 404);
    return row;
  }
}
