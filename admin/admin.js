// Cloud Trails — admin panel (served by the Worker at /admin/).
import { inr, parseLocal } from '../js/pricing.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
let ME = null;

const STATUS_LABEL = { pending: 'Pending', confirmed: 'Confirmed', ongoing: 'On the road', completed: 'Completed', cancelled: 'Cancelled', rejected: 'Rejected' };
const PAY_LABEL = { none: 'Pay at handover', awaiting: 'Not paid', submitted: 'To verify', verified: 'Paid', mismatch: 'Mismatch', refunded: 'Refunded' };
const DOCS_LABEL = { submitted: 'To verify', verified: 'Verified', reupload: 'Re-upload asked' };

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
  const init = { credentials: 'same-origin', headers: {} };
  if (opts.method && opts.method !== 'GET') {
    init.method = opts.method;
    init.headers['x-ct-admin'] = '1';
    if (opts.form) init.body = opts.form;
    else { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body || {}); }
  }
  const r = await fetch('/admin/api' + path, init);
  if (r.status === 401) { showLogin(); throw new Error('Please sign in.'); }
  const ct = r.headers.get('content-type') || '';
  const j = ct.includes('json') ? await r.json() : {};
  if (!r.ok) throw new Error(j.error || 'Request failed (' + r.status + ')');
  return j;
}
const post = (path, body) => api(path, { method: 'POST', body });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------- formatting ---------------- */
function when(s, opts = {}) {
  const t = parseLocal(s);
  if (!isFinite(t)) return s || '—';
  const d = new Date(t);
  const date = d.toLocaleDateString('en-IN', { weekday: opts.noDay ? undefined : 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  return opts.time === false ? date : `${date}, ${time}`;
}
function timeOnly(s) { const t = parseLocal(s); return isFinite(t) ? new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) : ''; }
function stamp(iso) { return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }); }
const pill = (cls, label) => `<span class="pill ${esc(cls)}">${esc(label)}</span>`;
const st = (s) => pill(s, STATUS_LABEL[s] || s);
const pay = (s) => pill(s, PAY_LABEL[s] || s);
const docs = (s) => pill(s, DOCS_LABEL[s] || s);
function phoneDigits(p) { return String(p || '').replace(/\D/g, ''); }
function mapLink(addr) { return `https://maps.google.com/?q=${encodeURIComponent(addr + ', Shillong')}`; }
function age(dob) {
  if (!dob) return '';
  const t = new Date().toISOString().slice(0, 10);
  return Number(t.slice(0, 4)) - Number(dob.slice(0, 4)) - (t.slice(5) < dob.slice(5) ? 1 : 0);
}
function today() { return ME?.today || new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10); }

/* ---------------- modal ---------------- */
function modal({ title, body, ok = 'Save', okClass = 'primary', onOk }) {
  const m = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-err').textContent = '';
  const okBtn = $('#modal-ok');
  okBtn.textContent = ok; okBtn.className = 'btn ' + okClass; okBtn.disabled = false;
  m.hidden = false;
  const first = $('#modal-body input, #modal-body textarea, #modal-body select');
  if (first) setTimeout(() => first.focus(), 30);
  const close = () => { m.hidden = true; okBtn.onclick = null; };
  $('#modal-cancel').onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };
  okBtn.onclick = async () => {
    okBtn.disabled = true;
    try { await onOk($('#modal-body')); close(); } catch (e) { $('#modal-err').textContent = e.message; okBtn.disabled = false; }
  };
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#modal').hidden = true; $('#lightbox').hidden = true; }
});
$('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });

/* ---------------- auth ---------------- */
function showLogin(note) {
  $('#shell').hidden = true;
  $('#login').hidden = false;
  if (note) $('#login-note').textContent = note;
  setTimeout(() => $('#pw').focus(), 30);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    const r = await fetch('/admin/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Could not sign in.');
    $('#pw').value = '';
    start();
  } catch (err) { $('#login-err').textContent = err.message; }
});

$('#logout').addEventListener('click', async () => {
  await fetch('/admin/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-ct-admin': '1' } });
  showLogin('Signed out.');
});

