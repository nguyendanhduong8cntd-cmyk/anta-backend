'use strict';
// Venue-owner portal (Chủ sân). All data is rendered with textContent/el(); nothing from the API is ever
// parsed as HTML. Every write goes through /api/v1/owner/* — the server re-checks branch ownership on every call.
const API = '/api/v1';
const $ = id => document.getElementById(id);
const store = { get: k => sessionStorage.getItem(k), set: (k, v) => sessionStorage.setItem(k, v), clear: () => sessionStorage.clear() };

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [name, fn] of Object.entries(v)) node.addEventListener(name, fn);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) if (child !== null && child !== undefined) node.append(child);
  return node;
}
async function call(path, method = 'GET', body, retried = false) {
  const response = await fetch(API + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(store.get('access') ? { Authorization: 'Bearer ' + store.get('access') } : {}) } });
  if (response.status === 401 && !retried && store.get('refresh') && !path.startsWith('/public/')) {
    const refreshed = await fetch(API + '/public/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: store.get('refresh') }) });
    if (refreshed.ok) { const tokens = (await refreshed.json()).data; store.set('access', tokens.accessToken); store.set('refresh', tokens.refreshToken); return call(path, method, body, true); }
    signOut(); throw new Error('Phiên đăng nhập đã hết hạn');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ? `${payload.error.code}: ${payload.error.message}` : `HTTP ${response.status}`);
  return payload.data;
}
function notify(message, bad = false) {
  const box = $('notice'); box.textContent = message; box.className = 'notice' + (bad ? ' bad' : ''); box.hidden = !message;
}
const money = v => v === null || v === undefined ? '—' : Number(v).toLocaleString('vi-VN') + ' đ';
const time = v => v ? new Date(v).toLocaleString('vi-VN') : '—';
const hhmm = v => v ? new Date(v).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '—';
const short = v => v ? String(v).slice(0, 8).toUpperCase() : '—';
const dateInput = d => d.toISOString().slice(0, 10);

// Only the statuses the backend actually tracks are labelled; nothing here is invented beyond that model.
const STATUS_LABEL = { PENDING_PAYMENT: 'Chờ thanh toán', PENDING_OWNER_CONFIRMATION: 'Chờ xác nhận',
  CONFIRMED: 'Đã xác nhận', CANCELLED: 'Đã hủy', EXPIRED: 'Hết hạn thanh toán' };
/** CONFIRMED is shown as "Đang chơi"/"Hoàn thành" based on the slot's own time — a display-only reading
 * of the stored status and the booking's start/end time, never a separate stored state. */
function displayStatus(row) {
  if (row.status === 'CONFIRMED') {
    const now = Date.now(), start = Date.parse(row.starts_at), end = Date.parse(row.ends_at);
    if (now >= start && now < end) return { text: 'Đang chơi', cls: 'playing' };
    if (now >= end) return { text: 'Hoàn thành', cls: 'ok' };
  }
  const cls = { PENDING_PAYMENT: 'pending', PENDING_OWNER_CONFIRMATION: 'wait', CONFIRMED: 'ok', CANCELLED: 'bad', EXPIRED: 'bad' }[row.status] || 'pending';
  return { text: STATUS_LABEL[row.status] || row.status, cls };
}
function tag(row) { const s = displayStatus(row); return el('span', { class: 'tag ' + s.cls, text: s.text }); }
function table(columns, rows) {
  if (!rows.length) return el('p', { class: 'muted', text: 'Không có dữ liệu.' });
  const head = el('tr', {}, columns.map(c => el('th', { text: c.title })));
  const body = rows.map(row => el('tr', {}, columns.map(c => {
    const value = c.render(row);
    return el('td', c.wrap ? { class: 'wrap' } : {}, value instanceof Node ? value : document.createTextNode(value ?? '—'));
  })));
  return el('div', { class: 'table-wrap' }, el('table', {}, [el('thead', {}, head), el('tbody', {}, body)]));
}
async function act(button, work, done) {
  button.disabled = true;
  try { const result = await work(); notify(done); return result; }
  catch (error) { notify(error.message, true); throw error; }
  finally { button.disabled = false; }
}
function modal(title, bodyNodes, { confirmText = 'Lưu', onConfirm, danger = false } = {}) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  const error = el('p', { class: 'error' });
  const confirmBtn = el('button', { class: danger ? 'danger' : '', text: confirmText });
  confirmBtn.addEventListener('click', async () => {
    error.textContent = '';
    try { confirmBtn.disabled = true; await onConfirm(); close(); }
    catch (e) { error.textContent = e.message; }
    finally { confirmBtn.disabled = false; }
  });
  backdrop.append(el('div', { class: 'modal' }, [el('h3', { text: title }), ...bodyNodes, error,
    el('div', { class: 'actions' }, [el('button', { class: 'ghost', text: 'Hủy', on: { click: close } }), confirmBtn])]));
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  return { close };
}
function notAvailableYet(what) {
  modal(what, [el('p', { text: `Tính năng "${what}" cần thêm xác nhận nghiệp vụ (mô hình khách vãng lai/thanh toán tại sân) trước khi triển khai. Màn hình đã sẵn sàng về giao diện, API sẽ bổ sung sau.` })],
    { confirmText: 'Đã hiểu', onConfirm: () => {} });
}

