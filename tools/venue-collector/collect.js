// Collects venue listings from the public Alobo booking site by reading what the page displays (accessibility
// tree) while browsing it like a visitor: filter by sport, open each of the nearest venues' side panel, read its tabs.
// One page, one venue at a time. No login. The reviews tab is never opened (it carries reviewers' names).
// usage: node collect.js <venues.json> [sport...]      -> { venues: {slug: {...}}, bySport: {sport: {slugs: [slug]}} }
// See README.md for the environment variables and the limits this tool keeps to.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const [destination, ...only] = process.argv.slice(2);
if (!destination) { console.error('usage: node collect.js <venues.json> [sport...]'); process.exit(1); }
const SPORTS = ['Pickleball', 'Cầu lông', 'Bóng đá', 'Bóng rổ', 'Quần vợt', 'Đa năng', 'Typti', 'Lướt ván', 'B.Chuyền', 'Golf', 'Padel'];
const PER_SPORT = Number(process.env.PER_SPORT || 10), ORIGIN = 'https://datlich.alobo.vn', PANEL = 592, HEIGHT = Number(process.env.VIEW_HEIGHT || 2800);
const [LAT, LNG] = (process.env.CENTER || '10.7769,106.7009').split(',').map(Number); // search centre, central Ho Chi Minh City by default
const file = destination.endsWith('.json') ? destination : path.join(destination, 'venues.json'), out = path.dirname(file);
fs.mkdirSync(out, { recursive: true });
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { venues: {}, bySport: {} };
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 1));
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

