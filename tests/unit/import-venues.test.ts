import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advertisedRating, describe, hourlyPrice, isImportable, isLocalDatabase, openingHours, PriceRow, PriceTable, slotMinutes, stableId, tableSport, typicalPrice, Venue, venueImages, venueSports, yardsOf } from '../../scripts/import-venues';

const venue: Venue = { slug: 'sport_demo', name: 'Demo', address: '1 Demo', hours: '05:00 - 23:00', sports: ['Cầu lông', 'Pickleball'] };
const row = (walkIn: number | null, extra: Partial<PriceRow> = {}): PriceRow => ({ days: 'T2 - CN', time: '5h - 6h', fixed: null, walkIn, ...extra });
const table = (group: string | null, name: string | null, ...walkIn: (number | null)[]): PriceTable => ({ group, name, rows: walkIn.map(price => row(price)) });

test('imported ids are stable and shaped as UUID v4', () => {
  assert.equal(stableId('branch:sport_demo'), stableId('branch:sport_demo'));
  assert.notEqual(stableId('branch:sport_demo'), stableId('shop:sport_demo'));
  assert.match(stableId('branch:sport_demo'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('opening hours become whole hours inside the schema limits', () => {
  assert.deepEqual(openingHours('05:00 - 23:00'), { opening: 5, closing: 23 });
  assert.deepEqual(openingHours('00:00 - 24:00'), { opening: 0, closing: 24 });
  // A venue is not open before its half-hour start, and a half-hour close is cut to the last whole hour.
  assert.deepEqual(openingHours('05:30 - 22:30'), { opening: 6, closing: 22 });
  // Overnight ranges cannot be expressed with one opening/closing pair; they run to midnight.
  assert.deepEqual(openingHours('18:00 - 02:00'), { opening: 18, closing: 24 });
  assert.deepEqual(openingHours('not a time'), { opening: 6, closing: 23 });
});

test('a price quoted for another slot length becomes an hourly price', () => {
  assert.equal(slotMinutes('1h30'), 90);
  assert.equal(slotMinutes('1.5h'), 90);
  assert.equal(slotMinutes('0,5h'), 30);
  assert.equal(slotMinutes('4h'), 240);
  assert.equal(slotMinutes('90 phút'), 90);
  assert.equal(slotMinutes('phut'), null);
  assert.equal(slotMinutes('30 phút'), 30);
  assert.equal(slotMinutes('người'), null);
  assert.equal(slotMinutes(null), null);
  assert.equal(hourlyPrice(row(880000, { per: '1h30' })), 587000);
  assert.equal(hourlyPrice(row(300000, { per: '1h' })), 300000);
  // A unit that is not a duration cannot be converted and is kept as quoted.
  assert.equal(hourlyPrice(row(50000, { per: 'người' })), 50000);
  assert.equal(hourlyPrice(row(null, { fixed: 90000 })), 90000);
  assert.equal(hourlyPrice(row(0)), null);
  // Prices no venue charges would overflow the price column and abort the whole import.
  assert.equal(hourlyPrice(row(3000000000)), null);
  assert.equal(hourlyPrice(row(90000000, { per: '1p' })), null);
});

test('only complete records are importable, and only into a local database', () => {
  const complete: Venue = { ...venue, location: { lat: 10.77, lng: 106.7 } };
  assert.equal(isImportable(complete), true);
  assert.equal(isImportable(venue), false);
  assert.equal(isImportable({ ...complete, location: { lat: null as unknown as number, lng: 106.7 } }), false);
  assert.equal(isImportable({ ...complete, location: { lat: 91, lng: 106.7 } }), false);
  assert.equal(isImportable({ ...complete, name: ' ' }), false);
  assert.equal(isImportable({ ...complete, sports: undefined as unknown as string[] }), false);
  assert.equal(isImportable({ ...complete, priceTables: [{ group: null, name: null, rows: undefined as unknown as PriceRow[] }] }), false);
  assert.equal(isLocalDatabase('postgresql://alobo:secret@127.0.0.1:55432/alobo'), true);
  assert.equal(isLocalDatabase('postgresql://alobo:secret@postgres:5432/alobo'), true);
  assert.equal(isLocalDatabase('postgresql://alobo:secret@db.example.com:5432/alobo'), false);
  assert.equal(isLocalDatabase(undefined), false);
});

test('a price list is worth its median hourly walk-in price and ignores missing prices', () => {
  assert.equal(typicalPrice(table(null, null, 350000, 280000, 250000, 400000, 300000)), 300000);
  assert.equal(typicalPrice(table(null, null, 70000, 170000)), 70000);
  assert.equal(typicalPrice(table(null, null, null, 0)), null);
});

test('a price list maps to the sport its titles name, and to no sport when they name none', () => {
  assert.equal(tableSport(table('Sân A', 'Pickleball'), venue)?.slug, 'pickleball');
  assert.equal(tableSport(table('Cầu Lông', 'Khách hàng'), venue)?.slug, 'badminton');
  assert.equal(tableSport(table('Bảng giá sân tennis', 'Giá ngày thường'), venue)?.slug, 'tennis');
  // The list's own name wins over its yard type: one yard type can carry lists for two sports.
  assert.equal(tableSport(table('Sân 1 - 2', 'Bóng rổ (1 sân 3x3)'), venue)?.slug, 'basketball');
  assert.equal(tableSport(table('Sân', 'Khách Hàng'), venue), null);
  // "7 người" only suggests football; it counts when the venue lists football.
  assert.equal(tableSport(table('Sân 7 người', 'Giá sân'), venue), null);
  assert.equal(tableSport(table('Sân 7 người', 'Giá sân'), { ...venue, sports: ['Đa năng', 'Bóng đá'] })?.slug, 'football');
  // A bare court number says nothing about the sport, even at a venue that lists football.
  assert.equal(tableSport(table('Sân 5', 'Giá sân'), { ...venue, sports: ['Cầu lông', 'Bóng đá'] }), null);
});

test('a venue gets one yard per yard type and sport, priced from the first list of that type', () => {
  const hall: Venue = { ...venue, sports: ['Bóng rổ'], priceTables: [table('Nguyên Sân', 'Thuê 60 phút', 600000), table('Nguyên Sân', 'Thuê 30 phút', 350000),
    table('Nửa Sân', 'Thuê 60 phút', 300000), table('Lớp học', 'Lớp học', 0)] };
  assert.deepEqual(yardsOf(hall).map(yard => [yard.name, yard.sport.slug, yard.price]), [['Nguyên Sân', 'basketball', 600000], ['Nửa Sân', 'basketball', 300000]]);

  const shared: Venue = { ...venue, sports: ['Pickleball', 'Bóng rổ'], priceTables: [table('Sân 1 - 2', 'Pickleball', 200000), table('Sân 1 - 2', 'Bóng rổ', 400000)] };
  assert.deepEqual(yardsOf(shared).map(yard => yard.name), ['Sân 1 - 2 (Pickleball)', 'Sân 1 - 2 (Bóng rổ)']);
  assert.notEqual(yardsOf(shared)[0].key, yardsOf(shared)[1].key);

  // Untitled lists go to the venue's main sport, which is never the catch-all "multi-sport" when another is listed.
  const plain: Venue = { ...venue, sports: ['Đa năng', 'Cầu lông'], priceTables: [table(null, null, 90000)] };
  assert.deepEqual(yardsOf(plain).map(yard => [yard.name, yard.sport.slug]), [['Cầu lông', 'badminton']]);
  assert.deepEqual(yardsOf({ ...venue, sports: ['Môn lạ'], priceTables: [table(null, null, 90000)] }), []);
  // A blank yard type falls through to the list's own name instead of producing a nameless yard.
  assert.deepEqual(yardsOf({ ...venue, priceTables: [table('  ', 'Sân thảm', 90000)] }).map(yard => yard.name), ['Sân thảm']);
});

test('a venue is found under the sports it lists, its yards serve and it was collected from', () => {
  const listed: Venue = { ...venue, sports: ['Đa năng', 'Cầu lông'], priceTables: [table('Sân tennis', 'Tennis', 150000)] };
  const slugs = venueSports(listed, { venues: { [listed.slug]: listed }, bySport: { 'Golf': { slugs: [listed.slug] }, 'Padel': { slugs: ['another'] } } }).map(sport => sport.slug);
  assert.deepEqual(slugs.sort(), ['badminton', 'golf', 'multi-sport', 'tennis']);
});

test('description is the price lists, one per line with both price columns, and nothing about where they came from', () => {
  const text = describe({ ...venue, rating: 4.7, reviewCount: 12, bookingUrl: 'https://example.test/san/sport_demo', priceTables: [
    { group: 'Cầu lông', name: 'Sân thảm', columns: ['Cố định', 'Vãng lai'], rows: [{ days: 'T2 - T6', time: '5h - 17h', fixed: 60000, walkIn: 70000 }] },
    { group: 'Sân 7', name: 'Sân 7', columns: ['Giá'], rows: [{ days: null, time: '6h - 15h', fixed: 880000, walkIn: 880000, per: '1h30' }] }] });
  assert.equal(text, 'Cầu lông - Sân thảm: T2 - T6 5h - 17h: Vãng lai 70.000 ₫, cố định 60.000 ₫.\nSân 7: 6h - 15h: 880.000 ₫/1h30.');
  assert.equal(describe({ ...venue, priceTables: [] }), '');
});

test('a price list is titled once and lists each time band once', () => {
  const band = { days: 'T2 - T6', time: '5h - 15h', fixed: 150000, walkIn: 150000 };
  const text = describe({ ...venue, priceTables: [
    { group: 'Sân VIP', name: 'Sân VIP - Giảm 10%', rows: [band, { ...band, time: '15h - 24h', walkIn: 250000 }, band] },
    { group: 'Sân thường', name: 'sân thường', rows: [band] }, { group: null, name: null, rows: [band] }, { group: 'Sân đôi', name: null, rows: [band] }] });
  assert.deepEqual(text.split('\n'), ['Sân VIP - Giảm 10%: T2 - T6 5h - 15h: 150.000 ₫; T2 - T6 15h - 24h: Vãng lai 250.000 ₫, cố định 150.000 ₫.',
    'sân thường: T2 - T6 5h - 15h: 150.000 ₫.', 'Bảng giá: T2 - T6 5h - 15h: 150.000 ₫.', 'Sân đôi: T2 - T6 5h - 15h: 150.000 ₫.']);
});

test('a long description drops whole price lists rather than cutting one in the middle', () => {
  const rows = Array.from({ length: 100 }, (_, hour) => row(100000 + hour, { time: `${hour}h - ${hour + 1}h` }));
  const text = describe({ ...venue, priceTables: [{ group: 'Sân A', name: 'Giá', rows }, { group: 'Sân B', name: 'Giá', rows }] });
  assert.ok(text.length > 0 && text.length <= 4000);
  assert.match(text, /^Sân A - Giá: /);
  assert.doesNotMatch(text, /Sân B/);
  assert.ok(text.endsWith('.'));
  // A single list that is too long on its own is cut rather than dropped.
  const huge = describe({ ...venue, priceTables: [{ group: 'Sân A', name: 'Giá', rows: Array.from({ length: 400 }, (_, hour) => row(100000 + hour, { time: `${hour}h - ${hour + 1}h` })) }] });
  assert.equal(huge.length, 4000);
  assert.match(huge, /^Sân A - Giá: /);
});

test('an advertised rating is kept to one decimal, and a figure that is not a score out of five is no rating', () => {
  assert.deepEqual(advertisedRating({ ...venue, rating: 4.66, reviewCount: 12 }), { rating: 4.7, reviewCount: 12 });
  assert.deepEqual(advertisedRating({ ...venue, rating: 5 }), { rating: 5, reviewCount: 0 });
  for (const rating of [0, 5.1, -1, null, undefined]) assert.deepEqual(advertisedRating({ ...venue, rating, reviewCount: 3 }), { rating: null, reviewCount: 0 });
  assert.deepEqual(advertisedRating({ ...venue, rating: 4, reviewCount: 2.5 }), { rating: 4, reviewCount: 0 });
  assert.deepEqual(advertisedRating({ ...venue, rating: 4, reviewCount: 2 ** 31 }), { rating: 4, reviewCount: 0 });
});

test('photos are kept as collected, cover first and without repeats', () => {
  const photos = venueImages({ ...venue, cover: 'https://files.test/main/cover-1-thumb.jpg', yardDiagram: 'https://files.test/main/yardDiagram-2.jpg',
    gallery: ['https://files.test/image/img-a-3-thumb.jpg', 'https://files.test/image/img-a-3-thumb.jpg', 'https://files.test/image/img-b-4.png'] });
  // Thumbnail links are not rewritten: a cover has no full-size original and a gallery original can be 13 MB.
  assert.deepEqual(photos, ['https://files.test/main/cover-1-thumb.jpg', 'https://files.test/image/img-a-3-thumb.jpg', 'https://files.test/image/img-b-4.png', 'https://files.test/main/yardDiagram-2.jpg']);
  assert.deepEqual(venueImages(venue), []);
});