// ---- state ----
let branches = [], currentBranch = null, stats = null;
let scheduleState = { date: dateInput(new Date()), sportId: '', courtId: '' };
let bookingState = { page: 1 };

const NAV = { operations: [['stats', 'Thống kê'], ['schedule', 'Lịch sân'], ['bookings', 'Đơn đặt'], ['cancellations', 'Yêu cầu huỷ']],
  facility: [['courts', 'Sân và giá'], ['services', 'Dịch vụ'], ['cashflow', 'Thu chi']] };
const IMPLEMENTED = new Set(['schedule', 'bookings']);
let current = 'schedule';

function renderNav() {
  const build = (items, target) => $(target).replaceChildren(...items.map(([key, label]) => {
    const btn = el('button', {}, [el('span', { text: label })]);
    if (key === 'bookings' && stats?.pendingConfirmation) btn.append(el('span', { class: 'badge', text: String(stats.pendingConfirmation) }));
    btn.toggleAttribute('aria-current', key === current); if (key === current) btn.setAttribute('aria-current', 'page');
    btn.addEventListener('click', () => go(key));
    return btn;
  }));
  build(NAV.operations, 'nav-ops'); build(NAV.facility, 'nav-facility');
}
async function go(view, extra) {
  current = view; renderNav();
  const container = $('view'); container.replaceChildren(el('p', { class: 'muted', text: 'Đang tải…' }));
  if (!IMPLEMENTED.has(view) && view !== 'detail') {
    container.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'muted',
      text: 'Màn hình này chưa thuộc phạm vi triển khai giai đoạn đầu (ưu tiên Lịch sân, Đơn đặt, Chi tiết đơn, Xác nhận/Từ chối đơn).' })));
    return;
  }
  try {
    if (view === 'schedule') await renderSchedule(container);
    else if (view === 'bookings') await renderBookings(container);
    else if (view === 'detail') await renderDetail(container, extra);
  } catch (error) { container.replaceChildren(); notify(error.message, true); }
}
async function refreshStats() {
  if (!currentBranch) return;
  try { stats = await call(`/owner/bookings/stats?branchId=${currentBranch}`); renderNav(); } catch { /* badge is best-effort */ }
}