const read = page => page.evaluate(() => [...document.querySelectorAll('flt-semantics')].map(node => {
  const own = [...node.childNodes].filter(c => c.nodeType === 3 || (c.nodeType === 1 && c.tagName === 'SPAN')).map(c => c.textContent).join(' ').trim();
  const r = node.getBoundingClientRect();
  const text = node.getAttribute('aria-label') || own;
  // A node that merges several texts separates them with line breaks; `lines` keeps that separation.
  return { role: node.getAttribute('role') || '', label: text.replace(/\s+/g, ' ').trim(), lines: text.split(/\n+/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean),
    x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
}).filter(n => n.label));
async function waitFor(page, test, ms) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const hit = (await read(page)).filter(test); if (hit.length) return hit; await page.waitForTimeout(400);
  }
  return [];
}
async function click(page, test, ms = 15000, settle = 1500) {
  const target = (await waitFor(page, test, ms)).sort((a, b) => a.w * a.h - b.w * b.h)[0];
  if (!target) return false;
  await page.mouse.click(target.x, target.y); await page.waitForTimeout(settle);
  return true;
}
const slugOf = url => (url.match(/\/branch\/([^/]+)\//) || [])[1];
const CARD = /^(.*?) \((\d+(?:\.\d+)?\s?k?m)\) (.*?) (\d{2}:\d{2} - \d{2}:\d{2})/;
const isCard = n => n.role === 'group' && n.w > 500 && n.w < 700 && n.h > 150 && CARD.test(n.label);
const panelOpen = nodes => nodes.some(n => n.role === 'tab' && n.label === 'Thông tin' && n.x < PANEL);

/** Title lines run "[yard type] price list, price list, [yard type] price list…". A table that opens a new yard type sits one title line lower. */
function nameTables(lines, gaps) {
  const count = gaps.length, groups = lines.length - count;
  if (!count || groups < 0 || groups > count) return null;
  if (!groups) return lines.map(name => ({ group: null, name }));
  const ranked = gaps.map((gap, index) => ({ gap, index })).slice(1).sort((a, b) => b.gap - a.gap);
  // The split is only trusted when the tables that open a yard type are clearly lower than the ones that do not.
  if (groups > 1 && groups < count && ranked[groups - 2].gap - ranked[groups - 1].gap < 12) return null;
  const opens = new Set([0, ...ranked.slice(0, groups - 1).map(item => item.index)]);
  let next = 0, group = null;
  return gaps.map((_, index) => { if (opens.has(index)) group = lines[next++]; return { group, name: lines[next++] }; });
}
function parsePrices(nodes) {
  const start = nodes.find(n => n.label === 'BẢNG GIÁ SÂN');
  if (!start) return { titleLines: [], partial: false, tables: [] };
  const end = nodes.find(n => n.label.startsWith('DANH SÁCH DỊCH VỤ'));
  const body = nodes.filter(n => n.y > start.y && n.h < 60 && (!end || n.y < end.y - end.h / 2));
  const PRICE = /^([\d.]+) ₫(?:\s*\/\s*(.+))?$/, money = n => PRICE.test(n.label), time = n => /^\d{1,2}h(\d{2})? - \d{1,2}h(\d{2})?$/.test(n.label);
  const day = n => /^(T\d|CN)( - (T\d|CN))?$/.test(n.label) || /^(Cả tuần|Ngày lễ|Thứ \d|Chủ nhật)/i.test(n.label);
  const headers = body.filter(n => n.label === 'Khung giờ').sort((a, b) => a.y - b.y);
  const titleNode = nodes.find(n => n.role === 'group' && n.y > start.y && n.h >= 60 && !n.label.startsWith('DANH SÁCH'));
  const tables = headers.map((header, index) => {
    const next = headers[index + 1];
    const rows = body.filter(n => time(n) && n.y > header.y && (!next || n.y < next.y)).sort((a, b) => a.y - b.y);
    const days = body.filter(n => day(n) && n.y > header.y && (!next || n.y < next.y)).sort((a, b) => a.y - b.y);
    // Each day label is drawn centred beside its block of consecutive rows: pick the split whose block centres fit best.
    const mean = list => list.reduce((sum, n) => sum + n.y, 0) / list.length;
    const fit = (from, k) => {
      if (k === days.length - 1) return { cost: Math.abs(mean(rows.slice(from)) - days[k].y), cuts: [] };
      let best = null;
      for (let cut = from + 1; cut <= rows.length - (days.length - 1 - k); cut++) {
        const tail = fit(cut, k + 1), cost = Math.abs(mean(rows.slice(from, cut)) - days[k].y) + tail.cost;
        if (!best || cost < best.cost) best = { cost, cuts: [cut, ...tail.cuts] };
      }
      return best;
    };
    const cuts = days.length > 1 && rows.length >= days.length ? fit(0, 0).cuts : [];
    const dayOf = i => days.length ? days[cuts.filter(cut => cut <= i).length]?.label || null : null;
    // Price columns are either "fixed schedule / walk-in" or a single price; a price may be quoted per slot ("880.000 ₫/1h30").
    return { y: header.y, last: rows.length ? rows[rows.length - 1].y : header.y,
      columns: body.filter(n => Math.abs(n.y - header.y) <= 6 && n.x > header.x + 40).sort((a, b) => a.x - b.x).map(n => n.label),
      rows: rows.map((row, i) => {
        const prices = body.filter(n => money(n) && Math.abs(n.y - row.y) <= 6).sort((a, b) => a.x - b.x).map(n => n.label.match(PRICE))
          .map(m => ({ amount: Number(m[1].replace(/\./g, '')), per: m[2]?.trim() || null }));
        return { days: dayOf(i), time: row.label, fixed: prices[0]?.amount ?? null, walkIn: (prices[1] ?? prices[0])?.amount ?? null, per: (prices[1] ?? prices[0])?.per ?? null };
      }) };
  });
  const titleLines = titleNode?.lines || [];
  // The title node spans every table; if it reaches well below the last table read, some tables are off screen.
  const slack = tables.length && titleNode ? Math.round(titleNode.y + titleNode.h / 2 - tables[tables.length - 1].last) : 0;
  const partial = slack > 90;
  const gaps = tables.map((table, i) => i ? table.y - tables[i - 1].last : 0);
  let names = partial ? null : nameTables(titleLines, gaps);
  // A list without rows (or one off screen) leaves titles the tables cannot account for. The step down to a table
  // still tells whether it opens a yard type: about 96px inside one, about 144px when a new one starts.
  const opens = gaps.map((gap, i) => !i || gap >= 120);
  if (!names && tables.length && titleLines.length >= tables.length + opens.filter(Boolean).length) {
    let next = 0, group = null;
    names = gaps.map((_, i) => { if (opens[i]) group = titleLines[next++]; return { group, name: titleLines[next++] }; });
  }
  return { titleLines, partial, tables: tables.map((table, i) => ({ group: names?.[i].group ?? null, name: names?.[i].name ?? null, columns: table.columns, rows: table.rows })).filter(table => table.rows.length) };
}
function parseServices(nodes) {
  const start = nodes.find(n => n.label.startsWith('DANH SÁCH DỊCH VỤ'));
  if (!start) return [];
  return nodes.filter(n => n.y > start.y - start.h / 2 && n.h < 60).map(n => n.label.match(/^(.{2,80}?) ([\d.]+) ₫(?: \/ (.{1,20}))?$/)).filter(Boolean)
    .map(m => ({ name: m[1].trim(), price: Number(m[2].replace(/\./g, '')), unit: m[3] || null }));
}
function coordinates(url) {
  const decoded = decodeURIComponent(url);
  const m = decoded.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || decoded.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/) || decoded.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

async function openList(context, sport) {
  const page = await context.newPage();
  page.images = [];
  page.on('request', request => { const u = request.url(); if (u.includes('m-files.alobo.vn/branch/')) page.images.push(u); });
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('flt-semantics-placeholder', { state: 'attached', timeout: 180000 });
  await page.evaluate(() => document.querySelector('flt-semantics-placeholder')?.click());
  // First visit shows an onboarding screen; dismiss it whenever it appears, until the home search box is there.
  let home = false;
  for (const end = Date.now() + 180000; Date.now() < end && !home;) {
    const nodes = await read(page);
    const skip = nodes.find(n => n.label === 'Bỏ Qua');
    if (skip) { await page.mouse.click(skip.x, skip.y); await page.waitForTimeout(2000); continue; }
    home = nodes.some(n => n.label === 'Tìm kiếm' && n.h < 100);
    if (!home) await page.waitForTimeout(700);
  }
  await page.waitForTimeout(Number(process.env.HOME_WAIT || 8000)); // the home screen keeps loading (location, nearby list) after it first appears
  if (!home || !await click(page, n => n.label === 'Tìm kiếm' && n.h < 100, 5000, 3000)) throw new Error('search box not found');
  await page.mouse.click(1245, 28); // filter button on the search screen
  if (!(await waitFor(page, n => n.label === 'Môn thể thao', 20000)).length) throw new Error('filter panel did not open');
  await page.waitForTimeout(2500); // let the panel finish sliding in before reading chip positions
  // The sport chips are filled from data the app loads in the background; a panel opened too early stays empty, so reopen it.
  const chip = n => n.role === 'button' && n.label.normalize('NFC') === sport.normalize('NFC') && n.w < 200;
  for (let reopen = 0; reopen < 3 && !(await waitFor(page, chip, 10000)).length; reopen++) {
    await page.mouse.click(808, 28); await page.waitForTimeout(5000); // back arrow closes the panel
    await page.mouse.click(1245, 28);
    await waitFor(page, n => n.label === 'Môn thể thao', 20000); await page.waitForTimeout(2500);
    log('  filter panel reopened', reopen + 1);
  }
  if (!await click(page, chip, 5000)) {
    const stamp = Date.now();
    fs.writeFileSync(path.join(out, `chip-missing-${stamp}.json`), JSON.stringify(await read(page), null, 1));
    await page.screenshot({ path: path.join(out, `chip-missing-${stamp}.png`) }).catch(() => undefined);
    throw new Error('sport chip not found');
  }
  await page.mouse.click(1030, HEIGHT - 34); // "Tìm kiếm" apply button at the bottom of the panel
  await waitFor(page, isCard, 30000);
  await page.waitForTimeout(7000);
  if ((await read(page)).some(n => n.label === 'Môn thể thao')) throw new Error('filter panel is still open');
  return page;
}

async function readVenue(context, page, card, sport) {
  const parts = card.label.match(CARD), address = parts[3], hours = parts[4], distance = parts[2];
  await page.mouse.click(card.x - 60, card.y + 45);
  const link = (await waitFor(page, n => n.label.startsWith(`${ORIGIN}/san/`) && n.x < PANEL, 20000))[0];
  if (!link) throw new Error('side panel did not show the booking link');
  await page.waitForTimeout(1200);
  let nodes = (await read(page)).filter(n => n.x < PANEL && n.w <= PANEL);
  const header = nodes.find(n => n.role === 'group' && n.label.includes(hours) && n.y < 360);
  if (!header || !header.label.includes(address.slice(0, 25))) throw new Error(`panel shows another venue: ${header?.label.slice(0, 60)}`);
  const slug = link.label.slice(`${ORIGIN}/san/`.length).trim();
  const rating = (parts[1].match(/(?:^| )(\d(?:\.\d)?)(?= )/) || [])[1];
  const known = state.venues[slug];
  if (known?.complete) return { slug, reused: true };
  const named = header.lines.length >= 3 && header.lines[2].includes(hours);
  const venue = { slug, name: named ? header.lines[0] : header.label.slice(0, header.label.indexOf(address.slice(0, 25))).trim(), address: named ? header.lines[1] : address, hours, distanceFromCenter: distance,
    rating: /\(\d+ đánh giá\)/.test(header.label) ? Number((header.label.match(/(\d(?:\.\d)?) \(\d+ đánh giá\)/) || [])[1]) || null : null,
    reviewCount: Number((header.label.match(/\((\d+) đánh giá\)/) || [])[1]) || 0, cardRating: rating ? Number(rating) : null,
    sports: nodes.filter(n => n.role === 'img' && n.y < 330 && n.h < 40).map(n => n.label), bookingUrl: link.label };
  // The Map button opens the venue's published location in Google Maps.
  const popup = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
  if (await click(page, n => n.role === 'button' && n.label === 'Map' && n.x < PANEL, 5000, 0)) {
    const map = await popup;
    if (map) {
      for (let i = 0; i < 20 && !coordinates(map.url()); i++) await map.waitForTimeout(500);
      venue.location = coordinates(map.url()); await map.close().catch(() => undefined);
    }
  }
  await page.waitForTimeout(800);
  if (await click(page, n => n.role === 'tab' && n.label === 'Dịch vụ' && n.x < PANEL, 8000, 800)) {
    await waitFor(page, n => (n.label === 'BẢNG GIÁ SÂN' || n.label.startsWith('DANH SÁCH DỊCH VỤ') || /chưa/.test(n.label)) && n.x < PANEL, 8000);
    await page.waitForTimeout(1800);
    nodes = (await read(page)).filter(n => n.x < PANEL && n.w <= PANEL);
    if (process.env.DEBUG_NODES) for (const n of nodes.filter(n => n.y > 380 && n.h < 60)) console.log(`    [${n.role}] (${n.x},${n.y} ${n.w}x${n.h}) ${JSON.stringify(n.lines)}`);
    const prices = parsePrices(nodes);
    if (process.env.DEBUG_NODES) console.log('    tables', JSON.stringify(prices.tables.map(table => [table.group, table.name, table.rows.length])), 'titles', JSON.stringify(prices.titleLines));
    venue.priceTables = prices.tables; venue.priceTitleLines = prices.titleLines; venue.pricesPartial = prices.partial; venue.services = parseServices(nodes);
  }
  if (await click(page, n => n.role === 'tab' && n.label === 'Hình ảnh' && n.x < PANEL, 8000, 3500)) {
    const mine = [...new Set(page.images.filter(u => slugOf(u) === slug))];
    venue.cover = mine.find(u => /\/main\/cover/.test(u)) || null;
    venue.avatar = mine.find(u => /\/main\/avatar/.test(u)) || null;
    venue.yardDiagram = mine.find(u => /\/main\/yardDiagram/.test(u)) || null;
    venue.gallery = mine.filter(u => /\/image\//.test(u)).slice(0, 12);
  }
  if (await click(page, n => n.role === 'tab' && n.label.startsWith('Điều khoản') && n.x < PANEL, 8000, 2500)) {
    nodes = (await read(page)).filter(n => n.x < PANEL && n.w <= PANEL);
    const tabY = nodes.find(n => n.role === 'tab')?.y || 371;
    const lines = nodes.filter(n => n.y > tabY + 40 && !n.role && n.label !== '•' && n.label.length > 3 && n.h < 200);
    const bullets = nodes.filter(n => n.label === '•');
    const body = bullets.length ? lines.filter(n => bullets.some(b => Math.abs(b.y - n.y) <= 14)) : lines;
    venue.rules = body.map(n => n.label).filter(text => !/chưa cập nhật điều khoản|^MỤC LỤC$|^Cập nhật lần cuối/.test(text)).slice(0, 12);
  }
  venue.complete = true; venue.collectedAt = new Date().toISOString();
  state.venues[slug] = venue; save();
  return { slug, venue };
}
async function closePanel(page) {
  for (let i = 0; i < 4 && panelOpen(await read(page)); i++) { await page.mouse.click(1100, 60); await page.waitForTimeout(1500); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', viewport: { width: 1280, height: HEIGHT },
    geolocation: { latitude: LAT, longitude: LNG }, permissions: ['geolocation'] });
  for (const sport of only.length ? only : SPORTS) {
    if (state.bySport[sport]?.done) { log('skip (done)', sport); continue; }
    for (let attempt = 1; attempt <= 4 && !state.bySport[sport]?.done; attempt++) {
      let page;
      try {
        page = await openList(context, sport);
        const cards = (await read(page)).filter(isCard).sort((a, b) => a.y - b.y || a.x - b.x).slice(0, PER_SPORT);
        const entry = state.bySport[sport] = state.bySport[sport] || { slugs: [], labels: {} };
        log(sport, `attempt ${attempt}: ${cards.length} venues to read`);
        for (const card of cards) {
          if (entry.labels[card.label]) continue;
          const started = Date.now();
          try {
            const { slug, venue, reused } = await readVenue(context, page, card, sport);
            entry.labels[card.label] = slug; if (!entry.slugs.includes(slug)) entry.slugs.push(slug);
            save();
            log(' ', `${entry.slugs.length}/${cards.length}`, slug, `${Math.round((Date.now() - started) / 1000)}s`, reused ? '(already collected)'
              : `"${venue.name}" tables=${venue.priceTables?.length ?? '-'} services=${venue.services?.length ?? '-'} rules=${venue.rules?.length ?? '-'} loc=${venue.location ? 'y' : 'n'} imgs=${venue.gallery?.length ?? '-'}`);
          } catch (error) { log('  venue failed:', card.label.slice(0, 50), '-', String(error.message).split('\n')[0].slice(0, 160)); }
          await closePanel(page);
        }
        entry.done = cards.length === 0 || cards.every(card => entry.labels[card.label]);
        entry.listed = cards.length; save();
      } catch (error) { log('FAILED', sport, 'attempt', attempt, String(error.message).split('\n')[0].slice(0, 200)); }
      finally { await page?.close().catch(() => undefined); }
    }
  }
  await browser.close();
  log('finished:', Object.keys(state.venues).length, 'venues;', Object.entries(state.bySport).map(([s, e]) => `${s}=${e.slugs.length}`).join(' '));
})().catch(error => { console.error(error); process.exitCode = 1; });
