// Cloud Trails — online booking flow (book.html).
import { quote, inr, rentalDays, nowIST, parseLocal, perDay, itemsSummary } from './pricing.js';

const API = window.CT_API || '';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STEPS = 6;
const DOCS = {
  licence_front: { label: 'Licence — front', required: true },
  licence_back: { label: 'Licence — back', required: true },
  id_front: { label: 'ID — front', required: true },
  id_back: { label: 'ID — back', required: false, note: 'If your ID has a back side' },
  selfie: { label: 'Your selfie', required: true, camera: true },
  payment: { label: 'Payment screenshot', required: true },
};
function docInfo(kind) {
  if (DOCS[kind]) return DOCS[kind];
  const m = /^rider(\d+)_licence$/.exec(kind);
  return { label: 'Driving licence — front', required: true, note: m ? `Rider ${Number(m[1]) + 1}` : '' };
}
const FIELD_STEP = {
  start: 0, end: 0, vehicle: 0,
  handover_address: 1, return_address: 1,
  name: 2, phone: 2, email: 2, dob: 2, address: 2, emergency_name: 2, emergency_phone: 2,
  licence_no: 3, licence_expiry: 3, id_type: 3, licence_front: 3, licence_back: 3, id_front: 3, id_back: 3, selfie: 3,
  consents: 4, consent_name: 4, signature: 4, terms: 4,
  payment: 5, upi_utr: 5,
};
const stepOf = (k) => (FIELD_STEP[k] != null ? FIELD_STEP[k] : /^rider\d+_/.test(k) ? 3 : null);
const DRAFT_FIELDS = ['name', 'dob', 'phone', 'email', 'address', 'hometown', 'pillion_name', 'emergency_name', 'emergency_phone', 'notes',
  'licence_no', 'licence_expiry', 'id_type', 'handover_address', 'handover_landmark', 'return_address'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const S = {
  cfg: null, vehicles: [], avail: {}, step: 0, maxStep: 0,
  files: {}, sigDirty: false, submitting: false,
  cart: {},            // vehicle id → quantity
  riders: [],          // [{name, phone, licence_no}] for vehicles 2..n
  view: '',            // first month shown in the calendar, "YYYY-MM"
  picking: 'start',    // which end of the range the next calendar tap sets
  hover: '',
};

/* ---------------- storage helpers (never required) ---------------- */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

/* ---------------- boot ---------------- */
async function boot() {
  $('#year').textContent = new Date().getFullYear();
  let cfg;
  try {
    const r = await fetch(API + '/api/config', { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('config ' + r.status);
    cfg = await r.json();
  } catch (e) {
    return offline();
  }
  S.cfg = cfg;
  S.vehicles = cfg.vehicles;
  S.max = cfg.max_vehicles || 10;
  const st = cfg.settings;
  $('#top-wa').href = 'https://wa.me/' + st.whatsapp;
  if (st.booking_enabled !== '1') return offline('Online booking is paused right now. Message us on WhatsApp and we\'ll sort you out quickly.');

  $('#app').hidden = false;
  $('#bar').hidden = false;
  setupTimes();
  setupDates();
  setupCalendar();
  renderPresets();
  renderVehicles();
  setupHandover();
  $$('.up').forEach(initUpload);
  setupDatePickers();
  setupCamera();
  setupTerms();
  setupSignature();
  restoreDraft();
  $$('.dpick').forEach((el) => el.load());
  bindNav();
  $('#guide-price').textContent = `+${inr(st.guide_rate)} / day`;
  $('#delivery-price').textContent = Number(st.delivery_fee) ? inr(st.delivery_fee) : 'Free';
  $('#collection-price').textContent = Number(st.collection_fee) ? inr(st.collection_fee) : 'Free';
  $('#delivery-area').textContent = st.delivery_area;
  $('#counter-address').textContent = st.counter_address;
  $('#id_type').insertAdjacentHTML('beforeend', cfg.id_types.map((t) => `<option>${esc(t)}</option>`).join(''));
  const saved = store.get('ct_draft');
  if (saved?.id_type) $('#id_type').value = saved.id_type;
  $('#consent_date').value = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  document.addEventListener('input', onAnyChange);
  document.addEventListener('change', onAnyChange);
  await refreshAvailability();
  update();
  show(0);
}

function offline(msg) {
  $('#offline').hidden = false;
  if (msg) $('#offline-msg').textContent = msg;
  const p = new URLSearchParams(location.search);
  const v = p.get('vehicle');
  const text = "Hi Cloud Trails! I'd like to book" + (v ? ' the ' + v.replace(/-/g, ' ') : ' a ride') + '.';
  $('#offline-wa').href = 'https://wa.me/918730883206?text=' + encodeURIComponent(text);
}

/* ---------------- dates & times ---------------- */
function today() { return (S.cfg?.now || nowIST()).slice(0, 10); }
function addDays(date, n) { return new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function maxDays() { return Number(S.cfg.settings.max_days) || 30; }

function setupTimes() {
  const st = S.cfg.settings;
  const open = Number(st.open_hour), close = Number(st.close_hour);
  const opts = [];
  for (let h = open; h <= close; h++) {
    for (const m of [0, 30]) {
      if (h === close && m) break;
      const v = String(h).padStart(2, '0') + ':' + (m ? '30' : '00');
      const label = new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
      opts.push(`<option value="${v}">${label}</option>`);
    }
  }
  $('#start-time').innerHTML = opts.join('');
  $('#end-time').innerHTML = opts.join('');
}

function setupDates() {
  const t = today();
  const p = new URLSearchParams(location.search);
  const qs = p.get('start'), qe = p.get('end');
  const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && d >= t;
  const sd = okDate(qs) ? qs : addDays(t, 1);
  const ed = okDate(qe) && qe > sd ? qe : addDays(sd, 1);
  setRange(sd, ed, { silent: true });
  $('#start-time').value = '10:00';
  $('#end-time').value = '10:00';
  const v = p.get('vehicle');
  if (v && S.vehicles.some((x) => x.id === v)) S.cart[v] = 1;
  if (p.get('guide') === '1') $('#guide').checked = true;
  S.view = sd.slice(0, 7);
}

function setRange(start, end, { silent } = {}) {
  $('#start-date').value = start || '';
  $('#end-date').value = end || '';
  if (!silent) { renderCalendar(); renderPresets(); scheduleAvailability(); saveDraft(); update(); }
}

function startVal() { return $('#start-date').value && $('#start-time').value ? `${$('#start-date').value}T${$('#start-time').value}` : ''; }
function endVal() { return $('#end-date').value && $('#end-time').value ? `${$('#end-date').value}T${$('#end-time').value}` : ''; }

function fmtWhen(s) {
  if (!s) return '';
  const t = parseLocal(s);
  if (!isFinite(t)) return '';
  const d = new Date(t);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) + ', ' +
    d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}
function fmtDay(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/* ---------------- calendar ---------------- */
function monthsShown() { return $('.cal-card').getBoundingClientRect().width >= 620 ? 2 : 1; }
function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function setupCalendar() {
  $('#cal-prev').addEventListener('click', () => { if (S.view > today().slice(0, 7)) { S.view = shiftMonth(S.view, -1); renderCalendar(); } });
  $('#cal-next').addEventListener('click', () => { S.view = shiftMonth(S.view, 1); renderCalendar(); });
  const box = $('#cal-months');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-date]');
    if (b && !b.disabled) pickDate(b.dataset.date);
  });
  box.addEventListener('mouseover', (e) => {
    const b = e.target.closest('button[data-date]');
    const d = b && !b.disabled ? b.dataset.date : '';
    if (S.picking === 'end' && d !== S.hover) { S.hover = d; paintRange(); }
  });
  box.addEventListener('mouseleave', () => { if (S.hover) { S.hover = ''; paintRange(); } });
  let lastShown = 0;
  window.addEventListener('resize', () => { const n = monthsShown(); if (n !== lastShown) { lastShown = n; renderCalendar(); } });
  lastShown = monthsShown();
  renderCalendar();
}

function pickDate(d) {
  const s = $('#start-date').value;
  if (S.picking === 'start' || !s || d <= s) {
    S.picking = 'end';
    setRange(d, '');
    $('#cal-hint').textContent = 'Now tap your return date';
  } else {
    S.picking = 'start';
    S.hover = '';
    setRange(s, d);
    $('#cal-hint').textContent = 'Tap a new pick-up date to change';
  }
}

function renderCalendar() {
  const box = $('#cal-months');
  const n = monthsShown();
  const t = today();
  const minView = t.slice(0, 7);
  if (S.view < minView) S.view = minView;
  const s = $('#start-date').value;
  const limit = S.picking === 'end' && s ? addDays(s, maxDays()) : '';
  let html = '';
  for (let k = 0; k < n; k++) {
    const ym = shiftMonth(S.view, k);
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const lead = (first.getUTCDay() + 6) % 7; // Monday first
    const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
    html += `<div class="cal-month"><p class="cal-title font-display">${MONTHS[m - 1]} <span>${y}</span></p>
      <div class="cal-grid">${WEEKDAYS.map((w) => `<span class="cal-wd">${w}</span>`).join('')}`;
    for (let i = 0; i < lead; i++) html += '<span class="cal-pad"></span>';
    for (let d = 1; d <= daysIn; d++) {
      const iso = `${ym}-${String(d).padStart(2, '0')}`;
      const dis = iso < t || (limit && iso > limit);
      const wk = ((lead + d - 1) % 7) >= 5;
      html += `<button type="button" class="cal-day${iso === t ? ' is-today' : ''}${wk ? ' is-we' : ''}" data-date="${iso}" ${dis ? 'disabled' : ''} aria-label="${fmtDay(iso)}"><span>${d}</span></button>`;
    }
    html += '</div></div>';
  }
  box.innerHTML = html;
  $('#cal-prev').disabled = S.view <= minView;
  paintRange();
}

function paintRange() {
  const s = $('#start-date').value;
  const e = $('#end-date').value || (S.picking === 'end' && S.hover > s ? S.hover : '');
  $$('#cal-months .cal-day').forEach((b) => {
    const d = b.dataset.date;
    b.classList.toggle('is-start', d === s);
    b.classList.toggle('solo', d === s && !e);
    b.classList.toggle('is-end', Boolean(e) && d === e);
    b.classList.toggle('in-range', Boolean(s && e) && d > s && d < e);
    b.classList.toggle('is-preview', !$('#end-date').value && Boolean(e) && d > s && d <= e);
  });
  $('#tf-start').textContent = fmtDay(s);
  $('#tf-end').textContent = $('#end-date').value ? fmtDay($('#end-date').value) : (S.picking === 'end' ? 'Pick a date' : '—');
  const days = rentalDays(startVal(), endVal());
  $('#tf-days').textContent = days ? `${days} day${days > 1 ? 's' : ''}` : '';
}

/* ---------------- presets ---------------- */
function renderPresets() {
  const s = $('#start-date').value, e = $('#end-date').value;
  const cur = s && e && $('#start-time').value === $('#end-time').value ? daysBetween(s, e) : 0;
  const scooty = minRate();
  const list = [
    { days: 1, label: '1 day', sub: `from ${inr(scooty)}` },
    { days: 2, label: '2 days', sub: `from ${inr(scooty * 2)}` },
    { days: 3, label: '3 days', sub: '10% off', tag: true },
    { days: 7, label: '1 week', sub: `${inr(perDay(scooty, 7))}/day`, tag: true, best: true },
    { days: 14, label: '2 weeks', sub: `${inr(perDay(scooty, 14))}/day`, tag: true },
  ].filter((p) => p.days <= maxDays());
  $('#presets').innerHTML = list.map((p) =>
    `<button type="button" class="preset${cur === p.days ? ' is-on' : ''}${p.best ? ' is-best' : ''}" data-days="${p.days}">
      ${p.best ? '<i>Best value</i>' : ''}<b>${p.label}</b><small class="${p.tag ? 'save' : ''}">${p.sub}</small></button>`).join('') +
    `<button type="button" class="preset${cur && !list.some((p) => p.days === cur) ? ' is-on' : ''}" data-days="custom"><b>Custom</b><small>Pick on calendar</small></button>`;
  $$('#presets .preset').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.days === 'custom') {
      S.picking = 'start';
      $('#cal-hint').textContent = 'Tap your pick-up date';
      $('.cal-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const start = $('#start-date').value && $('#start-date').value >= today() ? $('#start-date').value : addDays(today(), 1);
    $('#end-time').value = $('#start-time').value;
    S.picking = 'start';
    setRange(start, addDays(start, Number(b.dataset.days)));
    $('#cal-hint').textContent = 'Tap a new pick-up date to change';
    const end = $('#end-date').value;
    if (end.slice(0, 7) > shiftMonth(S.view, monthsShown() - 1)) { S.view = start.slice(0, 7); renderCalendar(); }
  }));
}