// ---- Lịch sân ----
async function renderSchedule(container) {
  const data = await call(`/owner/courts/schedule?${new URLSearchParams({ branchId: currentBranch, date: scheduleState.date,
    ...(scheduleState.sportId ? { sportId: scheduleState.sportId } : {}), ...(scheduleState.courtId ? { courtId: scheduleState.courtId } : {}) })}`);
  const wrap = el('div');
  wrap.append(el('div', { class: 'page-head' }, [
    el('div', {}, [el('h2', { text: 'Lịch sân' }),
      el('div', { class: 'sub', text: `${data.branch.name}. Mở cửa ${String(data.branch.openingHour).padStart(2, '0')}:00 đến ${String(data.branch.closingHour).padStart(2, '0')}:00` })]),
    el('div', { class: 'actions' }, [
      el('button', { class: 'ghost', text: '🔒 Khóa khung giờ', on: { click: () => openBlockModal(data) } }),
      el('button', { text: '＋ Tạo đơn tại quầy', on: { click: () => notAvailableYet('Tạo đơn tại quầy') } })])
  ]));

  const dateNav = el('div', { class: 'date-nav' });
  const shift = n => { const d = new Date(scheduleState.date + 'T00:00:00'); d.setDate(d.getDate() + n); scheduleState.date = dateInput(d); go('schedule'); };
  const dateLabel = new Date(scheduleState.date + 'T00:00:00').toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const dateField = el('input', { type: 'date', value: scheduleState.date });
  dateField.addEventListener('change', () => { scheduleState.date = dateField.value; go('schedule'); });
  dateNav.append(
    el('button', { class: 'ghost small', text: '‹ Hôm trước', on: { click: () => shift(-1) } }),
    el('button', { class: 'ghost small', text: 'Hôm nay', on: { click: () => { scheduleState.date = dateInput(new Date()); go('schedule'); } } }),
    el('button', { class: 'ghost small', text: 'Hôm sau ›', on: { click: () => shift(1) } }),
    el('span', { class: 'current-date', text: dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1) }),
    dateField);

  const sports = [...new Map(data.courts.map(c => [c.sport_id, c.sport_name])).entries()];
  const sportTabs = el('div', { class: 'sport-tabs' }, [
    tabButton(`Tất cả ${data.courts.length}`, !scheduleState.sportId, () => { scheduleState.sportId = ''; go('schedule'); }),
    ...sports.map(([id, name]) => tabButton(`${name} ${data.courts.filter(c => c.sport_id === id).length}`,
      scheduleState.sportId === id, () => { scheduleState.sportId = id; go('schedule'); }))]);

  wrap.append(el('div', { class: 'schedule-toolbar' }, [dateNav, sportTabs]));
  wrap.append(renderGrid(data));
  container.replaceChildren(wrap);
}
function tabButton(text, activeNow, onClick) {
  const b = el('button', { text, on: { click: onClick } }); if (activeNow) b.setAttribute('aria-current', 'page'); return b;
}
function renderGrid(data) {
  const opening = data.branch.openingHour, closing = data.branch.closingHour, hourPx = 46;
  const dayStart = new Date(scheduleState.date + 'T00:00:00+07:00'); // display only; positions use each slot's own clock time
  const minutesFromOpening = iso => {
    const d = new Date(iso); const local = new Date(d.toLocaleString('en-US', { timeZone: data.branch.timezone }));
    return (local.getHours() - opening) * 60 + local.getMinutes();
  };
  const timeCol = el('div', { style: 'width:60px;flex:none' }, [el('div', { class: 'corner', style: `height:44px` }),
    ...Array.from({ length: closing - opening }, (_, i) => el('div', { class: 'time-label', style: `height:${hourPx}px;line-height:${hourPx}px`, text: `${String(opening + i).padStart(2, '0')}:00` }))]);
  const columns = [timeCol];
  for (const court of data.courts) {
    const body = el('div', { style: `position:relative;height:${(closing - opening) * hourPx}px` });
    const items = [...data.bookings.filter(b => b.yard_id === court.court_id).map(b => ({ ...b, kind: 'booking' })),
      ...data.blocks.filter(b => b.yard_id === court.court_id).map(b => ({ ...b, kind: 'block' }))];
    for (const item of items) {
      const top = Math.max(0, minutesFromOpening(item.starts_at)) / 60 * hourPx;
      const height = Math.max(20, (minutesFromOpening(item.ends_at) - minutesFromOpening(item.starts_at)) / 60 * hourPx - 2);
      const cls = item.kind === 'block' ? 'locked' : { PENDING_PAYMENT: 'pending', PENDING_OWNER_CONFIRMATION: 'wait', CONFIRMED: 'confirmed' }[item.status] || 'pending';
      const card = el('div', { class: 'booking-card ' + cls, style: `top:${top}px;height:${height}px` }, [
        el('b', { text: item.kind === 'block' ? '🔒 Đã khóa' : (item.customer_name || item.customer_contact) }),
        el('span', { text: `${hhmm(item.starts_at)}–${hhmm(item.ends_at)}` })]);
      card.addEventListener('click', () => item.kind === 'block' ? confirmReleaseBlock(item) : go('detail', { id: item.id }));
      body.append(card);
    }
    columns.push(el('div', { style: 'flex:1;min-width:150px;border-left:1px solid var(--line)' },
      [el('div', { class: 'court-head', text: court.name }, [el('span', { class: 'sport', text: court.sport_name })]), body]));
  }
  const grid = el('div', { class: 'schedule-grid', style: 'display:flex' }, columns);
  const legend = el('div', { class: 'legend' }, [
    legendItem('var(--orange)', 'Chờ xác nhận / Chờ thanh toán'), legendItem('var(--green)', 'Đã xác nhận'), legendItem('var(--muted)', 'Đã khóa')]);
  return el('div', { class: 'schedule-grid-wrap' }, [grid, legend]);
}
function legendItem(color, text) { return el('span', {}, [el('i', { style: `background:${color}` }), text]); }

