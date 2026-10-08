import { Injectable } from '@nestjs/common';
import { Database, DbClient } from '../../packages/database';
import { invariant } from '../../packages/contracts/errors';
import { BranchQuery } from './dto';
import { MediaService } from '../media/service';
/** A venue (alias `b`) offers a sport when a yard of it is for that sport or the venue advertises it. */
const offers = (sport: string) => `(EXISTS(SELECT 1 FROM catalog.yards y WHERE y.branch_id=b.id AND y.sport_id=${sport} AND y.active)
  OR EXISTS(SELECT 1 FROM catalog.branch_sports a WHERE a.branch_id=b.id AND a.sport_id=${sport}))`;
const SPORTS_OF_BRANCH = `COALESCE((SELECT json_agg(json_build_object('slug',s.slug,'name',s.name) ORDER BY s.name)
  FROM catalog.sports s WHERE ${offers('s.id')}),'[]'::json) AS sports`;
/** The cheapest hour at a venue. Under a sport filter it is the cheapest hour of that sport, when the venue has a yard for it. */
const minPrice = (sport?: string) => `(SELECT ${sport ? `COALESCE(min(y.hourly_price) FILTER (WHERE y.sport_id=${sport}),min(y.hourly_price))` : 'min(y.hourly_price)'}
  FROM catalog.yards y WHERE y.branch_id=b.id AND y.active) AS min_price`;
/** Vietnamese is typed with or without its accents: "cau long" must find "Cầu lông". */
const matches = (column: string, term: string) => `unaccent(${column}) ILIKE '%' || unaccent(${term}) || '%'`;
/** What the user typed, with LIKE's own wildcards taken literally. */
const literal = (term: string) => term.replace(/[\\%_]/g, '\\$&');
/** What a venue card shows: every list of venues returns these columns. */
const CARD = `b.id,b.name,b.address,b.timezone,b.opening_hour,b.closing_hour,b.images,b.rating,b.review_count,
  ST_Y(b.location::geometry) AS lat,ST_X(b.location::geometry) AS lng`;
const MAX_FAVORITES_LISTED = 200;
const ORDER = { distance: 'distance_meters NULLS LAST,b.name,b.id',
  rating: 'b.rating DESC NULLS LAST,b.review_count DESC,distance_meters NULLS LAST,b.id',
  price: 'min_price NULLS LAST,distance_meters NULLS LAST,b.id' };
@Injectable()
export class CatalogService {
  constructor(private readonly db: Database, private readonly media: MediaService) {}
  async sports() {
    return (await this.db.query(`SELECT s.id,s.name,s.slug,(SELECT count(*)::int FROM catalog.branches b WHERE ${offers('s.id')}) AS venue_count
      FROM catalog.sports s ORDER BY s.name`)).rows;
  }
  async branches(q: BranchQuery) {
    invariant((q.lat === undefined) === (q.lng === undefined), 'VALIDATION_FAILED', 'lat and lng must be supplied together', 400);
    invariant(q.radius === undefined || q.lat !== undefined, 'VALIDATION_FAILED', 'radius requires coordinates', 400);
    const page = q.page || 1, pageSize = q.pageSize || 20;
    const point = 'ST_SetSRID(ST_MakePoint($2,$1),4326)::geography';
    const rows = (await this.db.query(`SELECT ${CARD},
      CASE WHEN $1::float8 IS NULL THEN NULL ELSE round(ST_Distance(b.location,${point})) END AS distance_meters,
      ${minPrice('$4::uuid')},${SPORTS_OF_BRANCH},count(*) OVER()::int AS total FROM catalog.branches b
      WHERE ($1::float8 IS NULL OR ST_DWithin(b.location,${point},$3))
      AND ($4::uuid IS NULL OR ${offers('$4')})
      AND ($5::text IS NULL OR ${matches('b.name', '$5')} OR ${matches('b.address', '$5')}
        OR EXISTS(SELECT 1 FROM catalog.sports s WHERE ${matches('s.name', '$5')} AND ${offers('s.id')}))
      ORDER BY ${ORDER[q.sort || 'distance']} LIMIT $6 OFFSET $7`,
      [q.lat ?? null, q.lng ?? null, q.radius || 10000, q.sportId || null, q.q ? literal(q.q) : null, pageSize, (page - 1) * pageSize])).rows;
    return { items: await this.withPhotos(rows.map(({ total, ...row }) => row)), page, pageSize, total: rows[0]?.total || 0 };
  }
  /** Adds the photos uploaded for each venue to the ones it was listed with. */
  private async withPhotos<T extends { id: string; images: unknown }>(rows: T[]) {
    const photos = await this.media.courtImages(rows.map(row => row.id));
    return rows.map(row => ({ ...row, images: [...(Array.isArray(row.images) ? row.images : []),
      ...photos.filter(photo => photo.branchId === row.id && photo.yardId === null).map(photo => photo.url)] }));
  }
  async branch(id: string) {
    const branch = (await this.db.query(`SELECT b.id,b.shop_id,b.name,b.address,b.description,b.timezone,b.opening_hour,b.closing_hour,b.images,b.rules,
      b.rating,b.review_count,ST_Y(b.location::geometry) AS lat,ST_X(b.location::geometry) AS lng,${minPrice()},${SPORTS_OF_BRANCH}
      FROM catalog.branches b WHERE b.id=$1`, [id])).rows[0];
    invariant(branch, 'NOT_FOUND', 'Branch not found', 404);
    const yards = (await this.db.query('SELECT id,sport_id,name,hourly_price,currency FROM catalog.yards WHERE branch_id=$1 AND active ORDER BY name', [id])).rows;
    const photos = await this.media.courtImages([id]);
    return { ...branch,
      images: [...(Array.isArray(branch.images) ? branch.images : []),
        ...photos.filter(photo => photo.yardId === null).map(photo => photo.url)],
      yards: yards.map(yard => ({ ...yard,
        images: photos.filter(photo => photo.yardId === yard.id).map(photo => photo.url) })) };
  }
  async services(id: string) { await this.branch(id); return (await this.db.query('SELECT * FROM catalog.services WHERE branch_id=$1 ORDER BY name', [id])).rows; }
  async yard(tx: DbClient, id: string, lock = false) {
    const yard = (await tx.query(`SELECT y.*,b.timezone,b.opening_hour,b.closing_hour FROM catalog.yards y
      JOIN catalog.branches b ON b.id=y.branch_id WHERE y.id=$1 ${lock ? 'FOR UPDATE OF y' : ''}`, [id])).rows[0];
    invariant(yard?.active, 'NOT_FOUND', 'Active yard not found', 404);
    return yard;
  }
  /** The user's favourite venues, the latest addition first, each as it appears in any other list of venues. */
  async favorites(userId: string) {
    return this.withPhotos((await this.db.query(`SELECT ${CARD},${minPrice()},${SPORTS_OF_BRANCH} FROM catalog.favorites f
      JOIN catalog.branches b ON b.id=f.branch_id WHERE f.user_id=$1 ORDER BY f.created_at DESC,b.id LIMIT $2`, [userId, MAX_FAVORITES_LISTED])).rows);
  }
  async favorite(userId: string, branchId: string, add: boolean) {
    await this.branch(branchId);
    if (add) await this.db.query('INSERT INTO catalog.favorites(user_id,branch_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId, branchId]);
    else await this.db.query('DELETE FROM catalog.favorites WHERE user_id=$1 AND branch_id=$2', [userId, branchId]);
    return { favorite: add };
  }
}