function minRate() { return Math.min(...S.vehicles.map((v) => v.day_rate)); }

/* ---------------- availability ---------------- */
let availTimer = 0, availSeq = 0;
function scheduleAvailability() { clearTimeout(availTimer); availTimer = setTimeout(refreshAvailability, 200); }

async function refreshAvailability() {
  const s = startVal(), e = endVal();
  if (!s || !e || parseLocal(e) <= parseLocal(s)) { S.avail = {}; S.availErrors = null; renderVehicles(); update(); return; }
  const seq = ++availSeq;
  try {
    const r = await fetch(`${API}/api/availability?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`);
    const j = await r.json();
    if (seq !== availSeq) return;
    S.availErrors = j.ok ? null : j.errors;
    S.avail = j.ok ? Object.fromEntries(j.vehicles.map((v) => [v.id, v.available])) : {};
    setErr('start', j.ok ? '' : j.errors?.start || '');
    setErr('end', j.ok ? '' : j.errors?.end || '');
  } catch { S.avail = {}; }
  // Trim the cart to what's free.
  for (const [id, q] of Object.entries(S.cart)) if (S.avail[id] != null && q > S.avail[id]) S.cart[id] = S.avail[id];
  renderVehicles();
  update();
}

/* ---------------- vehicles ---------------- */
function cartItems() {
  return S.vehicles.filter((v) => (S.cart[v.id] || 0) > 0).map((v) => ({ vehicle: v, qty: S.cart[v.id] }));
}
function cartCount() { return Object.values(S.cart).reduce((a, b) => a + (b || 0), 0); }