function openBlockModal(data) {
  const courtSel = el('select', {}, data.courts.map(c => el('option', { value: c.court_id, text: c.name })));
  if (scheduleState.courtId) courtSel.value = scheduleState.courtId;
  const dateF = el('input', { type: 'date', value: scheduleState.date });
  const startF = el('input', { type: 'time', value: '10:00' }), endF = el('input', { type: 'time', value: '12:00' });
  const reasonF = el('textarea', { rows: 3, placeholder: 'Ví dụ: bảo trì đèn, thay thảm sân' });
  modal('Khóa khung giờ', [
    el('label', {}, ['Sân cần khóa', courtSel]), el('label', {}, ['Ngày', dateF]),
    el('div', { style: 'display:flex;gap:10px' }, [el('label', { style: 'flex:1' }, ['Giờ bắt đầu', startF]), el('label', { style: 'flex:1' }, ['Giờ kết thúc', endF])]),
    el('label', {}, ['Lý do khóa', reasonF])
  ], { confirmText: 'Khóa khung giờ', onConfirm: async () => {
    const startsAt = toOffsetIso(dateF.value, startF.value), endsAt = toOffsetIso(dateF.value, endF.value);
    await call(`/owner/courts/${courtSel.value}/blocks`, 'POST', { startsAt, endsAt, reason: reasonF.value.trim() || 'Bảo trì sân' });
    notify('Đã khóa khung giờ.'); await go('schedule');
  } });
}
function toOffsetIso(date, hhmmValue) { return `${date}T${hhmmValue}:00+07:00`; }
function confirmReleaseBlock(block) {
  modal('Mở khóa khung giờ', [el('p', {}, [`Mở lại khung giờ ${hhmm(block.starts_at)}–${hhmm(block.ends_at)}?`]),
    el('p', { class: 'muted', text: block.reason })], { confirmText: 'Mở khóa', danger: true, onConfirm: async () => {
    await call(`/owner/blocks/${block.id}`, 'DELETE'); notify('Đã mở khóa khung giờ.'); await go('schedule');
  } });
}