async function start() {
  const r = await fetch('/admin/api/me', { credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (r.status === 503) return showLogin(j.error || 'Admin is not set up yet.');
  if (!r.ok) return showLogin();
  ME = j;
  $('#login').hidden = true;
  $('#shell').hidden = false;
  route();
}

/* ---------------- router ---------------- */
window.addEventListener('hashchange', route);
async function route() {
  if (!ME) return;
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  const q = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  const nav = { '': 'dash', bookings: 'bookings', booking: 'bookings', schedule: 'schedule', calendar: 'calendar', fleet: 'fleet', settings: 'settings', print: 'bookings' }[parts[0] || ''];
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
  view.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (!parts.length) await dashboard();
    else if (parts[0] === 'bookings') await bookings(q);
    else if (parts[0] === 'booking') await detail(parts[1]);
    else if (parts[0] === 'print') await printView(parts[1]);
    else if (parts[0] === 'schedule') await schedule(q);
    else if (parts[0] === 'calendar') await calendar(q);
    else if (parts[0] === 'fleet') await fleet();
    else if (parts[0] === 'settings') await settings();
    else view.innerHTML = '<p>Not found.</p>';
  } catch (e) {
    view.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`;
  }
  refreshBadge();
}

async function refreshBadge() {
  try {
    const s = await api('/stats');
    const n = s.pending;
    $('#nav-pending').hidden = !n;
    $('#nav-pending').textContent = n;
  } catch {}
}

/* ---------------- dashboard ---------------- */
async function dashboard() {
  const [s, pend, sch] = await Promise.all([
    api('/stats'),
    api('/bookings?status=pending&sort=start'),
    api('/schedule?date=' + today()),
  ]);
  const tile = (label, n, href, cls = '') => `<a class="stat ${n && cls ? cls : ''}" href="${href}"><span>${label}</span><b>${n}</b></a>`;
  view.innerHTML = `
    <div class="head"><div><h1>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}</h1>
      <p class="sub">${esc(when(today() + 'T00:00', { time: false }))} · ${s.next_7_days} booking${s.next_7_days === 1 ? '' : 's'} starting in the next 7 days</p></div>
      <div class="head-actions"><a class="btn" href="#/schedule">Today's schedule</a><a class="btn primary" href="#/bookings?status=pending">Review pending</a></div></div>
    <div class="stats">
      ${tile('Waiting for review', s.pending, '#/bookings?status=pending', 'hot')}
      ${tile('Payments to verify', s.payment_check, '#/bookings?payment=submitted', 'hot')}
      ${tile('Documents to verify', s.docs_check, '#/bookings?docs=submitted', 'hot')}
      ${tile('Overdue returns', s.overdue, '#/schedule', 'alarm')}
      ${tile('Handovers today', s.handovers_today, '#/schedule')}
      ${tile('Returns today', s.returns_today, '#/schedule')}
      ${tile('On the road', s.ongoing, '#/bookings?status=ongoing')}
      <div class="stat"><span>Booked this month</span><b>${inr(s.month_revenue)}</b></div>
    </div>
    <div class="two">
      <div class="card"><h2>Needs your review <small>${pend.total} pending</small></h2>${bookingList(pend.bookings, true)}</div>
      <div class="card"><h2>Today <a class="link" href="#/schedule">Full schedule →</a></h2>${jobs(sch.handovers, 'out', true)}${jobs(sch.returns, 'back', true)}
        ${!sch.handovers.length && !sch.returns.length ? '<p class="empty">Nothing scheduled today.</p>' : ''}</div>
    </div>`;
  wireRows();
}

/* ---------------- bookings list ---------------- */
function bookingList(rows, compact) {
  if (!rows.length) return '<p class="empty">No bookings here.</p>';
  const table = `<div class="tbl-wrap"><table class="tbl resp"><thead><tr><th>Ref</th><th>Customer</th><th>Ride</th><th>Dates</th>${compact ? '' : '<th>Mode</th>'}<th>Total</th><th>Status</th><th>Payment</th>${compact ? '' : '<th>Docs</th>'}</tr></thead><tbody>
    ${rows.map((b) => `<tr class="rowlink" data-href="#/booking/${b.id}">
      <td class="ref nowrap">${esc(b.ref)}</td>
      <td><b>${esc(b.name)}</b><br><span class="muted small">${esc(b.phone)}</span></td>
      <td>${esc(b.vehicle_name)}${b.guide ? ' <span class="muted small">+ guide</span>' : ''}${b.assigned_reg ? `<br><span class="muted small">${esc(b.assigned_reg)}</span>` : ''}</td>
      <td class="small nowrap">${esc(when(b.start_at, { noDay: compact }))}<br><span class="muted">→ ${esc(when(b.end_at, { noDay: compact }))} · ${b.days}d</span></td>
      ${compact ? '' : `<td class="small">${b.handover === 'delivery' ? '<span class="tag del">Deliver</span>' : '<span class="tag pick">Pickup</span>'}${b.return_mode === 'collection' ? '<span class="tag del">Collect</span>' : ''}</td>`}
      <td><b>${inr(b.total)}</b></td>
      <td>${st(b.status)}</td><td>${pay(b.payment_status)}</td>${compact ? '' : `<td>${docs(b.docs_status)}</td>`}
    </tr>`).join('')}</tbody></table></div>`;
  const cards = `<div class="bcards">${rows.map((b) => `<a class="bcard" href="#/booking/${b.id}">
      <div class="bcard-top"><b>${esc(b.name)}</b>${st(b.status)}</div>
      <p>${esc(b.ref)} · ${esc(b.vehicle_name)}${b.guide ? ' + guide' : ''}</p>
      <p>${esc(when(b.start_at))} → ${esc(when(b.end_at))}</p>
      <p>${b.handover === 'delivery' ? '<span class="tag del">Deliver</span>' : '<span class="tag pick">Pickup</span>'} ${inr(b.total)} · ${pay(b.payment_status)} ${docs(b.docs_status)}</p></a>`).join('')}</div>`;
  return table + cards;
}

function wireRows() {
  $$('tr.rowlink').forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
}

async function bookings(q) {
  const status = q.get('status') || (q.get('payment') || q.get('docs') ? '' : 'active');
  const params = new URLSearchParams();
  for (const k of ['status', 'payment', 'docs', 'q', 'from', 'to', 'page', 'sort']) if (q.get(k)) params.set(k, q.get(k));
  if (!q.get('status') && status) params.set('status', status);
  const data = await api('/bookings?' + params);
  const chips = [['active', 'Active'], ['pending', 'Pending'], ['confirmed', 'Confirmed'], ['ongoing', 'On the road'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['rejected', 'Rejected'], ['', 'All']];
  const extra = q.get('payment') ? 'Payments to verify' : q.get('docs') ? 'Documents to verify' : '';
  const pages = Math.ceil(data.total / data.per);
  view.innerHTML = `
    <div class="head"><div><h1>Bookings</h1><p class="sub">${data.total} booking${data.total === 1 ? '' : 's'}${extra ? ' · ' + esc(extra) : ''}</p></div>
      <div class="head-actions"><a class="btn" id="csv" href="#">Export CSV</a></div></div>
    <div class="filters">
      ${chips.map(([k, l]) => `<button class="chip ${!extra && status === k ? 'on' : ''}" data-status="${k}">${l}</button>`).join('')}
    </div>
    <div class="filters">
      <input class="in" id="f-q" type="search" placeholder="Search name, phone, ref, licence, vehicle no." value="${esc(q.get('q') || '')}">
      <input class="in" id="f-from" type="date" value="${esc(q.get('from') || '')}" title="From">
      <input class="in" id="f-to" type="date" value="${esc(q.get('to') || '')}" title="To">
      <select class="in" id="f-sort" style="flex:0 1 170px"><option value="">Newest first</option><option value="start" ${q.get('sort') === 'start' ? 'selected' : ''}>By start date</option></select>
    </div>
    <div class="card">${bookingList(data.bookings)}
      ${pages > 1 ? `<div class="pager">Page ${data.page} of ${pages} <button class="btn sm" id="prev" ${data.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn sm" id="nextp" ${data.page >= pages ? 'disabled' : ''}>Next</button></div>` : ''}
    </div>`;
  wireRows();
  const go = (patch) => {
    const n = new URLSearchParams(q);
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    if (!('page' in patch)) n.delete('page');
    location.hash = '#/bookings?' + n;
  };
  $$('.chip').forEach((c) => c.addEventListener('click', () => go({ status: c.dataset.status || 'all', payment: '', docs: '' })));
  let t;
  $('#f-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => go({ q: $('#f-q').value.trim() }), 450); });
  $('#f-from').addEventListener('change', () => go({ from: $('#f-from').value }));
  $('#f-to').addEventListener('change', () => go({ to: $('#f-to').value }));
  $('#f-sort').addEventListener('change', () => go({ sort: $('#f-sort').value }));
  $('#prev')?.addEventListener('click', () => go({ page: String(data.page - 1) }));
  $('#nextp')?.addEventListener('click', () => go({ page: String(data.page + 1) }));
  $('#csv').addEventListener('click', (e) => {
    e.preventDefault();
    const from = $('#f-from').value || addDays(today(), -90), to = $('#f-to').value || addDays(today(), 365);
    location.href = `/admin/api/export.csv?from=${from}&to=${to}`;
  });
  if (q.get('q')) { const i = $('#f-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

/* ---------------- booking detail ---------------- */
async function detail(id) {
  const data = await api('/bookings/' + Number(id));
  renderDetail(data);
}

function waText(b, kind) {
  const first = b.name.split(' ')[0];
  const t = {
    confirmed: `Hi ${first}! Your Cloud Trails booking ${b.ref} is confirmed ✅\n${b.vehicle_name}${b.assigned_reg ? ' (' + b.assigned_reg + ')' : ''}\n${when(b.start_at)} → ${when(b.end_at)}\n${b.handover === 'delivery' ? 'We\'ll deliver it to: ' + b.handover_address : 'Pick up at our counter: Nongrim Hills, near Mizo Modern School.'}\nPlease bring your original driving licence and ID. Refundable deposit: ₹${b.deposit}.`,
    docs: `Hi ${first}, this is Cloud Trails about booking ${b.ref}. We need clearer copies of some documents — please upload them on your booking status page (the link you got after booking), or reply here with photos.`,
    payment: `Hi ${first}, this is Cloud Trails about booking ${b.ref}. We couldn't match your UPI payment of ₹${b.pay_now}. Could you send the payment screenshot or the 12-digit UPI reference?`,
    onway: `Hi ${first}! Our rider is on the way with your ${b.vehicle_name} for booking ${b.ref}. Please keep your original licence and ID ready.`,
    reminder: `Hi ${first}! A reminder that your Cloud Trails rental ${b.ref} ends ${when(b.end_at)}. ${b.return_mode === 'collection' ? 'We\'ll collect it from ' + b.return_address + '.' : 'Please return it to our Nongrim Hills counter with a full tank.'}`,
  }[kind];
  return `https://wa.me/${phoneDigits(b.phone)}?text=${encodeURIComponent(t)}`;
}