function renderVehicles() {
  const box = $('#vehicles');
  const known = Object.keys(S.avail).length > 0;
  const days = rentalDays(startVal(), endVal());
  const total = cartCount();
  box.innerHTML = S.vehicles.map((v) => {
    const left = known ? S.avail[v.id] : null;
    const qty = S.cart[v.id] || 0;
    const out = known && left === 0;
    const badge = !known ? '' : out ? '<span class="badge out">Booked out</span>' : left <= 2 ? `<span class="badge low">Only ${left} left</span>` : `<span class="badge ok">${left} available</span>`;
    const eff = days ? perDay(v.day_rate, days) : v.day_rate;
    const price = eff < v.day_rate
      ? `<b>${inr(eff)}</b><span>/day</span> <s>${inr(v.day_rate)}</s> <em>${days >= 7 ? 'weekly rate' : '10% off'}</em>`
      : `<b>${inr(v.day_rate)}</b><span>/day</span>`;
    const canAdd = !out && (left == null || qty < left) && total < S.max;
    return `<div class="veh${out ? ' is-out' : ''}${qty ? ' is-on' : ''}" data-id="${esc(v.id)}">
      <button type="button" class="veh-pick" ${out ? 'disabled' : ''} aria-label="${qty ? 'Selected' : 'Add'}: ${esc(v.name)}">
        <span class="veh-img">${v.image ? `<img src="${esc(v.image)}" alt="" loading="lazy">` : ''}${badge}${qty ? `<span class="veh-qty">${qty}</span>` : ''}</span>
      </button>
      <div class="veh-body">
        <span class="veh-cat">${esc(v.category)}</span>
        <span class="veh-name font-display">${esc(v.name)}</span>
        <span class="veh-price">${price}</span>
        <span class="veh-dep">Deposit ${inr(v.deposit)}${days ? ` · ${inr(eff * days)} for ${days} day${days > 1 ? 's' : ''}` : ''}</span>
        <div class="veh-actions">
          ${qty ? `<div class="stepper" role="group" aria-label="How many ${esc(v.name)}">
              <button type="button" data-step="-1" aria-label="One less">−</button>
              <output aria-live="polite">${qty}</output>
              <button type="button" data-step="1" aria-label="One more" ${canAdd ? '' : 'disabled'}>+</button>
            </div>`
          : `<button type="button" class="veh-add" data-step="1" ${canAdd ? '' : 'disabled'}>${out ? 'Booked out' : 'Add'}</button>`}
        </div>
      </div>
    </div>`;
  }).join('');
  $$('.veh', box).forEach((card) => {
    const id = card.dataset.id;
    $$('[data-step]', card).forEach((b) => b.addEventListener('click', () => changeQty(id, Number(b.dataset.step))));
    $('.veh-pick', card).addEventListener('click', () => { if (!S.cart[id]) changeQty(id, 1); });
  });
}

function changeQty(id, delta) {
  const left = S.avail[id];
  let q = (S.cart[id] || 0) + delta;
  if (delta > 0 && cartCount() >= S.max) return;
  if (left != null) q = Math.min(q, left);
  S.cart[id] = Math.max(0, q);
  if (!S.cart[id]) delete S.cart[id];
  setErr('vehicle', '');
  renderVehicles();
  renderRiders();
  saveDraft();
  update();
}

/* ---------------- handover ---------------- */
function radio(name) { return ($(`input[name="${name}"]:checked`) || {}).value; }

function setupHandover() {
  const sync = () => {
    const del = radio('handover') === 'delivery';
    const col = radio('return_mode') === 'collection';
    $('#delivery-fields').hidden = !del;
    $('#collection-fields').hidden = !col;
    $('#same-wrap').hidden = !del;
    if (!del) $('#same-address').checked = false;
    else if (!S.sameTouched && !val('return_address')) $('#same-address').checked = true;
    $('#return-address-wrap').hidden = del && $('#same-address').checked;
    $$('.opt').forEach((o) => o.classList.toggle('is-on', $('input', o).checked));
  };
  $('#same-address').addEventListener('change', () => { S.sameTouched = true; });
  $$('input[name="handover"], input[name="return_mode"], #same-address').forEach((i) => i.addEventListener('change', () => { sync(); update(); }));
  sync();
  S.syncHandover = sync;
}

/* ---------------- other riders ---------------- */
function renderRiders() {
  const need = Math.max(0, cartCount() - 1);
  $('#riders-section').hidden = need === 0;
  if (!need) return;
  $('#riders-count').textContent = `${cartCount()} vehicles`;
  while (S.riders.length < need) S.riders.push({ name: '', phone: '', licence_no: '' });
  const box = $('#riders');
  const have = $$('.rider', box).length;
  if (have === need) return;
  // Keep what's typed: rebuild from S.riders, keep uploads in S.files.
  box.innerHTML = Array.from({ length: need }, (_, i) => {
    const n = i + 1, r = S.riders[i];
    return `<div class="rider" data-n="${n}">
      <p class="rider-title font-display">Rider ${n + 1}</p>
      <div class="row2">
        <div class="fld"><label for="rider${n}_name">Full name</label><input class="field" id="rider${n}_name" data-rider="${i}" data-key="name" value="${esc(r.name)}" placeholder="As on their licence"><p class="err" data-err="rider${n}_name"></p></div>
        <div class="fld"><label for="rider${n}_phone">Mobile <i>(optional)</i></label><input class="field" id="rider${n}_phone" type="tel" inputmode="tel" data-rider="${i}" data-key="phone" value="${esc(r.phone)}" placeholder="98765 43210"><p class="err" data-err="rider${n}_phone"></p></div>
        <div class="fld"><label for="rider${n}_licence_no">Licence number</label><input class="field" id="rider${n}_licence_no" data-rider="${i}" data-key="licence_no" value="${esc(r.licence_no)}" autocapitalize="characters" placeholder="e.g. AS01 20200011111"><p class="err" data-err="rider${n}_licence_no"></p></div>
        <div class="up" data-kind="rider${n}_licence"></div>
      </div>
    </div>`;
  }).join('');
  $$('.rider .up', box).forEach((el) => { initUpload(el); if (S.files[el.dataset.kind]) renderPreview(el, el.dataset.kind); });
  $$('[data-rider]', box).forEach((inp) => inp.addEventListener('input', () => { S.riders[Number(inp.dataset.rider)][inp.dataset.key] = inp.value; }));
}

