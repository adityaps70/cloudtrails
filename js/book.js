// Cloud Trails — online booking flow (book.html).
import { quote, inr, rentalDays, nowIST, parseLocal } from './pricing.js';

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
const FIELD_STEP = {
  start: 0, end: 0, vehicle: 0,
  handover_address: 1, return_address: 1,
  name: 2, phone: 2, email: 2, dob: 2, address: 2, emergency_name: 2, emergency_phone: 2,
  licence_no: 3, licence_expiry: 3, id_type: 3, licence_front: 3, licence_back: 3, id_front: 3, id_back: 3, selfie: 3,
  consents: 4, consent_name: 4, signature: 4, terms: 4,
  payment: 5, upi_utr: 5,
};
const DRAFT_FIELDS = ['name', 'dob', 'phone', 'email', 'address', 'hometown', 'pillion_name', 'emergency_name', 'emergency_phone', 'notes',
  'licence_no', 'licence_expiry', 'id_type', 'handover_address', 'handover_landmark', 'return_address'];

const S = {
  cfg: null, vehicles: [], avail: {}, availOk: true, step: 0, maxStep: 0,
  files: {}, sigDirty: false, vehicleId: '', submitting: false,
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
  const st = cfg.settings;
  const wa = 'https://wa.me/' + st.whatsapp;
  $('#top-wa').href = wa;
  if (st.booking_enabled !== '1') return offline('Online booking is paused right now. Message us on WhatsApp and we\'ll sort you out quickly.');

  $('#app').hidden = false;
  $('#bar').hidden = false;
  setupTimes();
  setupDates();
  renderVehicles();
  setupHandover();
  setupDocs();
  setupTerms();
  setupSignature();
  restoreDraft();
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

function addDays(date, n) {
  return new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
}

function setupDates() {
  const today = (S.cfg.now || nowIST()).slice(0, 10);
  const p = new URLSearchParams(location.search);
  const qs = p.get('start'), qe = p.get('end');
  const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && d >= today;
  const sd = okDate(qs) ? qs : addDays(today, 1);
  const ed = okDate(qe) && qe > sd ? qe : addDays(sd, 1);
  $('#start-date').min = today;
  $('#end-date').min = today;
  $('#start-date').value = sd;
  $('#end-date').value = ed;
  $('#start-time').value = '10:00';
  $('#end-time').value = '10:00';
  $('#start-date').addEventListener('change', () => {
    const s = $('#start-date').value;
    if (s && $('#end-date').value <= s) $('#end-date').value = addDays(s, 1);
    $('#end-date').min = s || today;
  });
  const v = p.get('vehicle');
  if (v && S.vehicles.some((x) => x.id === v)) S.vehicleId = v;
  if (p.get('guide') === '1') $('#guide').checked = true;
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

let availTimer = 0, availSeq = 0;
async function refreshAvailability() {
  const s = startVal(), e = endVal();
  if (!s || !e || parseLocal(e) <= parseLocal(s)) { S.avail = {}; renderVehicles(); return; }
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
  renderVehicles();
  update();
}

/* ---------------- vehicles ---------------- */
function renderVehicles() {
  const box = $('#vehicles');
  const known = Object.keys(S.avail).length > 0;
  box.innerHTML = S.vehicles.map((v) => {
    const left = S.avail[v.id];
    const out = known && left === 0;
    const badge = !known ? '' : out ? '<span class="badge out">Booked out</span>' : left <= 2 ? `<span class="badge low">Only ${left} left</span>` : '<span class="badge ok">Available</span>';
    return `<label class="veh${out ? ' is-out' : ''}${S.vehicleId === v.id ? ' is-on' : ''}">
      <input type="radio" name="vehicle" value="${esc(v.id)}" ${S.vehicleId === v.id ? 'checked' : ''} ${out ? 'disabled' : ''}>
      <span class="veh-img">${v.image ? `<img src="${esc(v.image)}" alt="" loading="lazy">` : ''}${badge}</span>
      <span class="veh-body"><span class="veh-cat">${esc(v.category)}</span><span class="veh-name font-display">${esc(v.name)}</span>
      <span class="veh-price"><b>${inr(v.day_rate)}</b> / day <i>· deposit ${inr(v.deposit)}</i></span></span>
    </label>`;
  }).join('');
  $$('input[name="vehicle"]', box).forEach((i) => i.addEventListener('change', () => { S.vehicleId = i.value; setErr('vehicle', ''); renderVehicles(); update(); }));
}

function vehicle() { return S.vehicles.find((v) => v.id === S.vehicleId) || null; }

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

/* ---------------- documents ---------------- */
function setupDocs() {
  $$('.up').forEach((el) => {
    const kind = el.dataset.kind;
    const d = DOCS[kind];
    el.innerHTML = `
      <span class="up-label">${esc(d.label)}${d.required ? '' : ' <i>(optional)</i>'}</span>
      <label class="up-zone" tabindex="0">
        <input type="file" accept="${kind === 'selfie' ? 'image/*' : 'image/*,application/pdf'}" ${d.camera ? 'capture="user"' : ''} data-kind="${kind}">
        <span class="up-empty"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 16V4m0 0 4 4m-4-4L8 8"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>
          <span>${d.camera ? 'Take or upload a photo' : 'Tap to upload'}</span>${d.note ? `<small>${esc(d.note)}</small>` : ''}</span>
        <span class="up-preview" hidden></span>
      </label>
      <p class="err" data-err="${kind}"></p>`;
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
      renderPreview(el, kind);
      update();
    });
    $('.up-zone', el).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  });
}