// ---- Đơn đặt ----
async function renderBookings(container) {
  const [s, list] = await Promise.all([
    call(`/owner/bookings/stats?branchId=${currentBranch}`),
    call(`/owner/bookings?${new URLSearchParams({ branchId: currentBranch, page: String(bookingState.page || 1),
      ...(bookingState.q ? { q: bookingState.q } : {}), ...(bookingState.fromDate ? { fromDate: bookingState.fromDate } : {}),
      ...(bookingState.toDate ? { toDate: bookingState.toDate } : {}), ...(bookingState.status ? { status: bookingState.status } : {}),
      ...(bookingState.source ? { source: bookingState.source } : {}) })}`)]);
  stats = s; renderNav();
  const wrap = el('div');
  wrap.append(el('div', { class: 'page-head' }, [
    el('div', {}, [el('h2', { text: 'Đơn đặt' }), el('div', { class: 'sub', text: 'Mọi đơn của cơ sở, từ app Anta và tại quầy' })]),
    el('button', { text: '＋ Tạo đơn tại quầy', on: { click: () => notAvailableYet('Tạo đơn tại quầy') } })]));
  wrap.append(el('div', { class: 'stats' }, [
    statCard(s.pendingConfirmation, 'Chờ xác nhận'), statCard(s.today, 'Hôm nay'), statCard(s.upcoming, 'Sắp tới'), statCard(s.cancelledThisWeek, 'Đã hủy tuần này')]));

  const q = el('input', { placeholder: 'Tìm tên, số điện thoại hoặc mã đơn', value: bookingState.q || '' });
  const from = el('input', { type: 'date', value: bookingState.fromDate || '' }), to = el('input', { type: 'date', value: bookingState.toDate || '' });
  const status = selectEl({ '': 'Mọi trạng thái', PENDING_PAYMENT: 'Chờ thanh toán', PENDING_OWNER_CONFIRMATION: 'Chờ xác nhận',
    CONFIRMED: 'Đã xác nhận', CANCELLED: 'Đã hủy', EXPIRED: 'Hết hạn' }, bookingState.status || '');
  const source = selectEl({ '': 'Mọi nguồn', APP: 'App Anta', COUNTER: 'Tại quầy' }, bookingState.source || '');
  const apply = () => { Object.assign(bookingState, { q: q.value.trim(), fromDate: from.value, toDate: to.value, status: status.value, source: source.value, page: 1 }); go('bookings'); };
  const form = el('form', { class: 'toolbar', on: { submit: e => { e.preventDefault(); apply(); } } },
    [el('label', {}, ['Tìm kiếm', q]), el('label', {}, ['Từ ngày', from]), el('label', {}, ['Đến ngày', to]),
      el('label', {}, ['Trạng thái', status]), el('label', {}, ['Nguồn đặt', source]), el('button', { type: 'submit', text: 'Lọc' }),
      el('button', { type: 'button', class: 'ghost', text: 'Xóa lọc', on: { click: () => { bookingState = { page: 1 }; go('bookings'); } } })]);
  wrap.append(form);

  wrap.append(table([
    { title: 'Mã đơn', render: r => short(r.id) }, { title: 'Khách hàng', wrap: true, render: r => el('div', {}, [el('div', { text: r.customer_name }), el('div', { class: 'muted', text: r.customer_contact })]) },
    { title: 'Sân', render: r => r.yard_name }, { title: 'Ngày chơi', render: r => new Date(r.starts_at).toLocaleDateString('vi-VN') },
    { title: 'Giờ chơi', render: r => `${hhmm(r.starts_at)}–${hhmm(r.ends_at)}` }, { title: 'Tổng tiền', render: r => money(r.amount) },
    { title: 'Nguồn', render: r => r.source === 'COUNTER' ? 'Tại quầy' : 'App Anta' }, { title: 'Trạng thái', render: r => tag(r) },
    { title: '', render: r => { const b = el('button', { class: 'small ghost', text: 'Xem' }); b.addEventListener('click', () => go('detail', { id: r.id })); return b; } }
  ], list.items));

  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  if (pages > 1) wrap.append(el('div', { class: 'actions', style: 'margin-top:10px' }, [
    el('button', { class: 'ghost small', text: '‹ Trước', disabled: list.page <= 1 ? 'disabled' : null, on: { click: () => { bookingState.page = list.page - 1; go('bookings'); } } }),
    el('span', { class: 'muted', text: `Trang ${list.page}/${pages}` }),
    el('button', { class: 'ghost small', text: 'Sau ›', disabled: list.page >= pages ? 'disabled' : null, on: { click: () => { bookingState.page = list.page + 1; go('bookings'); } } })]));
  container.replaceChildren(wrap);
}
function statCard(value, label) { return el('div', { class: 'card stat' }, [el('b', { text: String(value) }), el('span', { text: label })]); }
function selectEl(options, value) { const s = el('select', {}, Object.entries(options).map(([v, t]) => el('option', { value: v, text: t }))); s.value = value; return s; }

