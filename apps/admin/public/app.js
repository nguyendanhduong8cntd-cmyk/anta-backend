'use strict';
// Admin portal. All data is rendered with textContent; nothing from the API is ever parsed as HTML.
const API = '/api/v1';
const $ = id => document.getElementById(id);
const store = { get: key => sessionStorage.getItem(key), set: (key, value) => sessionStorage.setItem(key, value), clear: () => sessionStorage.clear() };
let branches = [];

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value; else if (key === 'on') for (const [name, fn] of Object.entries(value)) node.addEventListener(name, fn);
    else if (key === 'text') node.textContent = value; else node.setAttribute(key, value);
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
const money = value => Number(value).toLocaleString('vi-VN') + ' ₫';
const time = value => value ? new Date(value).toLocaleString('vi-VN') : '—';
const short = value => value ? String(value).slice(0, 8) : '—';
function tag(status) {
  const ok = ['ACTIVE', 'CONFIRMED', 'SUCCEEDED'], bad = ['FAILED', 'CANCELLED', 'DELETED', 'DISABLED', 'EXPIRED'];
  return el('span', { class: 'tag ' + (ok.includes(status) ? 'ok' : bad.includes(status) ? 'bad' : 'warn'), text: status || '—' });
}
function table(columns, rows) {
  if (!rows.length) return el('p', { class: 'muted', text: 'Không có dữ liệu.' });
  const head = el('tr', {}, columns.map(column => el('th', { text: column.title })));
  const body = rows.map(row => el('tr', {}, columns.map(column => {
    const value = column.render(row);
    return el('td', column.wrap ? { class: 'wrap' } : {}, value instanceof Node ? value : document.createTextNode(value ?? '—'));
  })));
  return el('div', { class: 'table-wrap' }, el('table', {}, [el('thead', {}, head), el('tbody', {}, body)]));
}
function filter(label, options, onChange) {
  const select = el('select', { on: { change: () => onChange(select.value) } }, options.map(([value, text]) => el('option', { value, text })));
  return el('label', {}, [label, select]);
}
async function act(button, work, done) {
  button.disabled = true;
  try { await work(); notify(done); await show(current); } catch (error) { notify(error.message, true); button.disabled = false; }
}