function renderPreview(el, kind) {
  const blob = S.files[kind];
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
  if (!d) return;
  for (const k of DRAFT_FIELDS) if (d[k] && $('#' + k) && k !== 'id_type') $('#' + k).value = d[k];
  if (!S.vehicleId && d.vehicle_id && S.vehicles.some((v) => v.id === d.vehicle_id)) S.vehicleId = d.vehicle_id;
  if (d.handover) { const r = $(`input[name="handover"][value="${d.handover}"]`); if (r) r.checked = true; }
  if (d.return_mode) { const r = $(`input[name="return_mode"][value="${d.return_mode}"]`); if (r) r.checked = true; }
  S.syncHandover();
}

let draftTimer = 0;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const d = {};
    for (const k of DRAFT_FIELDS) if ($('#' + k)) d[k] = $('#' + k).value;
    d.vehicle_id = S.vehicleId; d.handover = radio('handover'); d.return_mode = radio('return_mode');
    store.set('ct_draft', d);
  }, 400);
}

/* ---------------- state → UI ---------------- */
function onAnyChange(e) {
  const id = e.target.id;
  if (['start-date', 'start-time', 'end-date', 'end-time'].includes(id)) {
    clearTimeout(availTimer);
    availTimer = setTimeout(refreshAvailability, 250);
  }
  if (e.target.id && $(`[data-err="${e.target.id}"]`)) setErr(e.target.id, '');
  if (e.target.dataset.consent) setErr('consents', '');
  saveDraft();
  update();
}

function currentQuote() {
  const v = vehicle();
  return quote({
    vehicle: v || { day_rate: 0, deposit: 0, name: '' }, start: startVal(), end: endVal(), guide: $('#guide').checked,
    delivery: radio('handover') === 'delivery', collection: radio('return_mode') === 'collection', settings: S.cfg.settings,
  });
}

function update() {
  if (!S.cfg) return;
  const v = vehicle();
  const q = currentQuote();
  const s = startVal(), e = endVal();
  const days = rentalDays(s, e);
  $('#duration-hint').textContent = days ? `${days} day${days > 1 ? 's' : ''}${days >= 7 ? ' · weekly rate applies' : days >= 3 ? ' · 10% multi-day discount applies' : ''}` : '';

  $('#sum-img').innerHTML = v?.image ? `<img src="${esc(v.image)}" alt="">` : '';
  $('#sum-cat').textContent = v ? v.category : 'Your ride';
  $('#sum-name').textContent = v ? v.name + ($('#guide').checked ? ' + guide' : '') : 'Choose a vehicle';
  $('#sum-dates').innerHTML = s && e ? `${esc(fmtWhen(s))} <span>→</span> ${esc(fmtWhen(e))}` : '';
  const hand = radio('handover') === 'delivery' ? 'Delivered to you' : 'Pick up at Nongrim Hills';
  const ret = radio('return_mode') === 'collection' ? 'collected from you' : 'return to counter';
  $('#sum-hand').textContent = `${hand} · ${ret}`;
  $('#sum-lines').innerHTML = v ? q.lines.map((l) => `<li><span>${esc(l.label)}</span><b>${inr(l.amount)}</b></li>`).join('') : '';
  $('#sum-total').textContent = inr(v ? q.total : 0);
  $('#sum-dep').textContent = v ? `+ ${inr(q.deposit)} refundable deposit, paid at handover` : '';
  if (v && S.cfg.settings.pay_mode === 'rent_deposit') $('#sum-dep').textContent = `+ ${inr(q.deposit)} refundable deposit, paid now`;
  $('#bar-total').textContent = inr(v ? q.total : 0);
  $('#bar-days').textContent = v && days ? `· ${days} day${days > 1 ? 's' : ''}` : '';
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
}

