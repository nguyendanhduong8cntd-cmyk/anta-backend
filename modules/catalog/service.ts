import { Injectable } from '@nestjs/common';
import { Database, DbClient } from '../../packages/database';
import { invariant } from '../../packages/contracts/errors';
import { BranchQuery } from './dto';
@Injectable()
export class CatalogService {
  constructor(private readonly db: Database) {}
  async sports() { return (await this.db.query('SELECT id,name,slug FROM catalog.sports ORDER BY name')).rows; }
  async branches(q: BranchQuery) {
    invariant((q.lat === undefined) === (q.lng === undefined), 'VALIDATION_FAILED', 'lat and lng must be supplied together', 400);
    invariant(q.radius === undefined || q.lat !== undefined, 'VALIDATION_FAILED', 'radius requires coordinates', 400);
    const page = q.page || 1, pageSize = q.pageSize || 20;
    const point = 'ST_SetSRID(ST_MakePoint($2,$1),4326)::geography';
    const rows = (await this.db.query(`SELECT b.id,b.name,b.address,b.timezone,b.images,
      ST_Y(b.location::geometry) AS lat,ST_X(b.location::geometry) AS lng,
      CASE WHEN $1::float8 IS NULL THEN NULL ELSE round(ST_Distance(b.location,${point})) END AS distance_meters,
      count(*) OVER()::int AS total FROM catalog.branches b
      WHERE ($1::float8 IS NULL OR ST_DWithin(b.location,${point},$3))
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM catalog.yards y WHERE y.branch_id=b.id AND y.sport_id=$4 AND y.active))
      AND ($5::text IS NULL OR b.name ILIKE '%' || $5 || '%' OR b.address ILIKE '%' || $5 || '%')
      ORDER BY distance_meters NULLS LAST,b.name,b.id LIMIT $6 OFFSET $7`,
      [q.lat ?? null, q.lng ?? null, q.radius || 10000, q.sportId || null, q.q || null, pageSize, (page - 1) * pageSize])).rows;
    return { items: rows.map(({ total, ...row }) => row), page, pageSize, total: rows[0]?.total || 0 };
  }
  async branch(id: string) {
    const branch = (await this.db.query(`SELECT id,shop_id,name,address,description,timezone,opening_hour,closing_hour,images,rules,
      ST_Y(location::geometry) AS lat,ST_X(location::geometry) AS lng FROM catalog.branches WHERE id=$1`, [id])).rows[0];
    invariant(branch, 'NOT_FOUND', 'Branch not found', 404);
    const yards = (await this.db.query('SELECT id,sport_id,name,hourly_price,currency FROM catalog.yards WHERE branch_id=$1 AND active ORDER BY name', [id])).rows;
    return { ...branch, yards };
  }
  async services(id: string) { await this.branch(id); return (await this.db.query('SELECT * FROM catalog.services WHERE branch_id=$1 ORDER BY name', [id])).rows; }
  async yard(tx: DbClient, id: string, lock = false) {
    const yard = (await tx.query(`SELECT y.*,b.timezone,b.opening_hour,b.closing_hour FROM catalog.yards y
      JOIN catalog.branches b ON b.id=y.branch_id WHERE y.id=$1 ${lock ? 'FOR UPDATE OF y' : ''}`, [id])).rows[0];
    invariant(yard?.active, 'NOT_FOUND', 'Active yard not found', 404);
    return yard;
  }
  async favorites(userId: string) { return (await this.db.query('SELECT b.id,b.name,b.address,b.images FROM catalog.favorites f JOIN catalog.branches b ON b.id=f.branch_id WHERE f.user_id=$1 ORDER BY f.created_at DESC', [userId])).rows; }
  async favorite(userId: string, branchId: string, add: boolean) {
    await this.branch(branchId);
    if (add) await this.db.query('INSERT INTO catalog.favorites(user_id,branch_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId, branchId]);
    else await this.db.query('DELETE FROM catalog.favorites WHERE user_id=$1 AND branch_id=$2', [userId, branchId]);
    return { favorite: add };
  }
}