/* ---------------- documents ---------------- */
function initUpload(el) {
  const kind = el.dataset.kind;
  const d = docInfo(kind);
  el.innerHTML = `
    <span class="up-label">${esc(d.label)}${d.required ? '' : ' <i>(optional)</i>'}</span>
    <label class="up-zone" tabindex="0">
      <input type="file" accept="${kind === 'selfie' ? 'image/*' : 'image/*,application/pdf'}" data-kind="${kind}">
      <span class="up-empty"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 16V4m0 0 4 4m-4-4L8 8"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>
        <span>${d.camera ? 'Or upload a photo' : 'Tap to upload'}</span>${d.note && DOCS[kind] ? `<small>${esc(d.note)}</small>` : ''}</span>
      <span class="up-preview" hidden></span>
    </label>
    <p class="err" data-err="${kind}"></p>`;
  if (d.camera) {
    $('.up-label', el).insertAdjacentHTML('afterend', `<button type="button" class="cam-open">
      <span class="cam-ico"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.6"/></svg></span>
      <span class="cam-open-txt"><b>Take a selfie now</b><small>Opens your camera — takes 5 seconds</small></span></button>`);
    $('.cam-open', el).addEventListener('click', () => openCamera(kind));
  }
  const input = $('input', el);
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { setErr(kind, 'That file is over 20 MB — please choose a smaller photo.'); input.value = ''; return; }
    setErr(kind, '');
    el.classList.add('is-busy');
    const blob = await compress(f);
    el.classList.remove('is-busy');
    if (blob.size > 10 * 1024 * 1024) { setErr(kind, 'That file is larger than 10 MB.'); input.value = ''; return; }
    S.files[kind] = blob;
    if (kind === 'selfie') S.selfieSource = 'upload';
    renderPreview(el, kind);
    update();
  });
  $('.up-zone', el).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
}

function renderPreview(el, kind) {
  const blob = S.files[kind];
  const camBtn = $('.cam-open b', el);
  if (camBtn) camBtn.textContent = blob ? 'Retake selfie' : 'Take a selfie now';
  const pv = $('.up-preview', el);
  const empty = $('.up-empty', el);
  if (!blob) { pv.hidden = true; empty.hidden = false; el.classList.remove('has-file'); return; }
  const isPdf = blob.type === 'application/pdf';
  const url = isPdf ? '' : URL.createObjectURL(blob);
  pv.innerHTML = (isPdf ? '<span class="pdf">PDF</span>' : `<img src="${url}" alt="">`) +
    `<span class="up-meta">${esc(blob.name || (isPdf ? 'document.pdf' : 'photo.jpg'))} · ${(blob.size / 1024 / 1024).toFixed(1)} MB</span>
     <button type="button" class="up-remove">Remove</button>`;
  pv.hidden = false; empty.hidden = true; el.classList.add('has-file');
  $('.up-remove', pv).addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    delete S.files[kind];
    $('input', el).value = '';
    renderPreview(el, kind);
    update();
  });
}

async function compress(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) return file; // PDF/HEIC as-is
  if (file.size < 900 * 1024) return file;
  try {
    const bmp = await (window.createImageBitmap ? createImageBitmap(file) : loadImg(file));
    const max = 2000;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

function loadImg(file) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
}

/* ---------------- date of birth / licence validity pickers ---------------- */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function setupDatePickers() {
  $$('.dpick').forEach((el) => {
    const id = el.dataset.for;
    const hidden = document.getElementById(id);
    const y0 = Number(today().slice(0, 4));
    const years = el.dataset.range === 'dob'
      ? Array.from({ length: 83 }, (_, i) => y0 - 18 - i)    // 18 to 100 years old
      : Array.from({ length: 41 }, (_, i) => y0 + i);        // licence valid until: this year onwards
    el.innerHTML = `
      <span class="dp-sel"><select class="field dp-d" aria-label="Day"><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select></span>
      <span class="dp-sel"><select class="field dp-m" aria-label="Month"><option value="">Month</option>${MON.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}</select></span>
      <span class="dp-sel"><select class="field dp-y" aria-label="Year"><option value="">Year</option>${years.map((y) => `<option value="${y}">${y}</option>`).join('')}</select></span>`;
    const dS = $('.dp-d', el), mS = $('.dp-m', el), yS = $('.dp-y', el);
    const note = document.getElementById(id + '-note');
    const sync = (fromUser) => {
      const m = Number(mS.value), y = Number(yS.value);
      const maxD = m ? new Date(Date.UTC(y || 2000, m, 0)).getUTCDate() : 31;
      [...dS.options].forEach((o) => { if (o.value) o.disabled = Number(o.value) > maxD; });
      if (Number(dS.value) > maxD) dS.value = String(maxD);
      const d = Number(dS.value);
      const iso = d && m && y ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
      hidden.value = iso;
      $$('select', el).forEach((x) => x.classList.toggle('is-set', Boolean(x.value)));
      if (note) note.textContent = iso ? describe(el.dataset.range, iso) : '';
      if (fromUser) { setErr(id, ''); saveDraft(); update(); }
    };
    $$('select', el).forEach((x) => x.addEventListener('change', (e) => { e.stopPropagation(); sync(true); }));
    el.load = () => {
      const v = hidden.value;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
      if (m) {
        if (![...yS.options].some((o) => o.value === String(Number(m[1])))) yS.insertAdjacentHTML('beforeend', `<option value="${Number(m[1])}">${Number(m[1])}</option>`);
        yS.value = String(Number(m[1])); mS.value = String(Number(m[2])); dS.value = String(Number(m[3]));
      }
      sync(false);
    };
  });
}

function describe(range, iso) {
  const t = today();
  if (range === 'dob') {
    const age = Number(t.slice(0, 4)) - Number(iso.slice(0, 4)) - (t.slice(5) < iso.slice(5) ? 1 : 0);
    return age >= 18 ? `${age} years old` : '';
  }
  if (iso < t) return 'This licence has expired';
  const yrs = Math.floor(daysBetween(t, iso) / 365);
  return yrs >= 1 ? `Valid for about ${yrs} more year${yrs > 1 ? 's' : ''}` : 'Valid for less than a year';
}

/* ---------------- live camera selfie ---------------- */
const CAM = { stream: null, facing: 'user', kind: 'selfie', blob: null };