function val(id) { return ($('#' + id)?.value || '').trim(); }
function phoneOk(v) {
  const d = v.replace(/\D/g, '');
  return (d.length === 10 && /^[6-9]/.test(d)) || (d.length === 12 && d.startsWith('91')) || (v.trim().startsWith('+') && d.length >= 8 && d.length <= 15);
}

function paymentRequired() {
  const st = S.cfg.settings;
  return st.upi_ready && currentQuote().pay_now > 0;
}

function validate(step) {
  const errs = {};
  const st = S.cfg.settings;
  if (step === 0) {
    const s = startVal(), e = endVal();
    if (!s) errs.start = 'Pick a start date and time.';
    if (!e) errs.end = 'Pick a return date and time.';
    if (s && e && parseLocal(e) <= parseLocal(s)) errs.end = 'Return must be after the start.';
    if (S.availErrors) Object.assign(errs, S.availErrors);
    if (!S.vehicleId) errs.vehicle = 'Choose a vehicle.';
    else if (S.avail[S.vehicleId] === 0) errs.vehicle = 'That vehicle is booked out for these dates — pick another.';
  }
  if (step === 1) {
    if (radio('handover') === 'delivery' && val('handover_address').length < 8) errs.handover_address = 'Enter the delivery address in Shillong.';
    const same = radio('handover') === 'delivery' && $('#same-address').checked;
    if (radio('return_mode') === 'collection' && !same && val('return_address').length < 8) errs.return_address = 'Enter where we should collect the vehicle.';
  }
  if (step === 2) {
    if (val('name').length < 3) errs.name = 'Enter your full name as on your licence.';
    const dob = val('dob');
    if (!dob) errs.dob = 'Enter your date of birth.';
    else {
      const t = (S.cfg.now || nowIST()).slice(0, 10);
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
    if (!/^[A-Z0-9][A-Z0-9 \-\/]{6,22}$/.test(val('licence_no').toUpperCase())) errs.licence_no = 'Enter your driving licence number.';
    const exp = val('licence_expiry');
    if (!exp) errs.licence_expiry = 'Enter the licence validity date.';
    else if (exp < endVal().slice(0, 10)) errs.licence_expiry = 'Your licence must be valid for the whole rental.';
    if (!val('id_type')) errs.id_type = 'Choose the ID you are uploading.';
    for (const k of ['licence_front', 'licence_back', 'id_front', 'selfie']) if (!S.files[k]) errs[k] = k === 'selfie' ? 'Add a photo of yourself.' : `Upload the ${DOCS[k].label.toLowerCase().replace(' — ', ' ')}.`;
  }
  if (step === 4) {
    if ($$('[data-consent]').some((c) => !c.checked)) errs.consents = 'Please tick every box to agree.';
    const norm = (x) => x.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!val('consent_name')) errs.consent_name = 'Type your full name to sign.';
    else if (norm(val('consent_name')) !== norm(val('name'))) errs.consent_name = `Type your name exactly as entered: ${val('name')}`;
    if (!S.sigDirty) errs.signature = 'Please sign in the box.';
  }
  if (step === 5) {
    if (paymentRequired() && !S.files.payment) errs.payment = 'Upload the screenshot of your UPI payment.';
    const utr = val('upi_utr').replace(/\s+/g, '');
    if (utr && !/^[A-Za-z0-9]{6,40}$/.test(utr)) errs.upi_utr = 'The UPI reference is usually a 12-digit number.';
  }
  const keys = { 0: ['start', 'end', 'vehicle'], 1: ['handover_address', 'return_address'], 2: ['name', 'dob', 'phone', 'email', 'address', 'emergency_name', 'emergency_phone'],
    3: ['licence_no', 'licence_expiry', 'id_type', 'licence_front', 'licence_back', 'id_front', 'selfie'], 4: ['consents', 'consent_name', 'signature'], 5: ['payment', 'upi_utr'] }[step];
  for (const k of keys) setErr(k, errs[k] || '');
  return Object.keys(errs).length === 0;
}