function renderDetail({ booking: b, files, events, doc_labels }) {
  const latest = {};
  for (const f of files) latest[f.kind] = f.id; // files are in upload order → last wins
  const docFiles = files.filter((f) => !['signature', 'payment'].includes(f.kind));
  const payFiles = files.filter((f) => f.kind === 'payment');
  const sig = files.filter((f) => f.kind === 'signature').pop();
  const open = ['pending', 'confirmed'].includes(b.status);
  const fileTile = (f) => {
    const url = `/admin/api/files/${f.id}`;
    const old = latest[f.kind] !== f.id;
    return `<button type="button" class="doc ${old ? 'old' : ''}" data-file="${f.id}" data-mime="${esc(f.mime)}">
      ${f.mime.startsWith('image/') && f.mime !== 'image/heic' ? `<img src="${url}" alt="${esc(doc_labels[f.kind] || f.kind)}" loading="lazy">` : `<span class="pdf">${f.mime === 'application/pdf' ? 'PDF' : 'HEIC'}</span>`}
      <span>${esc(doc_labels[f.kind] || f.kind)}<small>${old ? 'Older upload · ' : ''}${esc(stamp(f.created_at))}</small></span></button>`;
  };

  const acts = [];
  if (b.status === 'pending') acts.push('<button class="btn ok" data-act="confirm">Confirm booking</button>');
  if (b.status === 'confirmed') acts.push('<button class="btn ok" data-act="handover">Hand over vehicle</button>');
  if (b.status === 'ongoing') acts.push('<button class="btn ok" data-act="complete">Vehicle returned</button>');
  if (['pending', 'confirmed', 'ongoing'].includes(b.status)) acts.push('<button class="btn" data-act="reschedule">Change dates / vehicle</button>');
  if (open) acts.push('<button class="btn danger" data-act="cancel">Cancel</button>', '<button class="btn danger" data-act="reject">Reject</button>');
  if (['cancelled', 'rejected'].includes(b.status) && ['verified', 'submitted'].includes(b.payment_status)) acts.push('<button class="btn" data-act="refund">Mark refunded</button>');
  acts.push(`<a class="btn" href="#/print/${b.id}">Print agreement</a>`);

  const warnings = [];
  if (b.status === 'pending' && b.docs_status !== 'verified') warnings.push('Documents not verified yet.');
  if (b.status === 'pending' && ['submitted', 'awaiting', 'mismatch'].includes(b.payment_status)) warnings.push(b.payment_status === 'submitted' ? 'Payment screenshot not checked yet.' : 'No payment received yet.');
  const overdue = b.status === 'ongoing' && b.end_at < new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16);

  view.innerHTML = `
    <div class="head no-print"><div><p class="sub" style="margin:0 0 .3rem"><a class="link" href="#/bookings">← Bookings</a></p>
      <h1>${esc(b.name)} <span class="muted" style="font-weight:700">${esc(b.ref)}</span></h1>
      <p class="sub">${st(b.status)} ${pay(b.payment_status)} ${docs(b.docs_status)} · booked ${esc(stamp(b.created_at))}</p></div></div>
    <div class="actbar no-print"><div class="actions">${acts.join('')}</div></div>
    ${overdue ? `<div class="alert bad">Overdue — this rental was due back ${esc(when(b.end_at))}.</div>` : ''}
    ${b.status === 'pending' && warnings.length ? `<div class="alert warn">${warnings.map(esc).join(' ')} Check them below before confirming.</div>` : ''}
    ${b.reject_reason && ['rejected'].includes(b.status) ? `<div class="alert bad">Rejected: ${esc(b.reject_reason)}</div>` : ''}
    <div class="det">
      <div>
        <div class="card"><h2>Rental</h2><dl class="kv">
          <dt>Vehicle</dt><dd><b>${esc(b.vehicle_name)}</b>${b.guide ? ' + local guide' : ''} ${b.assigned_reg ? `· <b>${esc(b.assigned_reg)}</b>` : ''} <button class="link" data-act="assign">${b.assigned_reg ? 'Change' : 'Assign vehicle no.'}</button></dd>
          <dt>Start</dt><dd>${esc(when(b.start_at))}</dd>
          <dt>Return</dt><dd>${esc(when(b.end_at))} · ${b.days} day${b.days > 1 ? 's' : ''}</dd>
          <dt>Handover</dt><dd>${b.handover === 'delivery' ? `<span class="tag del">Deliver</span> ${esc(b.handover_address)}${b.handover_landmark ? ` <span class="muted">(${esc(b.handover_landmark)})</span>` : ''} · <a class="link" href="${mapLink(b.handover_address)}" target="_blank" rel="noopener">Map ↗</a>` : '<span class="tag pick">Pickup</span> At the counter'}</dd>
          <dt>Return</dt><dd>${b.return_mode === 'collection' ? `<span class="tag del">Collect</span> ${esc(b.return_address)} · <a class="link" href="${mapLink(b.return_address)}" target="_blank" rel="noopener">Map ↗</a>` : '<span class="tag pick">Counter</span> Customer returns it'}</dd>
          ${b.handover_km != null ? `<dt>Out</dt><dd>${b.handover_km} km · fuel ${esc(b.fuel_out || '')} · deposit taken ${inr(b.deposit_collected)}</dd>` : ''}
          ${b.return_km != null ? `<dt>Back</dt><dd>${b.return_km} km${b.handover_km != null ? ` (${b.return_km - b.handover_km} km ridden)` : ''} · deposit refunded ${inr(b.deposit_refunded)}${b.damage_notes ? `<br><b>Damage / notes:</b> ${esc(b.damage_notes)}` : ''}</dd>` : ''}
          ${b.notes ? `<dt>Customer note</dt><dd>${esc(b.notes)}</dd>` : ''}
        </dl></div>

        <div class="card"><h2>Documents ${docs(b.docs_status)}</h2>
          <dl class="kv" style="margin-bottom:1rem">
            <dt>Licence no.</dt><dd><b>${esc(b.licence_no)}</b> · valid until ${esc(b.licence_expiry)}${b.licence_expiry < b.end_at.slice(0, 10) ? ' <span class="pill rejected">Expires before return</span>' : ''}</dd>
            <dt>ID type</dt><dd>${esc(b.id_type)}</dd>
          </dl>
          ${b.docs_purged_at ? `<div class="alert info">Documents were deleted on ${esc(stamp(b.docs_purged_at))} (retention policy). The signature is kept.</div>` : ''}
          ${b.reupload_kinds ? `<div class="alert warn">Waiting for the customer to re-upload: ${esc(b.reupload_kinds.split(',').map((k) => doc_labels[k] || k).join(', '))}</div>` : ''}
          <div class="docs">${docFiles.map(fileTile).join('') || '<p class="muted">No documents.</p>'}</div>
          ${open ? `<div class="actions" style="margin-top:1rem">
            ${b.docs_status !== 'verified' ? '<button class="btn ok sm" data-act="verify_docs">Documents look good</button>' : ''}
            <button class="btn sm" data-act="request_reupload">Ask for re-upload</button></div>` : ''}
          ${docFiles.length && !b.docs_purged_at && !open ? '<div class="actions" style="margin-top:1rem"><button class="btn sm danger" data-act="purge">Delete documents now</button></div>' : ''}
        </div>

        <div class="card"><h2>Payment ${pay(b.payment_status)}</h2>
          <table class="money">
            <tr><td>Rent (${b.days} day${b.days > 1 ? 's' : ''})</td><td>${inr(b.rent)}</td></tr>
            ${b.guide_fee ? `<tr><td>Guide</td><td>${inr(b.guide_fee)}</td></tr>` : ''}
            ${b.delivery_fee ? `<tr><td>Delivery</td><td>${inr(b.delivery_fee)}</td></tr>` : ''}
            ${b.collection_fee ? `<tr><td>Collection</td><td>${inr(b.collection_fee)}</td></tr>` : ''}
            <tr class="tot"><td><b>Total</b></td><td>${inr(b.total)}</td></tr>
            <tr><td>Asked to pay online</td><td>${inr(b.pay_now)}</td></tr>
            <tr><td>Received</td><td>${b.paid_amount != null ? inr(b.paid_amount) : '—'}</td></tr>
            <tr><td>Balance due at handover</td><td>${inr(Math.max(0, b.total - (b.paid_amount || 0)))}</td></tr>
            <tr><td>Refundable deposit</td><td>${inr(b.deposit)}</td></tr>
          </table>
          ${b.upi_utr ? `<p class="small" style="margin:.8rem 0 0">UPI reference: <b>${esc(b.upi_utr)}</b></p>` : ''}
          ${payFiles.length ? `<div class="docs" style="margin-top:.9rem">${payFiles.map(fileTile).join('')}</div>` : ''}
          ${b.payment_status !== 'verified' && b.payment_status !== 'refunded' ? `<div class="actions" style="margin-top:1rem">
            <button class="btn ok sm" data-act="verify_payment">Payment received</button>
            ${open && b.payment_status !== 'none' ? '<button class="btn sm" data-act="payment_mismatch">Payment problem</button>' : ''}</div>` : ''}
        </div>

        <div class="card"><h2>Rental agreement</h2><dl class="kv">
          <dt>Signed by</dt><dd>${esc(b.consent_name)}</dd>
          <dt>Signed at</dt><dd>${esc(stamp(b.consent_at))} · IP ${esc(b.consent_ip)}</dd>
          <dt>Terms</dt><dd>Version ${esc(b.terms_version)} <span class="muted small">(hash ${esc((b.terms_hash || '').slice(0, 12))}…)</span></dd>
          <dt>Device</dt><dd class="small muted">${esc(b.consent_ua)}</dd>
        </dl>${sig ? `<img class="sig" src="/admin/api/files/${sig.id}" alt="Signature" style="margin-top:.9rem">` : ''}</div>
      </div>

      <div>
        <div class="card"><h2>Customer</h2><dl class="kv">
          <dt>Phone</dt><dd><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></dd>
          ${b.email ? `<dt>Email</dt><dd><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></dd>` : ''}
          <dt>Date of birth</dt><dd>${esc(b.dob)} (${age(b.dob)} yrs)</dd>
          <dt>Address</dt><dd>${esc(b.address)}</dd>
          ${b.hometown ? `<dt>From</dt><dd>${esc(b.hometown)}</dd>` : ''}
          <dt>Emergency</dt><dd>${esc(b.emergency_name)} · <a href="tel:${esc(b.emergency_phone)}">${esc(b.emergency_phone)}</a></dd>
          ${b.pillion_name ? `<dt>Pillion</dt><dd>${esc(b.pillion_name)}</dd>` : ''}
        </dl>
        <p class="lb" style="margin-top:1rem">WhatsApp the customer</p>
        <div class="wa-row">
          <a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/${phoneDigits(b.phone)}">Chat</a>
          <a class="btn sm" target="_blank" rel="noopener" href="${waText(b, 'confirmed')}">Confirmation</a>
          <a class="btn sm" target="_blank" rel="noopener" href="${waText(b, 'docs')}">Need documents</a>
          <a class="btn sm" target="_blank" rel="noopener" href="${waText(b, 'payment')}">Payment issue</a>
          ${b.handover === 'delivery' ? `<a class="btn sm" target="_blank" rel="noopener" href="${waText(b, 'onway')}">On the way</a>` : ''}
          <a class="btn sm" target="_blank" rel="noopener" href="${waText(b, 'reminder')}">Return reminder</a>
        </div></div>

        <div class="card"><h2>Message on status page <button class="link" data-act="message">Edit</button></h2>
          <p class="small ${b.customer_message ? '' : 'muted'}" style="margin:0">${b.customer_message ? esc(b.customer_message) : 'None. The customer sees this on their booking status page.'}</p></div>

        <div class="card"><h2>Internal notes</h2>
          ${b.admin_notes ? `<div class="notes">${esc(b.admin_notes)}</div>` : ''}
          <textarea class="in" id="note-text" rows="2" placeholder="Add a note (only staff see this)"></textarea>
          <div class="actions" style="margin-top:.5rem"><button class="btn sm" id="note-add">Add note</button></div></div>

        <div class="card"><h2>History</h2><ul class="tl">${events.slice().reverse().map((e) => `<li class="${esc(e.actor)}"><b>${esc(e.action.replace(/_/g, ' '))}</b>${e.detail ? ` — ${esc(e.detail)}` : ''}<time>${esc(stamp(e.at))} · ${esc(e.actor)}</time></li>`).join('')}</ul></div>
      </div>
    </div>`;

  $$('[data-file]').forEach((el) => el.addEventListener('click', () => {
    const url = `/admin/api/files/${el.dataset.file}`;
    if (el.dataset.mime.startsWith('image/') && el.dataset.mime !== 'image/heic') { $('#lightbox img').src = url; $('#lightbox').hidden = false; }
    else window.open(url + '?download=' + (el.dataset.mime === 'image/heic' ? '1' : ''), '_blank', 'noopener');
  }));
  $$('[data-act]').forEach((el) => el.addEventListener('click', () => action(b, el.dataset.act, doc_labels)));
  $('#note-add').addEventListener('click', async () => {
    const text = $('#note-text').value.trim();
    if (!text) return;
    renderDetail(await post(`/bookings/${b.id}/action`, { action: 'note', text }));
    toast('Note added');
  });
}