function setupCamera() {
  $('#cam-close').addEventListener('click', closeCamera);
  $('#cam').addEventListener('click', (e) => { if (e.target.id === 'cam') closeCamera(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#cam').hidden) closeCamera(); });
  $('#cam-shoot').addEventListener('click', snap);
  $('#cam-retake').addEventListener('click', () => { CAM.blob = null; showLive(true); });
  $('#cam-use').addEventListener('click', usePhoto);
  $('#cam-flip').addEventListener('click', async () => { CAM.facing = CAM.facing === 'user' ? 'environment' : 'user'; await startStream(); });
  $('#cam-fallback').addEventListener('click', () => {
    closeCamera();
    const input = $(`.up[data-kind="${CAM.kind}"] input[type=file]`);
    input.setAttribute('capture', 'user');   // phones open their own camera app
    input.click();
    setTimeout(() => input.removeAttribute('capture'), 1000);
  });
}

async function openCamera(kind) {
  CAM.kind = kind; CAM.facing = 'user'; CAM.blob = null;
  $('#cam').hidden = false;
  document.body.classList.add('no-scroll');
  showLive(false);
  if (!navigator.mediaDevices?.getUserMedia) return camError('This browser can\'t open the camera here.');
  await startStream();
}

async function startStream() {
  stopStream();
  $('#cam-msg').hidden = true;
  $('#cam-shoot').disabled = true;
  try {
    CAM.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: CAM.facing, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
    const v = $('#cam-video');
    v.srcObject = CAM.stream;
    v.classList.toggle('mirror', CAM.facing === 'user');
    await v.play().catch(() => {});
    $('#cam-shoot').disabled = false;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    $('#cam-flip').hidden = cams.length < 2;
  } catch (e) {
    const name = e && e.name;
    camError(name === 'NotAllowedError' || name === 'SecurityError'
      ? 'Camera access was blocked. Allow the camera for this site in your browser settings, or upload a photo instead.'
      : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No camera found on this device.' : 'We couldn\'t start the camera.');
  }
}

function camError(msg) {
  $('#cam-msg-text').textContent = msg;
  $('#cam-msg').hidden = false;
  $('#cam-shoot').disabled = true;
}

function stopStream() {
  if (CAM.stream) CAM.stream.getTracks().forEach((t) => t.stop());
  CAM.stream = null;
}

function showLive(restart) {
  $('#cam-video').hidden = false;
  $('#cam-still').hidden = true;
  $('#cam-guide').hidden = false;
  $('#cam-live').hidden = false;
  $('#cam-review').hidden = true;
  $('#cam-tip').textContent = 'Fit your face in the oval · good light · no sunglasses or helmet';
  if (restart && !CAM.stream) startStream();
}

async function snap() {
  const v = $('#cam-video');
  if (!v.videoWidth) return;
  const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);   // saved the right way round (not mirrored)
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
  if (!blob) return camError('That didn\'t work — try again.');
  CAM.blob = new File([blob], 'selfie.jpg', { type: 'image/jpeg' });
  const f = $('#cam-flash');
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  const img = $('#cam-still');
  img.src = URL.createObjectURL(CAM.blob);
  img.classList.toggle('mirror', CAM.facing === 'user');
  img.hidden = false;
  v.hidden = true;
  $('#cam-guide').hidden = true;
  $('#cam-live').hidden = true;
  $('#cam-review').hidden = false;
  $('#cam-tip').textContent = 'Is your face clear and well lit?';
  stopStream();
}

function usePhoto() {
  if (!CAM.blob) return;
  S.files[CAM.kind] = CAM.blob;
  if (CAM.kind === 'selfie') S.selfieSource = 'camera';
  const el = $(`.up[data-kind="${CAM.kind}"]`);
  setErr(CAM.kind, '');
  renderPreview(el, CAM.kind);
  closeCamera();
  update();
}

function closeCamera() {
  stopStream();
  $('#cam').hidden = true;
  document.body.classList.remove('no-scroll');
}

/* ---------------- terms & signature ---------------- */
function setupTerms() {
  const t = S.cfg.terms;
  $('#terms').innerHTML = `<p class="terms-ver">Version ${esc(t.version)}</p>` + t.agreement.map((s, i) =>
    `<h4>${i + 1}. ${esc(s.title)}</h4><ul>${s.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`).join('');
  $('#consents').innerHTML = t.consents.map((c) =>
    `<label class="check"><input type="checkbox" data-consent="${esc(c.id)}"> ${esc(c.text)}</label>`).join('');
}

function setupSignature() {
  const cv = $('#sig');
  const ctx = cv.getContext('2d');
  let drawing = false, last = null, length = 0;
  const size = () => {
    const r = cv.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const data = S.sigDirty ? cv.toDataURL() : null;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0A100D';
    if (data) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, r.width, r.height); img.src = data; }
  };
  S.sizeSig = size;
  window.addEventListener('resize', size);
  const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  cv.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); cv.setPointerCapture(e.pointerId); e.preventDefault(); });
  cv.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    length += Math.hypot(p.x - last.x, p.y - last.y);
    last = p;
    if (length > 40 && !S.sigDirty) { S.sigDirty = true; $('#sig-ph').hidden = true; setErr('signature', ''); update(); }
  });
  const end = () => { drawing = false; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end); cv.addEventListener('pointerleave', end);
  $('#sig-clear').addEventListener('click', () => {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.restore();
    S.sigDirty = false; length = 0; $('#sig-ph').hidden = false; update();
  });
}

function signatureBlob() {
  return new Promise((res) => $('#sig').toBlob(res, 'image/png'));
}

/* ---------------- draft ---------------- */
function restoreDraft() {
  const d = store.get('ct_draft');
  if (!d) { renderRiders(); return; }
  for (const k of DRAFT_FIELDS) if (d[k] && $('#' + k) && k !== 'id_type') $('#' + k).value = d[k];
  const urlVehicle = new URLSearchParams(location.search).get('vehicle');
  if (!urlVehicle && d.cart && typeof d.cart === 'object') {
    for (const [id, q] of Object.entries(d.cart)) if (S.vehicles.some((v) => v.id === id) && q > 0) S.cart[id] = Math.min(S.max, Math.floor(q));
  }
  if (Array.isArray(d.riders)) S.riders = d.riders.map((r) => ({ name: r.name || '', phone: r.phone || '', licence_no: r.licence_no || '' }));
  if (d.handover) { const r = $(`input[name="handover"][value="${d.handover}"]`); if (r) r.checked = true; }
  if (d.return_mode) { const r = $(`input[name="return_mode"][value="${d.return_mode}"]`); if (r) r.checked = true; }
  S.syncHandover();
  renderVehicles();
  renderRiders();
}

let draftTimer = 0;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const d = {};
    for (const k of DRAFT_FIELDS) if ($('#' + k)) d[k] = $('#' + k).value;
    d.cart = S.cart; d.riders = S.riders; d.handover = radio('handover'); d.return_mode = radio('return_mode');
    store.set('ct_draft', d);
  }, 400);
}

/* ---------------- state → UI ---------------- */
function onAnyChange(e) {
  const id = e.target.id;
  if (id === 'start-time' || id === 'end-time') { paintRange(); renderPresets(); scheduleAvailability(); }
  if (e.target.id && $(`[data-err="${e.target.id}"]`)) setErr(e.target.id, '');
  if (e.target.dataset.consent) setErr('consents', '');
  saveDraft();
  update();
}

function currentQuote() {
  return quote({
    items: cartItems(), start: startVal(), end: endVal(), guide: $('#guide').checked,
    delivery: radio('handover') === 'delivery', collection: radio('return_mode') === 'collection', settings: S.cfg.settings,
  });
}

