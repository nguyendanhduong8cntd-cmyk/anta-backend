// Imports venue listings (collected from the public booking site with the venues' permission) into the catalog.
// Usage: npm run db:import-venues -- <venues.json>
// Idempotent: ids are derived from each venue's slug, so re-running updates the same rows.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, PoolClient } from 'pg';

/** `per` is the slot a price is quoted for when it is not one hour, as printed by the venue ("1h30"). */
export interface PriceRow { days: string | null; time: string; fixed: number | null; walkIn: number | null; per?: string | null }
/** One published price list. `group` is the yard type it belongs to; several lists can share a yard type. */
export interface PriceTable { group: string | null; name: string | null; columns?: string[]; rows: PriceRow[] }
export interface Venue {
  slug: string; name: string; address: string; hours: string; sports: string[]; bookingUrl?: string;
  location?: { lat: number; lng: number } | null; rating?: number | null; reviewCount?: number;
  priceTables?: PriceTable[]; services?: { name: string; price: number; unit: string | null }[];
  cover?: string | null; avatar?: string | null; yardDiagram?: string | null; gallery?: string[]; rules?: string[];
}
export interface VenueFile { venues: Record<string, Venue>; bySport: Record<string, { slugs: string[] }> }
export interface Sport { slug: string; name: string }
export interface ImportedYard { key: string; name: string; sport: Sport; price: number }

/** Display name on the source site -> our sport. The seeded badminton sport keeps its fixed id. */
export const SPORTS: Record<string, Sport> = {
  'Pickleball': { slug: 'pickleball', name: 'Pickleball' }, 'Cầu lông': { slug: 'badminton', name: 'Cầu lông' },
  'Bóng đá': { slug: 'football', name: 'Bóng đá' }, 'Bóng rổ': { slug: 'basketball', name: 'Bóng rổ' },
  'Quần vợt': { slug: 'tennis', name: 'Quần vợt' }, 'Tennis': { slug: 'tennis', name: 'Quần vợt' },
  'Đa năng': { slug: 'multi-sport', name: 'Đa năng' }, 'Typti': { slug: 'typti', name: 'Typti' },
  'Lướt ván': { slug: 'wakeboard', name: 'Lướt ván' }, 'B.Chuyền': { slug: 'volleyball', name: 'Bóng chuyền' },
  'Bóng chuyền': { slug: 'volleyball', name: 'Bóng chuyền' }, 'Golf': { slug: 'golf', name: 'Golf' }, 'Padel': { slug: 'padel', name: 'Padel' }
};
const MULTI_SPORT = 'multi-sport', MAX_YARD_NAME = 80, MAX_DESCRIPTION = 4000, MAX_PRICE = 100000000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', 'postgres'];
const fold = (text: string) => text.normalize('NFC').toLowerCase().trim();
const SPORT_BY_LABEL = new Map(Object.entries(SPORTS).map(([label, sport]) => [fold(label), sport]));
const SPORT_BY_SLUG = new Map(Object.values(SPORTS).map(sport => [sport.slug, sport]));
/** A title that names a sport outright. */
const NAMED: [RegExp, string][] = [[/pickle/, 'pickleball'], [/cầu lông|badminton/, 'badminton'], [/bóng đá|b\.đá|football|futsal/, 'football'],
  [/bóng rổ|basket/, 'basketball'], [/tennis|quần vợt/, 'tennis'], [/bóng chuyền|b\.chuyền|volley/, 'volleyball'], [/golf/, 'golf'], [/padel/, 'padel'],
  [/typti/, 'typti'], [/lướt ván|wakeboard/, 'wakeboard']];
/** Wording that only suggests a sport ("7 người", "half court"); trusted when the venue itself lists that sport.
 *  A bare "sân 5" is not a hint: it is as often a court number as a five-a-side pitch. */
const HINTED: [RegExp, string][] = [[/\d+ người/, 'football'], [/half ?court|full ?court|3x3/, 'basketball']];

export function sportOf(label: string | null | undefined): Sport | null { return label ? SPORT_BY_LABEL.get(fold(label)) || null : null; }
const listedSports = (venue: Venue) => [...new Set(venue.sports.map(sportOf).filter((sport): sport is Sport => Boolean(sport)))];