function action(b, act, labels) {
  const run = async (body, msg) => { const d = await post(`/bookings/${b.id}/action`, { action: act, ...body }); renderDetail(d); toast(msg); refreshBadge(); };
  const V = (box, id) => ($('#' + id, box)?.value || '').trim();
  switch (act) {
    case 'confirm':
      return modal({
        title: 'Confirm booking', ok: 'Confirm', okClass: 'ok',
        body: `${b.docs_status !== 'verified' || !['verified', 'none'].includes(b.payment_status) ? `<div class="alert warn">${b.docs_status !== 'verified' ? 'Documents are not marked verified. ' : ''}${!['verified', 'none'].includes(b.payment_status) ? 'Payment is not marked received.' : ''}</div>` : ''}
          <div class="f"><label class="lb" for="m-reg">Vehicle registration no. <span class="muted">(optional now)</span></label><input class="in" id="m-reg" value="${esc(b.assigned_reg || '')}" placeholder="ML05 AB 1234"></div>
          <div class="f"><label class="lb" for="m-msg">Message for the customer <span class="muted">(optional)</span></label><textarea class="in" id="m-msg" rows="2" placeholder="e.g. See you at 10 AM! Bring your original licence."></textarea></div>
          <p class="small muted">Next: send the WhatsApp confirmation from the Customer card.</p>`,
        onOk: (box) => run({ assigned_reg: V(box, 'm-reg'), message: V(box, 'm-msg') }, 'Booking confirmed'),
      });
    case 'verify_payment':
      return modal({
        title: 'Payment received', ok: 'Mark as paid', okClass: 'ok',
        body: `<div class="f"><label class="lb" for="m-amt">Amount received (₹)</label><input class="in" id="m-amt" type="number" min="0" value="${b.paid_amount ?? (b.pay_now || b.total)}"></div>
          ${b.upi_utr ? `<p class="small">Customer's UPI reference: <b>${esc(b.upi_utr)}</b> — match it in your bank / UPI app.</p>` : ''}`,
        onOk: (box) => run({ amount: V(box, 'm-amt') }, 'Payment marked received'),
      });
    case 'payment_mismatch':
      return modal({
        title: 'Payment problem', ok: 'Send to customer', okClass: 'primary',
        body: `<div class="f"><label class="lb" for="m-msg">What's wrong? (shown to the customer)</label><textarea class="in" id="m-msg" rows="3">We could not find your payment of ₹${b.pay_now}. Please upload the correct payment screenshot or UPI reference.</textarea></div>
          <p class="small muted">The customer can upload a new screenshot on their status page.</p>`,
        onOk: (box) => run({ message: V(box, 'm-msg') }, 'Customer asked to re-send payment'),
      });
    case 'verify_docs':
      return run({}, 'Documents verified');
    case 'request_reupload':
      return modal({
        title: 'Ask for documents again', ok: 'Request',
        body: `<div class="checks">${['licence_front', 'licence_back', 'id_front', 'id_back', 'selfie'].map((k) => `<label><input type="checkbox" value="${k}"> ${esc(labels[k])}</label>`).join('')}</div>
          <div class="f"><label class="lb" for="m-msg">Message for the customer</label><textarea class="in" id="m-msg" rows="2">Please upload clearer photos of the documents below — all four corners visible, no glare.</textarea></div>`,
        onOk: (box) => run({ kinds: $$('input[type=checkbox]:checked', box).map((c) => c.value), message: V(box, 'm-msg') }, 'Re-upload requested'),
      });
    case 'reject':
    case 'cancel':
      return modal({
        title: act === 'reject' ? 'Reject booking' : 'Cancel booking', ok: act === 'reject' ? 'Reject' : 'Cancel booking', okClass: 'primary',
        body: `<div class="f"><label class="lb" for="m-msg">Reason (shown to the customer)</label><textarea class="in" id="m-msg" rows="3">${act === 'reject' ? 'Sorry, we could not verify your documents for this booking. Any amount you paid will be refunded within 3 working days.' : 'Your booking was cancelled as requested. Any refund due will be sent within 3 working days.'}</textarea></div>
          <p class="small muted">This frees the vehicle for these dates.</p>`,
        onOk: (box) => run({ message: V(box, 'm-msg') }, act === 'reject' ? 'Booking rejected' : 'Booking cancelled'),
      });
    case 'refund':
      return modal({ title: 'Mark refunded', ok: 'Mark refunded', body: `<div class="f"><label class="lb" for="m-amt">Amount refunded (₹)</label><input class="in" id="m-amt" type="number" value="${b.paid_amount || b.pay_now}"></div>`, onOk: (box) => run({ amount: V(box, 'm-amt') }, 'Marked refunded') });
    case 'handover':
      return modal({
        title: 'Hand over vehicle', ok: 'Vehicle handed over', okClass: 'ok',
        body: `<div class="alert info">Check the original licence and ID against the uploads, and that the rider matches the selfie.</div>
          <div class="grid2"><div class="f"><label class="lb" for="m-reg">Registration no.</label><input class="in" id="m-reg" value="${esc(b.assigned_reg || '')}" placeholder="ML05 AB 1234"></div>
          <div class="f"><label class="lb" for="m-km">Odometer (km)</label><input class="in" id="m-km" type="number" min="0"></div>
          <div class="f"><label class="lb" for="m-fuel">Fuel</label><select class="in" id="m-fuel"><option>Full</option><option>3/4</option><option>Half</option><option>1/4</option></select></div>
          <div class="f"><label class="lb" for="m-dep">Deposit collected (₹)</label><input class="in" id="m-dep" type="number" min="0" value="${b.deposit}"></div></div>
          <p class="small muted">Balance to collect now: <b>${inr(Math.max(0, b.total - (b.paid_amount || 0)))}</b> + deposit.</p>`,
        onOk: (box) => run({ assigned_reg: V(box, 'm-reg'), km: V(box, 'm-km'), fuel: V(box, 'm-fuel'), deposit_collected: V(box, 'm-dep') }, 'Vehicle handed over'),
      });
    case 'complete':
      return modal({
        title: 'Vehicle returned', ok: 'Close rental', okClass: 'ok',
        body: `<div class="grid2"><div class="f"><label class="lb" for="m-km">Odometer (km)</label><input class="in" id="m-km" type="number" min="0" placeholder="${b.handover_km ?? ''}"></div>
          <div class="f"><label class="lb" for="m-dep">Deposit refunded (₹)</label><input class="in" id="m-dep" type="number" min="0" value="${b.deposit_collected ?? b.deposit}"></div></div>
          <div class="f"><label class="lb" for="m-dmg">Damage, fuel shortfall or other deductions</label><textarea class="in" id="m-dmg" rows="2" placeholder="Leave empty if all good"></textarea></div>`,
        onOk: (box) => run({ km: V(box, 'm-km'), deposit_refunded: V(box, 'm-dep'), damage_notes: V(box, 'm-dmg') }, 'Rental completed'),
      });
    case 'assign':
      return modal({ title: 'Vehicle registration no.', body: `<div class="f"><input class="in" id="m-reg" value="${esc(b.assigned_reg || '')}" placeholder="ML05 AB 1234"></div>`, onOk: (box) => run({ assigned_reg: V(box, 'm-reg') }, 'Saved') });
    case 'message':
      return modal({ title: 'Message on status page', body: `<div class="f"><textarea class="in" id="m-msg" rows="3" placeholder="Shown to the customer on their booking status page">${esc(b.customer_message || '')}</textarea></div>`, onOk: (box) => run({ message: V(box, 'm-msg') }, 'Message saved') });
    case 'reschedule':
      return (async () => {
        const { vehicles } = await api('/vehicles');
        modal({
          title: 'Change dates or vehicle', ok: 'Save changes',
          body: `<div class="grid2"><div class="f"><label class="lb" for="m-s">Start</label><input class="in" id="m-s" type="datetime-local" value="${esc(b.start_at)}"></div>
            <div class="f"><label class="lb" for="m-e">Return</label><input class="in" id="m-e" type="datetime-local" value="${esc(b.end_at)}"></div></div>
            <div class="f"><label class="lb" for="m-v">Vehicle</label><select class="in" id="m-v">${vehicles.map((v) => `<option value="${esc(v.id)}" ${v.id === b.vehicle_id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>
            <label class="checks"><label><input type="checkbox" id="m-force"> Override if fully booked</label></label>
            <p class="small muted">Prices are recalculated with today's rates. Current total: ${inr(b.total)}.</p>`,
          onOk: (box) => run({ start: V(box, 'm-s').slice(0, 16), end: V(box, 'm-e').slice(0, 16), vehicle_id: V(box, 'm-v'), force: $('#m-force', box).checked }, 'Booking updated'),
        });
      })();
    case 'purge':
      return modal({
        title: 'Delete documents?', ok: 'Delete', okClass: 'primary',
        body: '<p>Licence, ID, selfie and payment screenshots for this booking are deleted for good. The booking record and signature stay.</p>',
        onOk: async () => { await post(`/bookings/${b.id}/purge-docs`, {}); toast('Documents deleted'); detail(b.id); },
      });
  }
}

/* ---------------- print agreement ---------------- */
async function printView(id) {
  const [{ booking: b, files }, cfg] = await Promise.all([api('/bookings/' + Number(id)), fetch('/api/config').then((r) => r.json())]);
  const sig = files.filter((f) => f.kind === 'signature').pop();
  view.innerHTML = `
    <div class="head no-print"><div><p class="sub" style="margin:0"><a class="link" href="#/booking/${b.id}">← Back to booking</a></p></div>
      <div class="head-actions"><button class="btn primary" onclick="window.print()">Print / save as PDF</button></div></div>
    <article class="print">
      <h1>Cloud Trails Rentals — Rental agreement</h1>
      <p class="muted">Booking ${esc(b.ref)} · Terms version ${esc(b.terms_version)}</p>
      <dl class="kv">
        <dt>Rider</dt><dd>${esc(b.name)}, born ${esc(b.dob)} · ${esc(b.phone)}</dd>
        <dt>Address</dt><dd>${esc(b.address)}</dd>
        <dt>Licence</dt><dd>${esc(b.licence_no)} (valid until ${esc(b.licence_expiry)}) · ID: ${esc(b.id_type)}</dd>
        <dt>Emergency</dt><dd>${esc(b.emergency_name)} · ${esc(b.emergency_phone)}</dd>
        <dt>Vehicle</dt><dd>${esc(b.vehicle_name)} ${b.assigned_reg ? '· ' + esc(b.assigned_reg) : ''}${b.guide ? ' · with guide' : ''}</dd>
        <dt>Period</dt><dd>${esc(when(b.start_at))} to ${esc(when(b.end_at))} (${b.days} day${b.days > 1 ? 's' : ''})</dd>
        <dt>Charges</dt><dd>Total ${inr(b.total)} · refundable deposit ${inr(b.deposit)}</dd>
      </dl>
      ${cfg.terms.version !== b.terms_version ? `<div class="alert warn">The wording below is the current version (${esc(cfg.terms.version)}); this booking agreed to ${esc(b.terms_version)}.</div>` : ''}
      ${cfg.terms.agreement.map((s, i) => `<h3>${i + 1}. ${esc(s.title)}</h3><ul>${s.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`).join('')}
      <h3>Consents given</h3><ul>${cfg.terms.consents.map((c) => `<li>☑ ${esc(c.text)}</li>`).join('')}</ul>
      <h3>Signed</h3>
      <p>${esc(b.consent_name)} · ${esc(stamp(b.consent_at))} IST · IP ${esc(b.consent_ip)}</p>
      ${sig ? `<img class="sig" src="/admin/api/files/${sig.id}" alt="Signature">` : ''}
    </article>`;
}

/* ---------------- schedule ---------------- */
function jobs(list, kind, compact) {
  if (!list.length) return compact ? '' : '<p class="empty">Nothing here.</p>';
  return list.map((b) => {
    const t = kind === 'out' ? b.start_at : b.end_at;
    const isDoor = kind === 'out' ? b.handover === 'delivery' : b.return_mode === 'collection';
    const addr = kind === 'out' ? b.handover_address : b.return_address;
    return `<div class="job"><time>${esc(kind === 'late' ? when(t, { noDay: true }) : timeOnly(t))}</time><div>
      <span class="tag ${isDoor ? 'del' : 'pick'}">${kind === 'out' ? (isDoor ? 'Deliver' : 'Pickup') : (isDoor ? 'Collect' : 'Return')}</span>
      <a class="link" href="#/booking/${b.id}">${esc(b.name)}</a> · ${esc(b.vehicle_name)}${b.assigned_reg ? ` <b>${esc(b.assigned_reg)}</b>` : ''} ${kind === 'out' ? st(b.status) : ''}
      <p>${isDoor ? `${esc(addr)} · <a class="link" href="${mapLink(addr)}" target="_blank" rel="noopener">Map ↗</a> · ` : ''}<a class="link" href="tel:${esc(b.phone)}">${esc(b.phone)}</a>
      ${kind === 'out' && b.payment_status !== 'verified' ? ` · <span class="pill ${esc(b.payment_status)}">${esc(PAY_LABEL[b.payment_status])}</span>` : ''}</p></div></div>`;
  }).join('');
}

async function schedule(q) {
  const date = q.get('date') || today();
  const s = await api('/schedule?date=' + date);
  view.innerHTML = `
    <div class="head"><div><h1>${date === today() ? 'Today' : esc(when(date + 'T00:00', { time: false }))}</h1><p class="sub">${s.handovers.length} going out · ${s.returns.length} coming back</p></div>
      <div class="head-actions"><a class="btn" href="#/schedule?date=${addDays(date, -1)}">← Previous day</a><input class="in" type="date" id="sd" value="${date}" style="width:auto"><a class="btn" href="#/schedule?date=${addDays(date, 1)}">Next day →</a></div></div>
    ${s.overdue.length ? `<div class="card" style="border-color:#EBB9AC"><h2 style="color:var(--bad)">Overdue returns</h2>${jobs(s.overdue, 'late')}</div>` : ''}
    <div class="sched">
      <div class="card"><h2>Going out <small>handovers &amp; deliveries</small></h2>${jobs(s.handovers, 'out')}</div>
      <div class="card"><h2>Coming back <small>returns &amp; collections</small></h2>${jobs(s.returns, 'back')}</div>
    </div>`;
  $('#sd').addEventListener('change', () => { location.hash = '#/schedule?date=' + $('#sd').value; });
}

/* ---------------- calendar ---------------- */
async function calendar(q) {
  const from = q.get('from') || today();
  const c = await api(`/calendar?from=${from}&days=14`);
  view.innerHTML = `
    <div class="head"><div><h1>Availability</h1><p class="sub">Vehicles booked (pending, confirmed or on the road) out of your fleet, per day.</p></div>
      <div class="head-actions"><a class="btn" href="#/calendar?from=${addDays(from, -7)}">← Week</a><a class="btn" href="#/calendar?from=${today()}">Today</a><a class="btn" href="#/calendar?from=${addDays(from, 7)}">Week →</a></div></div>
    <div class="card"><div class="cal-wrap"><table class="cal"><thead><tr><th class="v">Vehicle</th>${c.dates.map((d) => {
      const dt = new Date(d + 'T00:00:00Z');
      const we = [0, 6].includes(dt.getUTCDay());
      return `<th class="${we ? 'we' : ''}">${dt.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })}<br>${dt.getUTCDate()}</th>`;
    }).join('')}</tr></thead><tbody>
    ${c.rows.map((r) => `<tr><th class="v">${esc(r.name)}<br><span class="muted small">${r.units} in fleet${r.active ? '' : ' · hidden'}</span></th>${r.cells.map((n, i) => {
      const cls = n === 0 ? 'c0' : n >= r.units ? 'c2' : 'c1';
      return `<td class="${cls}" title="${n} of ${r.units} booked on ${c.dates[i]}">${n}/${r.units}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="small muted" style="margin-bottom:0">Red = fully booked (the booking page shows it as booked out). Change fleet sizes in Fleet &amp; prices.</p></div>`;
}

/* ---------------- fleet ---------------- */
async function fleet() {
  const { vehicles } = await api('/vehicles');
  const row = (v, isNew) => `<tr data-id="${esc(v.id || '')}">
    <td>${isNew ? '<input class="in" data-k="id" placeholder="honda-activa-6g">' : `<b>${esc(v.name)}</b><br><span class="muted small">${esc(v.id)}</span>`}</td>
    <td><input class="in" data-k="name" value="${esc(v.name || '')}" placeholder="Honda Activa 6G"></td>
    <td><input class="in" data-k="category" value="${esc(v.category || '')}" placeholder="Scooty · Automatic"></td>
    <td><input class="in" data-k="day_rate" type="number" min="0" value="${v.day_rate ?? ''}" style="width:90px"></td>
    <td><input class="in" data-k="deposit" type="number" min="0" value="${v.deposit ?? ''}" style="width:90px"></td>
    <td><input class="in" data-k="units" type="number" min="0" value="${v.units ?? ''}" style="width:70px"></td>
    <td><input class="in" data-k="sort" type="number" value="${v.sort ?? 0}" style="width:60px"></td>
    <td><input class="in" data-k="image" value="${esc(v.image || '')}" placeholder="images/….png"></td>
    <td style="text-align:center"><input type="checkbox" data-k="active" ${isNew || v.active ? 'checked' : ''} title="Show on booking page"></td>
    <td><button class="btn sm primary" data-save>${isNew ? 'Add' : 'Save'}</button></td></tr>`;
  view.innerHTML = `
    <div class="head"><div><h1>Fleet &amp; prices</h1><p class="sub">Day rate drives the online price: 3–6 days get 10% off, 7+ days the weekly rate (5.5 × day rate). Units = how many of this model you can rent out at once.</p></div></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl fleet-tbl"><thead><tr><th>Vehicle</th><th>Name</th><th>Type</th><th>₹ / day</th><th>Deposit</th><th>Units</th><th>Order</th><th>Image</th><th>Live</th><th></th></tr></thead>
      <tbody>${vehicles.map((v) => row(v)).join('')}${row({}, true)}</tbody></table></div>
      <p class="small muted">Images are paths on the website (e.g. <code>images/fleet-tvs-ntorq-125.png</code>). Untick “Live” to hide a model from the booking page without losing its history.</p></div>`;
  $$('[data-save]').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    const d = { id: tr.dataset.id };
    $$('[data-k]', tr).forEach((i) => { d[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value.trim(); });
    if (!d.id) d.id = d.name;
    try { await post('/vehicles', d); toast('Saved'); fleet(); } catch (e) { toast(e.message); }
  }));
}

/* ---------------- settings ---------------- */
async function settings() {
  const { settings: s } = await api('/settings');
  const f = (k, label, attrs = '', help = '') => `<div class="f"><label class="lb" for="s-${k}">${label}</label><input class="in" id="s-${k}" data-k="${k}" value="${esc(s[k])}" ${attrs}>${help ? `<p class="small muted" style="margin:.3rem 0 0">${help}</p>` : ''}</div>`;
  const bookingUrl = new URL('../book.html', location.href).href;
  view.innerHTML = `
    <div class="head"><div><h1>Settings</h1><p class="sub">Changes apply to the booking page straight away.</p></div><div class="head-actions"><button class="btn" id="logout2">Sign out</button><button class="btn primary" id="save">Save settings</button></div></div>
    <div class="set-grid">
      <div>
        <div class="card"><h2>Online booking</h2>
          <label class="switch"><input type="checkbox" data-k="booking_enabled" ${s.booking_enabled === '1' ? 'checked' : ''}> Accept bookings online</label>
          <p class="small muted">When off, the booking page asks customers to WhatsApp you instead.</p>
          <p class="small">Booking page: <a class="link" href="${esc(bookingUrl)}" target="_blank" rel="noopener">${esc(bookingUrl)}</a></p></div>

        <div class="card"><h2>UPI payment</h2>
          ${f('upi_id', 'UPI ID', 'placeholder="cloudtrails@okicici"', 'The booking page builds a QR with the exact amount filled in.')}
          ${f('upi_payee', 'Payee name')}
          <div class="f"><label class="lb">Your UPI QR image <span class="muted">(optional, used if no UPI ID or the QR can't be drawn)</span></label>
            ${s.qr_file_id ? `<img class="qr-prev" src="/api/qr?v=${esc(s.qr_file_id)}" alt="UPI QR">` : ''}
            <div class="actions"><input type="file" id="qr-file" accept="image/png,image/jpeg,image/webp">${s.qr_file_id ? '<button class="btn sm danger" id="qr-del">Remove</button>' : ''}</div></div>
          <div class="f"><label class="lb" for="s-pay_mode">What customers pay online</label>
            <select class="in" id="s-pay_mode" data-k="pay_mode">
              <option value="rent" ${s.pay_mode === 'rent' ? 'selected' : ''}>Full rent + fees (deposit at handover)</option>
              <option value="rent_deposit" ${s.pay_mode === 'rent_deposit' ? 'selected' : ''}>Rent + fees + deposit</option>
              <option value="advance" ${s.pay_mode === 'advance' ? 'selected' : ''}>A fixed advance (rest at handover)</option>
              <option value="none" ${s.pay_mode === 'none' ? 'selected' : ''}>Nothing online (pay at handover)</option></select></div>
          ${f('advance_amount', 'Advance amount (₹)', 'type="number" min="0"', 'Only used with “fixed advance”.')}
          ${!s.upi_id && !s.qr_file_id ? '<div class="alert warn">Add a UPI ID or QR image — until then customers are told to pay at handover.</div>' : ''}</div>
      </div>
      <div>
        <div class="card"><h2>Pickup &amp; drop</h2>
          <div class="grid2">${f('delivery_fee', 'Doorstep delivery fee (₹)', 'type="number" min="0"')}${f('collection_fee', 'Doorstep collection fee (₹)', 'type="number" min="0"')}</div>
          ${f('delivery_area', 'Delivery area (shown to customers)')}
          ${f('counter_address', 'Counter address')}
          ${f('guide_rate', 'Guide add-on (₹ / day)', 'type="number" min="0"')}</div>

        <div class="card"><h2>Booking rules</h2>
          <div class="grid2">${f('open_hour', 'Opens (hour, 24h)', 'type="number" min="0" max="23"')}${f('close_hour', 'Closes (hour, 24h)', 'type="number" min="1" max="24"')}
          ${f('min_lead_hours', 'Minimum notice (hours)', 'type="number" min="0"')}${f('max_days', 'Longest online booking (days)', 'type="number" min="1"')}</div></div>

        <div class="card"><h2>Contact &amp; alerts</h2>
          ${f('whatsapp', 'WhatsApp number', 'inputmode="numeric"', 'With country code, e.g. 918730883206.')}
          ${f('notify_email', 'Alert email for new bookings', 'type="email" placeholder="you@example.com"', ME.email_alerts ? 'Email alerts are switched on.' : 'Needs the RESEND_API_KEY secret in Cloudflare to send. New bookings always show here.')}
          ${f('doc_retention_days', 'Delete customer documents after (days)', 'type="number" min="1"', 'Counted from when a rental is completed, cancelled or rejected. Signatures are kept.')}</div>
      </div>
    </div>`;
  $('#logout2').addEventListener('click', () => $('#logout').click());
  $('#save').addEventListener('click', async () => {
    const d = {};
    $$('[data-k]').forEach((i) => { d[i.dataset.k] = i.type === 'checkbox' ? (i.checked ? '1' : '0') : i.value.trim(); });
    try { await post('/settings', d); toast('Settings saved'); settings(); } catch (e) { toast(e.message); }
  });
  $('#qr-file').addEventListener('change', async () => {
    const file = $('#qr-file').files[0];
    if (!file) return;
    const form = new FormData(); form.set('qr', file);
    try { await api('/settings/qr', { method: 'POST', form }); toast('QR uploaded'); settings(); } catch (e) { toast(e.message); }
  });
  $('#qr-del')?.addEventListener('click', async () => { await api('/settings/qr', { method: 'DELETE', body: {} }); toast('QR removed'); settings(); });
}

start();