function update() {
  if (!S.cfg) return;
  const items = cartItems();
  const q = currentQuote();
  const s = startVal(), e = endVal();
  const days = rentalDays(s, e);

  const banner = $('#duration-hint');
  if (days >= 3) {
    const save = items.length ? q.savings : 0;
    banner.hidden = false;
    banner.innerHTML = days >= 7
      ? `<b>${days} days · weekly rate.</b> Scooties work out to ${inr(perDay(minRate(), days))} a day instead of ${inr(minRate())}${save ? ` — you save <em>${inr(save)}</em>` : ''}.`
      : `<b>${days} days · 10% off every day.</b>${save ? ` You save <em>${inr(save)}</em>.` : ''} Make it a week for the weekly rate.`;
  } else banner.hidden = true;

  const one = items[0]?.vehicle;
  $('#sum-img').innerHTML = items.length === 1 ? `<img src="${esc(one.image)}" alt="">`
    : items.length > 1 ? `<div class="sum-stack">${items.slice(0, 3).map((i) => `<img src="${esc(i.vehicle.image)}" alt="">`).join('')}</div>` : '';
  const count = cartCount();
  $('#sum-cat').textContent = count > 1 ? `${count} vehicles` : one ? one.category : 'Your ride';
  $('#sum-name').textContent = items.length ? itemsSummary(q.items) + ($('#guide').checked ? ' + guide' : '') : 'Choose your ride';
  $('#sum-dates').innerHTML = s && e ? `${esc(fmtWhen(s))} <span>→</span> ${esc(fmtWhen(e))}` : '';
  const hand = radio('handover') === 'delivery' ? 'Delivered to you' : 'Pick up at Nongrim Hills';
  const ret = radio('return_mode') === 'collection' ? 'collected from you' : 'return to counter';
  $('#sum-hand').textContent = `${hand} · ${ret}`;
  $('#sum-lines').innerHTML = items.length ? q.lines.map((l) => `<li><span>${esc(l.label)}</span><b>${inr(l.amount)}</b></li>`).join('')
    + (q.savings > 0 ? `<li class="save"><span>You save</span><b>${inr(q.savings)}</b></li>` : '') : '';
  $('#sum-total').textContent = inr(items.length ? q.total : 0);
  $('#sum-dep').textContent = items.length ? `+ ${inr(q.deposit)} refundable deposit, ${S.cfg.settings.pay_mode === 'rent_deposit' ? 'paid now' : 'paid at handover'}` : '';
  $('#bar-total').textContent = inr(items.length ? q.total : 0);
  $('#bar-days').textContent = items.length && days ? `· ${count > 1 ? count + ' vehicles · ' : ''}${days} day${days > 1 ? 's' : ''}` : '';
  if (S.step === 5) renderPay();
}

/* ---------------- steps ---------------- */
function show(n) {
  S.step = n;
  S.maxStep = Math.max(S.maxStep, n);
  $$('.bk-step').forEach((el) => { el.hidden = Number(el.dataset.step) !== n; });
  $$('#steps li').forEach((li) => {
    const i = Number(li.dataset.step);
    li.classList.toggle('is-on', i === n);
    li.classList.toggle('is-done', i < n || (i <= S.maxStep && i !== n));
  });
  $('#back').style.visibility = n === 0 ? 'hidden' : 'visible';
  const label = n === STEPS - 1 ? 'Confirm booking' : 'Continue';
  $('#next').textContent = label; $('#bar-next').textContent = label;
  if (n === 0) requestAnimationFrame(renderCalendar);
  if (n === 3) renderRiders();
  if (n === 4) requestAnimationFrame(() => S.sizeSig());
  if (n === 5) { renderReview(); renderPay(); }
  update();
}

function bindNav() {
  $('#next').addEventListener('click', next);
  $('#bar-next').addEventListener('click', next);
  $('#back').addEventListener('click', () => { if (S.step > 0) { show(S.step - 1); scrollToFlow(); } });
  $$('#steps li').forEach((li) => li.addEventListener('click', () => {
    const i = Number(li.dataset.step);
    if (i < S.step || i <= S.maxStep) {
      for (let k = 0; k < i; k++) if (!validate(k)) { show(k); scrollToFlow(); return; }
      show(i); scrollToFlow();
    }
  }));
  $('#copy-upi').addEventListener('click', () => copy(S.cfg.settings.upi_id, $('#copy-upi')));
}

function scrollToFlow() {
  const top = $('.bk-flow').getBoundingClientRect().top + window.scrollY - 90;
  if (window.scrollY > top) window.scrollTo({ top, behavior: 'smooth' });
}