/** Stable id for an imported row. Shaped as a version-4 UUID because the API validates ids as UUID v4. */
export function stableId(key: string) {
  const hex = createHash('sha256').update(`anta-import:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** "05:30 - 22:30" -> whole opening hours our schema stores. Overnight or all-day ranges close at 24. */
export function openingHours(text: string) {
  const match = text.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!match) return { opening: 6, closing: 23 };
  const opening = Math.min(23, Number(match[1]) + (Number(match[2]) > 0 ? 1 : 0));
  let closing = Math.min(24, Number(match[3]));
  if (closing <= opening) closing = 24;
  return { opening, closing };
}
/** "1h30" -> 90, "1.5h" -> 90, "4h" -> 240, "30 phút" -> 30. Anything that is not a duration (per person, per ticket) -> null. */
export function slotMinutes(per: string | null | undefined) {
  const text = fold(per || '').replace(/\s+/g, '');
  const hours = text.match(/^(\d+(?:[.,]\d+)?)(?:h|giờ)(\d{1,2})?$/), minutes = text.match(/^(\d+)(?:p|ph|phut|phút|')$/);
  if (hours) return Math.round(Number(hours[1].replace(',', '.')) * 60) + Number(hours[2] || 0);
  return minutes ? Number(minutes[1]) : null;
}
/** Walk-in price of a time slot as an hourly price, rounded to 1.000 ₫ when it was quoted for another slot length. */
export function hourlyPrice(row: PriceRow) {
  const amount = row.walkIn ?? row.fixed;
  if (amount === null || !Number.isInteger(amount) || amount <= 0) return null;
  const minutes = slotMinutes(row.per);
  const hourly = minutes && minutes !== 60 ? Math.round(amount * 60 / minutes / 1000) * 1000 : amount;
  return hourly > 0 && hourly <= MAX_PRICE ? hourly : null;
}
/** One price per yard in our schema: the median hourly walk-in price across the list's time slots. */
export function typicalPrice(table: PriceTable) {
  const prices = table.rows.map(hourlyPrice).filter((value): value is number => value !== null).sort((a, b) => a - b);
  return prices.length ? prices[Math.floor((prices.length - 1) / 2)] : null;
}
/** The sport a price list is for when its own titles say so; null when they do not. */
export function tableSport(table: PriceTable, venue: Venue): Sport | null {
  const exact = sportOf(table.name) || sportOf(table.group);
  if (exact) return exact;
  const listed = new Set(listedSports(venue).map(sport => sport.slug));
  for (const title of [table.name, table.group].map(text => fold(text || ''))) {
    const named = NAMED.filter(([pattern]) => pattern.test(title)).map(([, slug]) => slug);
    const hinted = HINTED.filter(([pattern, slug]) => listed.has(slug) && pattern.test(title)).map(([, slug]) => slug);
    const slug = named.find(candidate => listed.has(candidate)) || named[0] || hinted[0];
    if (slug) return SPORT_BY_SLUG.get(slug) || null;
  }
  return null;
}
/** One bookable yard per yard type and sport. The first price list of a yard type is its standard one; later
 *  lists (student rates, shorter slots) only appear in the description. Lists without a sport in their title
 *  take the venue's main sport. */
export function yardsOf(venue: Venue): ImportedYard[] {
  const listed = listedSports(venue), fallback = listed.find(sport => sport.slug !== MULTI_SPORT) || listed[0] || null;
  const yards = new Map<string, ImportedYard>();
  for (const table of venue.priceTables || []) {
    const sport = tableSport(table, venue) || fallback, price = typicalPrice(table);
    if (!sport || !price) continue;
    const title = table.group?.trim() || table.name?.trim() || sport.name, key = `${fold(title)}|${sport.slug}`;
    if (!yards.has(key)) yards.set(key, { key, name: title.slice(0, MAX_YARD_NAME), sport, price });
  }
  const list = [...yards.values()];
  return list.map(yard => list.some(other => other !== yard && other.name === yard.name)
    ? { ...yard, name: `${yard.name} (${yard.sport.name})`.slice(0, MAX_YARD_NAME) } : yard);
}
/** Every sport the venue is found under: the ones it lists, the ones its yards are for, and the categories it was collected from. */
export function venueSports(venue: Venue, data: VenueFile): Sport[] {
  const categories = Object.entries(data.bySport || {}).filter(([, entry]) => entry.slugs?.includes(venue.slug)).map(([label]) => sportOf(label));
  const all = [...listedSports(venue), ...yardsOf(venue).map(yard => yard.sport), ...categories].filter((sport): sport is Sport => Boolean(sport));
  return [...new Map(all.map(sport => [sport.slug, sport])).values()];
}
const money = (value: number) => `${value.toLocaleString('vi-VN')} ₫`;
function priceText(row: PriceRow, columns: string[] = []) {
  const unit = row.per ? `/${row.per}` : '';
  if (row.walkIn === null) return row.fixed === null ? '?' : money(row.fixed) + unit;
  if (row.fixed === null || row.fixed === row.walkIn) return money(row.walkIn) + unit;
  return `${columns[1] || 'Vãng lai'} ${money(row.walkIn)}${unit}, ${(columns[0] || 'Cố định').toLowerCase()} ${money(row.fixed)}${unit}`;
}
/** The venue's published price lists, one per line: "<title>: <days> <time>: <price>; ...". Sports, hours and
 *  rating have their own columns, and where a listing was collected from stays in the import file. */
export function describe(venue: Venue) {
  const lines = (venue.priceTables || []).map(table => {
    const group = table.group?.trim() || '', name = table.name?.trim() || '';
    const title = fold(name).startsWith(fold(group)) ? name || 'Bảng giá' : [group, name].filter(Boolean).join(' - ');
    const bands = table.rows.map(row => `${row.days ? row.days + ' ' : ''}${row.time}: ${priceText(row, table.columns)}`);
    return `${title}: ${[...new Set(bands)].join('; ')}.`;
  });
  // Drop whole lists from the end when the text is too long, so every list shown is complete; one oversized list is cut.
  while (lines.length > 1 && lines.join('\n').length > MAX_DESCRIPTION) lines.pop();
  return lines.join('\n').slice(0, MAX_DESCRIPTION);
}
/** The rating a venue advertises; none when the figure is missing or is not a score out of five. */
export function advertisedRating(venue: Venue): { rating: number | null; reviewCount: number } {
  const rating = venue.rating, count = venue.reviewCount;
  if (typeof rating !== 'number' || !(rating > 0 && rating <= 5)) return { rating: null, reviewCount: 0 };
  return { rating: Math.round(rating * 10) / 10, reviewCount: typeof count === 'number' && Number.isInteger(count) && count > 0 && count < 2 ** 31 ? count : 0 };
}
/** Whether a record from the file has everything a branch needs. Records that do not are reported, not imported. */
export function isImportable(venue: Venue) {
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  const lat = venue?.location?.lat, lng = venue?.location?.lng;
  return Boolean(venue) && text(venue.slug) && text(venue.name) && text(venue.address) && typeof venue.hours === 'string' && Array.isArray(venue.sports)
    && typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    && (venue.priceTables || []).every(table => Array.isArray(table?.rows));
}
/** The import only ever targets a developer's own database. */
export function isLocalDatabase(url: string | undefined) {
  try { return LOCAL_HOSTS.includes(new URL(url || '').hostname); } catch { return false; }
}
/** A venue's photos, cover first, exactly as the source lists them. They are its thumbnails on purpose: the
 *  full-size originals do not exist for covers and run to 13 MB each for gallery photos. */
export function venueImages(venue: Venue): string[] {
  return [...new Set([venue.cover, ...(venue.gallery || []), venue.yardDiagram].filter((url): url is string => Boolean(url)))];
}

async function importVenue(tx: PoolClient, venue: Venue, data: VenueFile, sportIds: Map<string, string>) {
  const shopId = stableId(`shop:${venue.slug}`), branchId = stableId(`branch:${venue.slug}`), hours = openingHours(venue.hours);
  const advertised = advertisedRating(venue);
  await tx.query('INSERT INTO catalog.shops(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=excluded.name', [shopId, venue.name]);
  await tx.query(`INSERT INTO catalog.branches(id,shop_id,name,address,description,location,opening_hour,closing_hour,images,rules,rating,review_count)
    VALUES($1,$2,$3,$4,$5,ST_SetSRID(ST_MakePoint($7,$6),4326)::geography,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,address=excluded.address,description=excluded.description,location=excluded.location,
      opening_hour=excluded.opening_hour,closing_hour=excluded.closing_hour,images=excluded.images,rules=excluded.rules,
      rating=excluded.rating,review_count=excluded.review_count,updated_at=now(),version=catalog.branches.version+1`,
    [branchId, shopId, venue.name, venue.address, describe(venue), venue.location!.lat, venue.location!.lng, hours.opening, hours.closing,
      JSON.stringify(venueImages(venue)), JSON.stringify(venue.rules || []), advertised.rating, advertised.reviewCount]);
  const yards = yardsOf(venue).map(yard => ({ ...yard, id: stableId(`yard:${venue.slug}:${yard.key}`) }));
  for (const yard of yards) {
    await tx.query(`INSERT INTO catalog.yards(id,branch_id,sport_id,name,hourly_price,active) VALUES($1,$2,$3,$4,$5,true)
      ON CONFLICT(id) DO UPDATE SET sport_id=excluded.sport_id,name=excluded.name,hourly_price=excluded.hourly_price,active=true`,
      [yard.id, branchId, sportIds.get(yard.sport.slug), yard.name, yard.price]);
  }
  // Yards from an earlier import that the venue no longer lists are hidden, never deleted: bookings may reference them.
  await tx.query('UPDATE catalog.yards SET active=false WHERE branch_id=$1 AND NOT (id = ANY($2::uuid[]))', [branchId, yards.map(yard => yard.id)]);
  await tx.query('DELETE FROM catalog.branch_sports WHERE branch_id=$1', [branchId]);
  await tx.query('INSERT INTO catalog.branch_sports(branch_id,sport_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING',
    [branchId, venueSports(venue, data).map(sport => sportIds.get(sport.slug))]);
  // The same item sold in two units is two services, so the unit is part of the name and of the id.
  const services = new Map((venue.services || []).filter(service => Number.isInteger(service.price) && service.price >= 0 && service.price <= MAX_PRICE)
    .map(service => ({ name: service.unit ? `${service.name} (${service.unit})` : service.name, price: service.price }))
    .map(service => [stableId(`service:${venue.slug}:${service.name}`), service]));
  for (const [id, service] of services) {
    await tx.query(`INSERT INTO catalog.services(id,branch_id,name,price) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,price=excluded.price`, [id, branchId, service.name, service.price]);
  }
  // Services the venue no longer lists are removed unless an order or a booking already uses them.
  await tx.query(`DELETE FROM catalog.services s WHERE s.branch_id=$1 AND NOT (s.id = ANY($2::uuid[]))
    AND NOT EXISTS(SELECT 1 FROM commerce.order_items i WHERE i.service_id=s.id) AND NOT EXISTS(SELECT 1 FROM booking.services b WHERE b.service_id=s.id)`,
    [branchId, [...services.keys()]]);
  return { yards: yards.length, services: services.size };
}

export async function importVenues(pool: Pool, data: VenueFile) {
  const tx = await pool.connect();
  const summary = { branches: 0, yards: 0, services: 0, withoutYard: [] as string[], skipped: [] as string[] };
  try {
    await tx.query('BEGIN');
    const records = Object.values(data.venues || {}), venues = [...new Map(records.filter(isImportable).map(venue => [venue.slug, venue])).values()];
    summary.skipped.push(...records.filter(venue => !isImportable(venue)).map(venue => String(venue?.slug || '(no slug)')));
    // Only sports some venue is found under are created, so the sport list shows no empty category.
    const sportIds = new Map<string, string>();
    for (const sport of new Map(venues.flatMap(venue => venueSports(venue, data)).map(item => [item.slug, item])).values()) {
      sportIds.set(sport.slug, (await tx.query(`INSERT INTO catalog.sports(name,slug) VALUES($1,$2)
        ON CONFLICT(slug) DO UPDATE SET name=catalog.sports.name RETURNING id`, [sport.name, sport.slug])).rows[0].id);
    }
    for (const venue of venues) {
      const result = await importVenue(tx, venue, data, sportIds).catch(error => { throw new Error(`${venue.slug}: ${error instanceof Error ? error.message : error}`); });
      summary.branches++; summary.yards += result.yards; summary.services += result.services;
      if (!result.yards) summary.withoutYard.push(venue.slug);
    }
    await tx.query('COMMIT');
    return summary;
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}

if (require.main === module) {
  const file = process.argv[2];
  if (process.env.NODE_ENV === 'production' || !isLocalDatabase(process.env.DATABASE_URL)) throw new Error('Venue import only runs against a local development database');
  if (!file) throw new Error('Usage: npm run db:import-venues -- <venues.json>');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  readFile(file, 'utf8').then(text => importVenues(pool, JSON.parse(text) as VenueFile))
    .then(summary => { console.log(JSON.stringify({ event: 'venues.imported', ...summary })); return pool.end(); })
    .catch(async error => { console.error(`Venue import failed: ${error instanceof Error ? error.message : 'unknown error'}`); await pool.end(); process.exitCode = 1; });
}