/* ---------------- review & pay ---------------- */
function renderReview() {
  const v = vehicle();
  const q = currentQuote();
  const del = radio('handover') === 'delivery';
  const col = radio('return_mode') === 'collection';
  const same = del && $('#same-address').checked;
  const row = (k, v2, step) => `<div class="rv-row"><span>${k}</span><b>${v2}</b>${step != null ? `<button type="button" class="link-btn" data-goto="${step}">Edit</button>` : ''}</div>`;
  $('#review').innerHTML =
    row('Ride', esc(v.name) + ($('#guide').checked ? ' + local guide' : ''), 0) +
    row('Dates', `${esc(fmtWhen(startVal()))} → ${esc(fmtWhen(endVal()))} · ${q.days} day${q.days > 1 ? 's' : ''}`, 0) +
    row('Handover', del ? 'Delivered to ' + esc(val('handover_address')) : 'Pick up at our Nongrim Hills counter', 1) +
    row('Return', col ? 'Collected from ' + esc(same ? val('handover_address') : val('return_address')) : 'Return to the counter', 1) +
    row('Rider', `${esc(val('name'))} · ${esc(val('phone'))}`, 2) +
    row('Documents', `Licence ${esc(val('licence_no').toUpperCase())} · ${esc(val('id_type'))} · selfie`, 3) +
    `<ul class="rv-lines">${q.lines.map((l) => `<li><span>${esc(l.label)}</span><b>${inr(l.amount)}</b></li>`).join('')}
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
    advance: `Advance to hold your ride. The remaining ${inr(q.pay_later)} (including the ${inr(q.deposit)} refundable deposit) is paid at handover.`,
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
  const data = {
    vehicle_id: S.vehicleId, start: startVal(), end: endVal(), guide: $('#guide').checked,
    handover: radio('handover'), handover_address: val('handover_address'), handover_landmark: val('handover_landmark'),
    return_mode: radio('return_mode'), return_address: same ? val('handover_address') : val('return_address'),
    name: val('name'), phone: val('phone'), email: val('email'), dob: val('dob'), address: val('address'), hometown: val('hometown'),
    emergency_name: val('emergency_name'), emergency_phone: val('emergency_phone'), pillion_name: val('pillion_name'), notes: val('notes'),
    licence_no: val('licence_no'), licence_expiry: val('licence_expiry'), id_type: val('id_type'),
    upi_utr: val('upi_utr'), consents, consent_name: val('consent_name'), terms_version: S.cfg.terms.version,
  };
  const fd = new FormData();
  fd.set('data', JSON.stringify(data));
  for (const [k, b] of Object.entries(S.files)) {
    if (k === 'payment' && $('#pay-upi').hidden) continue;
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
  for (const [k, m] of Object.entries(errs)) setErr(k, m);
  const steps = Object.keys(errs).map((k) => FIELD_STEP[k]).filter((x) => x != null);
  if (steps.length) {
    const s = Math.min(...steps);
    if (s !== S.step) { show(s); for (const [k, m] of Object.entries(errs)) setErr(k, m); scrollToFlow(); }
  }
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
  const list = store.get('ct_bookings') || [];
  list.unshift({ ref: r.ref, token: r.token, vehicle: vehicle()?.name, start: startVal(), at: Date.now() });
  store.set('ct_bookings', list.slice(0, 10));
  store.del('ct_draft');
  $('#app').hidden = true; $('#bar').hidden = true; $('.bk-intro').hidden = true;
  $('#done').hidden = false;
  $('#done-name').textContent = val('name').split(' ')[0];
  $('#done-ref').textContent = r.ref;
  $('#done-track').href = link;
  $('#done-link').href = link; $('#done-link').textContent = link;
  const msg = `Hi Cloud Trails! I just booked online.\nRef: ${r.ref}\n${vehicle()?.name}, ${fmtWhen(startVal())} → ${fmtWhen(endVal())}\nName: ${val('name')}`;
  $('#done-wa').href = `https://wa.me/${S.cfg.settings.whatsapp}?text=${encodeURIComponent(msg)}`;
  $('#copy-link').addEventListener('click', () => copy(link, $('#copy-link')));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

boot();