async function next() {
  if (S.submitting) return;
  if (!validate(S.step)) {
    const first = $$('.bk-step:not([hidden]) .err').find((x) => x.textContent);
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (S.step < STEPS - 1) { show(S.step + 1); scrollToFlow(); return; }
  submit();
}

function setErr(k, msg) {
  $$(`[data-err="${k}"]`).forEach((el) => { el.textContent = msg || ''; });
  const input = document.getElementById(k);
  if (input) input.classList.toggle('invalid', Boolean(msg));
  const up = $(`.up[data-kind="${k}"]`);
  if (up) up.classList.toggle('invalid', Boolean(msg));
  const dp = $(`.dpick[data-for="${k}"]`);
  if (dp) dp.classList.toggle('invalid', Boolean(msg));
}

function val(id) { return ($('#' + id)?.value || '').trim(); }
function phoneOk(v) {
  const d = v.replace(/\D/g, '');
  return (d.length === 10 && /^[6-9]/.test(d)) || (d.length === 12 && d.startsWith('91')) || (v.trim().startsWith('+') && d.length >= 8 && d.length <= 15);
}
const LICENCE = /^[A-Z0-9][A-Z0-9 \-\/]{6,22}$/;

function paymentRequired() {
  return S.cfg.settings.upi_ready && currentQuote().pay_now > 0;
}

function validate(step) {
  const errs = {};
  let keys = [];
  if (step === 0) {
    keys = ['start', 'end', 'vehicle'];
    const s = startVal(), e = endVal();
    if (!s) errs.start = 'Pick your pick-up date on the calendar.';
    if (!$('#end-date').value) errs.end = 'Pick your return date on the calendar.';
    else if (s && e && parseLocal(e) <= parseLocal(s)) errs.end = 'Return must be after the pick-up.';
    if (S.availErrors) Object.assign(errs, S.availErrors);
    if (!cartCount()) errs.vehicle = 'Add at least one vehicle.';
    else for (const { vehicle: v, qty } of cartItems()) if (S.avail[v.id] != null && qty > S.avail[v.id]) errs.vehicle = `Only ${S.avail[v.id]} ${v.name} free for these dates.`;
  }
  if (step === 1) {
    keys = ['handover_address', 'return_address'];
    if (radio('handover') === 'delivery' && val('handover_address').length < 8) errs.handover_address = 'Enter the delivery address in Shillong.';
    const same = radio('handover') === 'delivery' && $('#same-address').checked;
    if (radio('return_mode') === 'collection' && !same && val('return_address').length < 8) errs.return_address = 'Enter where we should collect the vehicles.';
  }
  if (step === 2) {
    keys = ['name', 'dob', 'phone', 'email', 'address', 'emergency_name', 'emergency_phone'];
    if (val('name').length < 3) errs.name = 'Enter your full name as on your licence.';
    const dob = val('dob');
    if (!dob) errs.dob = 'Enter your date of birth.';
    else {
      const t = today();
      const age = Number(t.slice(0, 4)) - Number(dob.slice(0, 4)) - (t.slice(5) < dob.slice(5) ? 1 : 0);
      if (age < 18) errs.dob = 'Riders must be 18 or older.';
      else if (age > 100) errs.dob = 'Check your date of birth.';
    }
    if (!phoneOk(val('phone'))) errs.phone = 'Enter a valid 10-digit mobile number.';
    if (val('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val('email'))) errs.email = 'That email doesn\'t look right.';
    if (val('address').length < 8) errs.address = 'Enter your permanent address.';
    if (val('emergency_name').length < 2) errs.emergency_name = 'Add an emergency contact.';
    if (!phoneOk(val('emergency_phone'))) errs.emergency_phone = 'Enter a valid number for your emergency contact.';
    else if (val('emergency_phone').replace(/\D/g, '').slice(-10) === val('phone').replace(/\D/g, '').slice(-10)) errs.emergency_phone = 'Use someone other than yourself.';
  }
  if (step === 3) {
    keys = ['licence_no', 'licence_expiry', 'id_type', 'licence_front', 'licence_back', 'id_front', 'selfie'];
    if (!LICENCE.test(val('licence_no').toUpperCase())) errs.licence_no = 'Enter your driving licence number.';
    const exp = val('licence_expiry');
    if (!exp) errs.licence_expiry = 'Enter the licence validity date.';
    else if (exp < endVal().slice(0, 10)) errs.licence_expiry = 'Your licence must be valid for the whole rental.';
    if (!val('id_type')) errs.id_type = 'Choose the ID you are uploading.';
    for (const k of ['licence_front', 'licence_back', 'id_front', 'selfie']) if (!S.files[k]) errs[k] = k === 'selfie' ? 'Add a photo of yourself.' : `Upload the ${DOCS[k].label.toLowerCase().replace(' — ', ' ')}.`;
    const need = Math.max(0, cartCount() - 1);
    const seen = new Set([val('licence_no').toUpperCase().replace(/\s+/g, ' ')]);
    for (let n = 1; n <= need; n++) {
      const r = S.riders[n - 1] || {};
      keys.push(`rider${n}_name`, `rider${n}_phone`, `rider${n}_licence_no`, `rider${n}_licence`);
      if ((r.name || '').trim().length < 3) errs[`rider${n}_name`] = 'Enter this rider\'s full name.';
      if ((r.phone || '').trim() && !phoneOk(r.phone)) errs[`rider${n}_phone`] = 'Enter a valid mobile number.';
      const lic = (r.licence_no || '').toUpperCase().replace(/\s+/g, ' ').trim();
      if (!LICENCE.test(lic)) errs[`rider${n}_licence_no`] = 'Enter this rider\'s licence number.';
      else if (seen.has(lic)) errs[`rider${n}_licence_no`] = 'Each vehicle needs a different licensed rider.';
      seen.add(lic);
      if (!S.files[`rider${n}_licence`]) errs[`rider${n}_licence`] = 'Upload a photo of this rider\'s licence.';
    }
  }
  if (step === 4) {
    keys = ['consents', 'consent_name', 'signature'];
    if ($$('[data-consent]').some((c) => !c.checked)) errs.consents = 'Please tick every box to agree.';
    const norm = (x) => x.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!val('consent_name')) errs.consent_name = 'Type your full name to sign.';
    else if (norm(val('consent_name')) !== norm(val('name'))) errs.consent_name = `Type your name exactly as entered: ${val('name')}`;
    if (!S.sigDirty) errs.signature = 'Please sign in the box.';
  }
  if (step === 5) {
    keys = ['payment', 'upi_utr'];
    if (paymentRequired() && !S.files.payment) errs.payment = 'Upload the screenshot of your UPI payment.';
    const utr = val('upi_utr').replace(/\s+/g, '');
    if (utr && !/^[A-Za-z0-9]{6,40}$/.test(utr)) errs.upi_utr = 'The UPI reference is usually a 12-digit number.';
  }
  for (const k of keys) setErr(k, errs[k] || '');
  for (const k of Object.keys(errs)) if (!keys.includes(k)) setErr(k, errs[k]);
  return Object.keys(errs).length === 0;
}

/* ---------------- review & pay ---------------- */
function renderReview() {
  const q = currentQuote();
  const del = radio('handover') === 'delivery';
  const col = radio('return_mode') === 'collection';
  const same = del && $('#same-address').checked;
  const need = Math.max(0, cartCount() - 1);
  const row = (k, v2, step) => `<div class="rv-row"><span>${k}</span><b>${v2}</b>${step != null ? `<button type="button" class="link-btn" data-goto="${step}">Edit</button>` : ''}</div>`;
  $('#review').innerHTML =
    row(cartCount() > 1 ? 'Rides' : 'Ride', esc(itemsSummary(q.items)) + ($('#guide').checked ? ' + local guide' : ''), 0) +
    row('Dates', `${esc(fmtWhen(startVal()))} → ${esc(fmtWhen(endVal()))} · ${q.days} day${q.days > 1 ? 's' : ''}`, 0) +
    row('Handover', del ? 'Delivered to ' + esc(val('handover_address')) : 'Pick up at our Nongrim Hills counter', 1) +
    row('Return', col ? 'Collected from ' + esc(same ? val('handover_address') : val('return_address')) : 'Return to the counter', 1) +
    row(need ? 'Lead rider' : 'Rider', `${esc(val('name'))} · ${esc(val('phone'))}`, 2) +
    (need ? row('Other riders', S.riders.slice(0, need).map((r) => esc(r.name)).join(', '), 3) : '') +
    row('Documents', `Licence ${esc(val('licence_no').toUpperCase())} · ${esc(val('id_type'))} · selfie${need ? ` · ${need} more licence${need > 1 ? 's' : ''}` : ''}`, 3) +
    `<ul class="rv-lines">${q.lines.map((l) => `<li><span>${esc(l.label)}</span><b>${inr(l.amount)}</b></li>`).join('')}
      ${q.savings > 0 ? `<li class="save"><span>You save</span><b>${inr(q.savings)}</b></li>` : ''}
      <li class="tot"><span>Rental total</span><b>${inr(q.total)}</b></li>
      <li><span>Refundable deposit${S.cfg.settings.pay_mode === 'rent_deposit' ? '' : ' (at handover)'}</span><b>${inr(q.deposit)}</b></li></ul>`;
  $$('[data-goto]', $('#review')).forEach((b) => b.addEventListener('click', () => { show(Number(b.dataset.goto)); scrollToFlow(); }));
}

let qrText = '';
function renderPay() {
  const st = S.cfg.settings;
  const q = currentQuote();
  const upi = st.upi_ready && q.pay_now > 0;
  $('#pay-upi').hidden = !upi;
  $('#pay-later').hidden = upi;
  if (!upi) {
    $('#pay-later-msg').textContent = q.pay_now > 0
      ? `We'll confirm your booking and share payment details on WhatsApp. Pay ${inr(q.total)} plus the ${inr(q.deposit)} refundable deposit at handover, by UPI or cash.`
      : `Pay ${inr(q.total)} plus the ${inr(q.deposit)} refundable deposit at handover, by UPI or cash.`;
    return;
  }
  $('#pay-amount').textContent = inr(q.pay_now);
  $('#pay-explain').textContent = {
    rent: `This covers your rental. The ${inr(q.deposit)} refundable deposit is paid at handover.`,
    rent_deposit: `This covers your rental and the ${inr(q.deposit)} refundable deposit.`,
    advance: `Advance to hold your booking. The remaining ${inr(q.pay_later)} (including the ${inr(q.deposit)} refundable deposit) is paid at handover.`,
  }[st.pay_mode] || '';
  $('#upi-id-row').hidden = !st.upi_id;
  $('#upi-id').textContent = st.upi_id;
  const note = `Cloud Trails ${val('name').split(' ')[0] || ''} ${val('phone').replace(/\D/g, '').slice(-4)}`.replace(/\s+/g, ' ').trim();
  const link = st.upi_id ? `upi://pay?pa=${encodeURIComponent(st.upi_id)}&pn=${encodeURIComponent(st.upi_payee || 'Cloud Trails')}&am=${q.pay_now}.00&cu=INR&tn=${encodeURIComponent(note)}` : '';
  $('#upi-link').hidden = !link || !/Android|iPhone|iPad/i.test(navigator.userAgent);
  $('#upi-link').href = link || '#';
  if (link && link !== qrText) {
    qrText = link;
    drawQr(link).then(() => {
      $('.pay-qr').hidden = false;
      $('#qr-note').textContent = `Scan with any UPI app — ${inr(q.pay_now)} is filled in for you`;
    }).catch(() => showStaticQr());
  } else if (!link) {
    showStaticQr();
  }
}

function showStaticQr() {
  const st = S.cfg.settings;
  $('.pay-qr').hidden = !st.has_qr;
  $('#qr').innerHTML = st.has_qr ? `<img src="${API}/api/qr" alt="UPI QR code for Cloud Trails">` : '';
  $('#qr-note').textContent = `Scan with any UPI app and enter ${inr(currentQuote().pay_now)}`;
}

let qrLib = null;
function loadQrLib() {
  if (window.QRCode) return Promise.resolve();
  if (!qrLib) qrLib = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = () => (window.QRCode ? res() : rej(new Error('no QR')));
    s.onerror = () => { qrLib = null; rej(new Error('QR library failed to load')); };
    document.head.appendChild(s);
  });
  return qrLib;
}