// ---- Chi tiết đơn ----
async function renderDetail(container, extra) {
  const row = await call(`/owner/bookings/${extra.id}`);
  const wrap = el('div');
  wrap.append(el('div', { class: 'page-head' }, [
    el('div', {}, [el('h2', { text: `Đơn ${short(row.id)}` }), el('div', { class: 'sub', text: `Khách đặt lúc ${time(row.created_at)} từ ${row.source === 'COUNTER' ? 'tại quầy' : 'app Anta'}` })]),
    el('button', { class: 'ghost', text: '← Danh sách đơn', on: { click: () => go('bookings') } })]));

  const grid = el('div', { class: 'detail-grid' });
  const left = el('div');
  left.append(el('div', { class: 'card' }, [el('h3', { text: 'Thông tin đặt sân' }),
    el('dl', { class: 'rows' }, [
      dRow('Sân', `${row.yard_name}, ${row.sport_name}`), dRow('Ngày chơi', new Date(row.starts_at).toLocaleDateString('vi-VN')),
      dRow('Giờ chơi', `${hhmm(row.starts_at)} đến ${hhmm(row.ends_at)}, ${row.hours} giờ`), dRow('Giá sân theo giờ', money(row.hourly_price)),
      dRow('Nguồn đặt', row.source === 'COUNTER' ? 'Tại quầy' : 'App Anta')])]));
  left.append(el('div', { class: 'card' }, [el('h3', { text: 'Khách hàng' }),
    el('dl', { class: 'rows' }, [dRow('Tên khách', row.customer_name), dRow('Liên hệ', row.customer_contact)])]));
  left.append(costCard(row));
  if (row.statusHistory?.length) left.append(el('div', { class: 'card' }, [el('h3', { text: 'Lịch sử thao tác' }),
    el('ul', { style: 'margin:0;padding-left:18px' }, row.statusHistory.map(h => el('li', { text: `${time(h.created_at)}: ${h.from_status || '—'} → ${h.to_status}${h.reason ? ' (' + h.reason + ')' : ''}` })))]));

  const right = el('div');
  right.append(statusCard(row));
  grid.append(left, right);
  wrap.append(grid);
  container.replaceChildren(wrap);
}
function dRow(label, value) { return [el('dt', { text: label }), el('dd', { text: value ?? '—' })]; }
function costCard(row) {
  const rows = [['Tiền sân', `${row.yard_name}, ${row.hours} giờ`, money(row.hourly_price), money(row.courtAmount)],
    ...row.services.map(s => ['Dịch vụ: ' + s.name, `${s.quantity} x`, money(s.unit_price), money(s.subtotal)])];
  const t = el('table', { class: 'cost-table' }, [
    el('thead', {}, el('tr', {}, ['Khoản mục', 'Số lượng', 'Đơn giá', 'Thành tiền'].map(h => el('th', { text: h })))),
    el('tbody', {}, rows.map(r => el('tr', {}, r.map(v => el('td', { text: v })))))]);
  return el('div', { class: 'card' }, [el('h3', { text: 'Dịch vụ kèm theo và thanh toán' }), t,
    el('dl', { class: 'rows', style: 'margin-top:10px' }, [
      dRow('Tổng cộng', money(row.amount)), dRow('Đã thanh toán', money(row.paidAmount)), dRow('Còn phải thu tại sân', money(row.outstanding))])]);
}
function statusCard(row) {
  const s = displayStatus(row);
  const card = el('div', { class: 'card' }, [el('h3', { text: 'Trạng thái' }), el('div', { style: 'margin-bottom:10px' }, tag(row))]);
  if (row.status === 'PENDING_OWNER_CONFIRMATION') {
    const note = el('p', {}, ['Khách đã thanh toán. ', row.canConfirm
      ? el('span', { class: 'countdown', text: `Còn ${remaining(row.confirm_deadline_at)} để xác nhận.` })
      : el('span', { class: 'tag bad', text: 'Đã quá hạn xác nhận' })]);
    card.append(note);
    const confirmBtn = el('button', { text: '✓ Xác nhận đơn', disabled: row.canConfirm ? null : 'disabled' });
    confirmBtn.addEventListener('click', () => act(confirmBtn, () => call(`/owner/bookings/${row.id}/confirm`, 'POST'), 'Đã xác nhận đơn.').then(() => go('detail', { id: row.id })).catch(() => {}));
    const rejectBtn = el('button', { class: 'danger', text: 'Từ chối đơn' });
    rejectBtn.addEventListener('click', () => openRejectModal(row));
    card.append(el('div', { class: 'actions' }, [confirmBtn, rejectBtn]),
      el('p', { class: 'muted', style: 'margin-top:8px', text: 'Từ chối thì phải ghi lý do. Khách nhận lại toàn bộ số tiền đã trả.' }));
  } else if (row.refund) {
    card.append(el('p', {}, [`Hoàn tiền: ${money(row.refund.amount)} (${row.refund.percent}%) — `, el('span', { class: 'tag ' + (row.refund.status === 'SUCCEEDED' ? 'ok' : 'pending'), text: row.refund.status }),
      row.refund.reason ? el('div', { class: 'muted', text: row.refund.reason }) : null]));
  } else {
    card.append(el('p', { class: 'muted', text: 'Không còn thao tác nào khả dụng cho trạng thái này.' }));
  }
  return card;
}
function remaining(deadline) {
  const ms = Date.parse(deadline) - Date.now(); if (ms <= 0) return '0 phút';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h} giờ ${m} phút` : `${m} phút`;
}
function openRejectModal(row) {
  const reasonF = el('textarea', { rows: 3, placeholder: 'Ví dụ: sân đang bảo trì đột xuất, trùng lịch do lỗi hệ thống…' });
  modal('Từ chối đơn', [el('p', {}, [`Đơn ${short(row.id)} của ${row.customer_name}. Khách sẽ được hoàn lại toàn bộ ${money(row.amount)}.`]),
    el('label', {}, ['Lý do từ chối (bắt buộc)', reasonF])], { confirmText: 'Từ chối đơn và hoàn tiền', danger: true, onConfirm: async () => {
    const reason = reasonF.value.trim();
    if (!reason) throw new Error('Vui lòng nhập lý do từ chối.');
    await call(`/owner/bookings/${row.id}/reject`, 'POST', { reason });
    notify('Đã từ chối đơn và hoàn tiền cho khách.'); await go('detail', { id: row.id });
  } });
}

// ---- shell ----
function signOut() { store.clear(); $('app').hidden = true; $('login').hidden = false; }
async function start() {
  try {
    const me = await call('/users/me');
    branches = await call('/owner/branches');
    if (!branches.length) throw new Error('Tài khoản này chưa được cấp quyền quản lý cơ sở nào.');
    currentBranch = store.get('branch') && branches.some(b => b.id === store.get('branch')) ? store.get('branch') : branches[0].id;
    $('branch-select').replaceChildren(...branches.map(b => el('option', { value: b.id, text: b.name })));
    $('branch-select').value = currentBranch;
    $('branch-select').addEventListener('change', () => { currentBranch = $('branch-select').value; store.set('branch', currentBranch); go(current); refreshStats(); });
    $('who-name').textContent = me.identifier;
    $('login').hidden = true; $('app').hidden = false; notify('');
    await refreshStats(); await go('schedule');
  } catch (error) { signOut(); $('login-error').textContent = store.get('tried') ? error.message : ''; }
}
$('logout').addEventListener('click', async () => { try { await call('/auth/logout', 'POST'); } catch { /* session already gone */ } signOut(); });
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-error').textContent = '';
  const form = new FormData(event.target);
  try {
    const tokens = await call('/public/auth/login', 'POST', { identifier: form.get('identifier'), password: form.get('password'), deviceId: 'owner-portal' });
    store.set('access', tokens.accessToken); store.set('refresh', tokens.refreshToken); store.set('tried', '1'); event.target.reset();
    await start();
  } catch (error) { $('login-error').textContent = error.message; }
});
if (store.get('access')) start(); else $('login').hidden = false;