const views = {
  async overview(view) {
    const s = await call('/admin/stats');
    const items = [['Người dùng đang hoạt động', `${s.users.active} / ${s.users.total}`], ['Đặt sân đã xác nhận', s.bookings.confirmed],
      ['Đặt sân chờ thanh toán', s.bookings.pending], ['Đặt sân đã hủy', s.bookings.cancelled], ['Giao dịch thành công', s.payments.count],
      ['Tổng tiền đã thu', money(s.payments.paid)], ['Đã hoàn tiền', money(s.payments.refunded)], ['Hoàn tiền cần xử lý', s.openRefunds],
      ['Tiền đến muộn cần duyệt', s.latePaymentsToReview], ['Yêu cầu xóa tài khoản đang chờ', s.pendingDeletions]];
    view.append(el('div', { class: 'stats' }, items.map(([label, value]) => el('div', { class: 'card stat' }, [el('b', { text: String(value) }), el('span', { text: label })]))));
  },
  async users(view, toolbar, state) {
    const input = el('input', { placeholder: 'Email, SĐT, tên hoặc ID', value: state.q || '' });
    toolbar.append(el('form', { class: 'toolbar', on: { submit: event => { event.preventDefault(); show('users', { q: input.value.trim() }); } } },
      [el('label', {}, ['Tìm kiếm', input]), el('button', { type: 'submit', text: 'Tìm' })]));
    const rows = await call('/admin/users' + (state.q ? '?q=' + encodeURIComponent(state.q) : ''));
    view.append(table([
      { title: 'Tài khoản', render: r => r.identifier }, { title: 'Tên', render: r => r.display_name }, { title: 'Trạng thái', render: r => tag(r.status) },
      { title: 'Quyền', wrap: true, render: r => el('div', { class: 'actions' }, r.roles.map(role => {
        const branch = branches.find(b => b.id === role.branchId);
        const button = el('button', { class: 'small danger', title: 'Thu hồi quyền', text: `${role.role}${branch ? ' · ' + branch.name : ''} ✕` });
        button.addEventListener('click', () => confirm(`Thu hồi quyền ${role.role} của ${r.identifier}?`)
          && act(button, () => call('/admin/roles', 'DELETE', { userId: r.id, role: role.role, ...(role.branchId ? { branchId: role.branchId } : {}) }), 'Đã thu hồi quyền.'));
        return button;
      })) },
      { title: 'Cấp quyền', render: r => {
        if (r.status !== 'ACTIVE') return '—';
        const role = el('select', {}, ['admin', 'support', 'branch_owner', 'branch_staff'].map(name => el('option', { value: name, text: name })));
        const branch = el('select', {}, [el('option', { value: '', text: '(toàn hệ thống)' }), ...branches.map(b => el('option', { value: b.id, text: b.name }))]);
        const button = el('button', { class: 'small', text: 'Cấp' });
        button.addEventListener('click', () => act(button, () => call('/admin/roles', 'POST',
          { userId: r.id, role: role.value, ...(branch.value ? { branchId: branch.value } : {}) }), 'Đã cấp quyền.'));
        return el('div', { class: 'actions' }, [role, branch, button]);
      } },
      { title: 'Tạo lúc', render: r => time(r.created_at) }], rows));
  },
  async bookings(view, toolbar, state) {
    toolbar.append(filter('Trạng thái', [['', 'Tất cả'], ['PENDING_PAYMENT', 'Chờ thanh toán'], ['CONFIRMED', 'Đã xác nhận'], ['CANCELLED', 'Đã hủy'], ['EXPIRED', 'Hết hạn']],
      status => show('bookings', { status })));
    toolbar.querySelector('select').value = state.status || '';
    const rows = await call('/admin/bookings' + (state.status ? '?status=' + state.status : ''));
    view.append(table([{ title: 'Mã', render: r => short(r.id) }, { title: 'Khách', render: r => r.identifier }, { title: 'Chi nhánh', render: r => r.branch },
      { title: 'Sân', render: r => r.yard }, { title: 'Bắt đầu', render: r => time(r.starts_at) }, { title: 'Kết thúc', render: r => time(r.ends_at) },
      { title: 'Số tiền', render: r => money(r.amount) }, { title: 'Trạng thái', render: r => tag(r.status) }, { title: 'Tạo lúc', render: r => time(r.created_at) }], rows));
  },
  async payments(view, toolbar, state) {
    toolbar.append(filter('Trạng thái', [['', 'Tất cả'], ['NEEDS_REVIEW', 'Tiền đến muộn'], ['SUCCEEDED', 'Thành công'], ['CREATED', 'Đang chờ'], ['EXPIRED', 'Hết hạn']],
      status => show('payments', { status })));
    toolbar.querySelector('select').value = state.status || '';
    const rows = await call('/admin/payment-intents' + (state.status ? '?status=' + state.status : ''));
    view.append(table([{ title: 'Mã đơn', render: r => r.order_code || short(r.id) }, { title: 'Khách', render: r => r.identifier }, { title: 'Cổng', render: r => r.provider },
      { title: 'Loại', render: r => r.target }, { title: 'Số tiền', render: r => money(r.amount) }, { title: 'Trạng thái', render: r => tag(r.status) },
      { title: 'Hoàn tiền', render: r => {
        if (r.refund_status) return tag(r.refund_status);
        if (r.status !== 'NEEDS_REVIEW') return '—';
        const button = el('button', { class: 'small', text: 'Hoàn 100%' });
        button.addEventListener('click', () => confirm(`Hoàn ${money(r.amount)} cho ${r.identifier}?`)
          && act(button, () => call(`/admin/payment-intents/${r.id}/refund`, 'POST'), 'Đã tạo lệnh hoàn tiền.'));
        return button;
      } }, { title: 'Cập nhật', render: r => time(r.updated_at) }], rows));
  },
  async refunds(view, toolbar, state) {
    toolbar.append(filter('Trạng thái', [['', 'Tất cả'], ['MANUAL_REVIEW', 'Cần chuyển tay'], ['PENDING', 'Đang gửi cổng'], ['FAILED', 'Thất bại'], ['SUCCEEDED', 'Đã hoàn']],
      status => show('refunds', { status })));
    toolbar.querySelector('select').value = state.status || '';
    const rows = await call('/admin/refunds' + (state.status ? '?status=' + state.status : ''));
    view.append(table([{ title: 'Mã', render: r => short(r.id) }, { title: 'Mã đơn', render: r => r.order_code || '—' }, { title: 'Cổng', render: r => r.provider },
      { title: 'Số tiền', render: r => `${money(r.amount)} (${r.percent}%)` }, { title: 'Lý do', wrap: true, render: r => r.reason },
      { title: 'Trạng thái', render: r => tag(r.status) }, { title: 'Mã tham chiếu', render: r => r.provider_ref || '—' },
      { title: 'Xử lý', render: r => {
        if (r.status === 'SUCCEEDED') return '—';
        const done = el('button', { class: 'small', text: 'Đã chuyển tiền' }), fail = el('button', { class: 'small danger', text: 'Thất bại' });
        done.addEventListener('click', () => { const ref = prompt('Mã giao dịch chuyển khoản hoàn tiền:'); if (ref) act(done,
          () => call(`/admin/refunds/${r.id}/resolve`, 'POST', { outcome: 'SUCCEEDED', providerRef: ref.trim() }), 'Đã ghi nhận hoàn tiền.'); });
        fail.addEventListener('click', () => confirm('Đánh dấu hoàn tiền thất bại?')
          && act(fail, () => call(`/admin/refunds/${r.id}/resolve`, 'POST', { outcome: 'FAILED' }), 'Đã đánh dấu thất bại.'));
        return el('div', { class: 'actions' }, r.status === 'FAILED' ? [done] : [done, fail]);
      } }, { title: 'Tạo lúc', render: r => time(r.created_at) }], rows));
  },
  async deletions(view) {
    const rows = await call('/admin/deletion-requests');
    view.append(table([{ title: 'Người dùng', render: r => short(r.user_id) }, { title: 'Trạng thái', render: r => tag(r.status) },
      { title: 'Yêu cầu lúc', render: r => time(r.requested_at) }, { title: 'Xóa dữ liệu sau', render: r => time(r.purge_after) },
      { title: 'Đã xóa lúc', render: r => time(r.completed_at) },
      { title: 'Đã xóa', wrap: true, render: r => r.purge_summary ? Object.entries(r.purge_summary).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(', ') || 'không có dữ liệu' : '—' }], rows));
  },
  async audit(view) {
    const rows = await call('/admin/audit-events');
    view.append(table([{ title: '#', render: r => String(r.id) }, { title: 'Thời gian', render: r => time(r.created_at) }, { title: 'Người thực hiện', render: r => short(r.actor_id) },
      { title: 'Hành động', render: r => r.action }, { title: 'Đối tượng', render: r => `${r.target_type} ${short(r.target_id)}` },
      { title: 'Chi tiết', wrap: true, render: r => JSON.stringify(r.details) }], rows));
  }
};
const titles = { overview: 'Tổng quan', users: 'Người dùng', bookings: 'Đặt sân', payments: 'Thanh toán', refunds: 'Hoàn tiền', deletions: 'Xóa tài khoản', audit: 'Nhật ký' };
let current = 'overview', currentState = {};
async function show(name, state) {
  current = name; currentState = state || (name === current ? currentState : {});
  for (const button of $('tabs').children) button.toggleAttribute('aria-current', false), button.dataset.view === name && button.setAttribute('aria-current', 'page');
  const view = $('view'), toolbar = $('toolbar'); view.replaceChildren(el('p', { class: 'muted', text: 'Đang tải…' })); toolbar.replaceChildren();
  try { const fresh = document.createDocumentFragment(); await views[name](fresh, toolbar, currentState); view.replaceChildren(fresh); }
  catch (error) { view.replaceChildren(); notify(error.message, true); }
}
function signOut() { store.clear(); $('app').hidden = true; $('login').hidden = false; }
async function start() {
  try {
    const me = await call('/users/me');
    branches = await call('/admin/branches'); // 403 here means the account is not an administrator
    $('who').textContent = me.identifier; $('login').hidden = true; $('app').hidden = false; notify('');
    await show('overview', {});
  } catch (error) { signOut(); $('login-error').textContent = store.get('tried') ? error.message : ''; }
}
$('tabs').append(...Object.entries(titles).map(([name, title]) => el('button', { 'data-view': name, text: title, on: { click: () => { notify(''); show(name, {}); } } })));
$('logout').addEventListener('click', async () => { try { await call('/auth/logout', 'POST'); } catch { /* session already gone */ } signOut(); });
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-error').textContent = '';
  const form = new FormData(event.target);
  try {
    const tokens = await call('/public/auth/login', 'POST', { identifier: form.get('identifier'), password: form.get('password'), deviceId: 'admin-portal' });
    store.set('access', tokens.accessToken); store.set('refresh', tokens.refreshToken); store.set('tried', '1'); event.target.reset();
    await start();
    if ($('app').hidden) $('login-error').textContent = 'Tài khoản này không có quyền quản trị.';
  } catch (error) { $('login-error').textContent = error.message; }
});
if (store.get('access')) start(); else $('login').hidden = false;