async function drawQr(text) {
  await loadQrLib();
  const box = $('#qr');
  box.innerHTML = '';
  new window.QRCode(box, { text, width: 196, height: 196, colorDark: '#0A100D', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
}

function copy(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1500); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
}

/* ---------------- submit ---------------- */
async function submit() {
  S.submitting = true;
  $('#submit-error').textContent = '';
  const del = radio('handover') === 'delivery';
  const same = del && $('#same-address').checked;
  const consents = Object.fromEntries($$('[data-consent]').map((c) => [c.dataset.consent, c.checked]));
  const need = Math.max(0, cartCount() - 1);
  const data = {
    items: cartItems().map((i) => ({ vehicle_id: i.vehicle.id, qty: i.qty })),
    riders: S.riders.slice(0, need),
    start: startVal(), end: endVal(), guide: $('#guide').checked,
    handover: radio('handover'), handover_address: val('handover_address'), handover_landmark: val('handover_landmark'),
    return_mode: radio('return_mode'), return_address: same ? val('handover_address') : val('return_address'),
    name: val('name'), phone: val('phone'), email: val('email'), dob: val('dob'), address: val('address'), hometown: val('hometown'),
    emergency_name: val('emergency_name'), emergency_phone: val('emergency_phone'), pillion_name: val('pillion_name'), notes: val('notes'),
    licence_no: val('licence_no'), licence_expiry: val('licence_expiry'), id_type: val('id_type'),
    upi_utr: val('upi_utr'), consents, consent_name: val('consent_name'), terms_version: S.cfg.terms.version,
    selfie_source: S.selfieSource === 'camera' ? 'camera' : 'upload',
  };
  const fd = new FormData();
  fd.set('data', JSON.stringify(data));
  for (const [k, b] of Object.entries(S.files)) {
    if (k === 'payment' && $('#pay-upi').hidden) continue;
    const m = /^rider(\d+)_licence$/.exec(k);
    if (m && Number(m[1]) > need) continue;
    fd.set(k, b, b.name || k);
  }
  fd.set('signature', await signatureBlob(), 'signature.png');

  $('#overlay').hidden = false;
  $('#progress').style.width = '4%';
  let res;
  try {
    res = await send(fd, (p) => { $('#progress').style.width = Math.max(4, Math.round(p * 92)) + '%'; });
  } catch {
    res = { status: 0, body: { error: 'Network problem — check your connection and try again.' } };
  }
  $('#progress').style.width = '100%';
  S.submitting = false;
  setTimeout(() => { $('#overlay').hidden = true; }, 200);

  if (res.status === 201 && res.body.ref) return done(res.body);
  const errs = res.body.errors || {};
  const steps = Object.keys(errs).map(stepOf).filter((x) => x != null);
  if (steps.length) {
    const s = Math.min(...steps);
    if (s !== S.step) { show(s); scrollToFlow(); }
  }
  for (const [k, m] of Object.entries(errs)) setErr(k, m);
  $('#submit-error').textContent = res.body.error || 'Something went wrong. Please try again.';
  if (res.status === 409) refreshAvailability();
}

function send(fd, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', API + '/api/bookings');
    x.responseType = 'json';
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => resolve({ status: x.status, body: x.response || {} });
    x.onerror = () => reject(new Error('network'));
    x.send(fd);
  });
}

function done(r) {
  const link = new URL(`track.html?ref=${encodeURIComponent(r.ref)}&t=${encodeURIComponent(r.token)}`, location.href).href;
  const summary = itemsSummary(currentQuote().items);
  const list = store.get('ct_bookings') || [];
  list.unshift({ ref: r.ref, token: r.token, vehicle: summary, start: startVal(), at: Date.now() });
  store.set('ct_bookings', list.slice(0, 10));
  store.del('ct_draft');
  $('#app').hidden = true; $('#bar').hidden = true; $('.bk-intro').hidden = true;
  $('#done').hidden = false;
  $('#done-name').textContent = val('name').split(' ')[0];
  $('#done-ref').textContent = r.ref;
  $('#done-track').href = link;
  $('#done-link').href = link; $('#done-link').textContent = link;
  const msg = `Hi Cloud Trails! I just booked online.\nRef: ${r.ref}\n${summary}, ${fmtWhen(startVal())} → ${fmtWhen(endVal())}\nName: ${val('name')}`;
  $('#done-wa').href = `https://wa.me/${S.cfg.settings.whatsapp}?text=${encodeURIComponent(msg)}`;
  $('#copy-link').addEventListener('click', () => copy(link, $('#copy-link')));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

boot();
