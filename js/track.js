// Cloud Trails — booking status page (track.html).
import { inr, parseLocal } from './pricing.js';

const API = window.CT_API || '';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const p = new URLSearchParams(location.search);
const ref = (p.get('ref') || '').toUpperCase();
const token = p.get('t') || '';
const files = {};

const STATUS = {
  pending: ['Waiting for confirmation', 'We\'re checking your documents and payment'],
  confirmed: ['Confirmed', 'Your ride is booked'],
  ongoing: ['On the road', 'Enjoy the ride'],
  completed: ['Completed', 'Thanks for riding with us'],
  cancelled: ['Cancelled', 'This booking was cancelled'],
  rejected: ['Declined', 'We couldn\'t accept this booking'],
};

function fmtWhen(s) {
  const t = parseLocal(s);
  if (!isFinite(t)) return s || '';
  const d = new Date(t);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) + ', ' + d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

function list() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('ct_bookings') || '[]'); } catch {}
  $('#lookup').hidden = false;
  $('#saved').innerHTML = saved.length
    ? saved.map((b) => `<a href="track.html?ref=${encodeURIComponent(b.ref)}&t=${encodeURIComponent(b.token)}"><span><b>${esc(b.ref)}</b> · ${esc(b.vehicle || '')}</span><span class="hint" style="margin:0">${esc(fmtWhen(b.start))}</span></a>`).join('')
    : '<p class="hint" style="margin:0">No bookings saved on this device yet.</p>';
}

async function load() {
  $('#year').textContent = new Date().getFullYear();
  if (!ref || !token) return list();
  let r, j;
  try {
    r = await fetch(`${API}/api/bookings/${encodeURIComponent(ref)}?t=${encodeURIComponent(token)}`);
    j = await r.json();
  } catch { j = { error: 'We couldn\'t reach our booking system. Please try again in a minute.' }; }
  if (!r || !r.ok) {
    $('#t-error').hidden = false;
    $('#t-error-msg').textContent = j.error || 'Something went wrong.';
    return;
  }
  render(j);
}

function render(b) {
  const st = b.settings;
  $('#status').hidden = false;
  $('#t-ref').textContent = b.ref;
  const [label, title] = STATUS[b.status] || [b.status, ''];
  $('#t-title').textContent = `${title}, ${b.first_name}`;
  $('#t-status').textContent = label;
  $('#t-status').className = 'tr-status ' + b.status;
  $('#t-msg').hidden = !b.customer_message;
  $('#t-msg').textContent = b.customer_message || '';

  const docs = { submitted: ['warn', 'Being checked'], verified: ['ok', 'Verified'], reupload: ['bad', 'Re-upload needed'] }[b.docs_status] || ['warn', b.docs_status];
  const pay = { none: ['ok', 'Pay at handover'], awaiting: ['warn', 'Not received yet'], submitted: ['warn', 'Being checked'], verified: ['ok', 'Received' + (b.paid_amount ? ' · ' + inr(b.paid_amount) : '')], mismatch: ['bad', 'Needs attention'], refunded: ['ok', 'Refunded'] }[b.payment_status] || ['warn', b.payment_status];
  const veh = b.assigned_reg ? ['ok', b.assigned_reg] : ['warn', b.status === 'pending' ? 'Assigned on confirmation' : 'Assigned at handover'];
  $('#t-checks').innerHTML = [['Documents', docs], ['Payment', pay], ['Vehicle no.', veh]]
    .map(([k, [cls, v]]) => `<div class="tr-check ${cls}"><span>${k}</span><b>${esc(v)}</b></div>`).join('');

  const row = (k, v) => `<div class="rv-row" style="grid-template-columns:6.5rem 1fr"><span>${k}</span><b>${v}</b></div>`;
  $('#t-details').innerHTML =
    row('Ride', esc(b.vehicle_name) + (b.guide ? ' + local guide' : '')) +
    row('Dates', `${esc(fmtWhen(b.start))} → ${esc(fmtWhen(b.end))} · ${b.days} day${b.days > 1 ? 's' : ''}`) +
    row('Handover', b.handover === 'delivery' ? 'Delivered to ' + esc(b.handover_address) : 'Pick up at ' + esc(st.counter_address)) +
    row('Return', b.return_mode === 'collection' ? 'Collected from ' + esc(b.return_address) : 'Return to the counter') +
    `<ul class="rv-lines">
      <li><span>Rent</span><b>${inr(b.rent)}</b></li>
      ${b.guide_fee ? `<li><span>Guide</span><b>${inr(b.guide_fee)}</b></li>` : ''}
      ${b.delivery_fee ? `<li><span>Doorstep delivery</span><b>${inr(b.delivery_fee)}</b></li>` : ''}
      ${b.collection_fee ? `<li><span>Doorstep collection</span><b>${inr(b.collection_fee)}</b></li>` : ''}
      <li class="tot"><span>Rental total</span><b>${inr(b.total)}</b></li>
      <li><span>Refundable deposit</span><b>${inr(b.deposit)}</b></li></ul>`;

  $('#t-timeline').innerHTML = b.timeline.slice().reverse().map((e) =>
    `<li>${esc(e.label)}<time>${esc(new Date(e.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }))}</time></li>`).join('');

  const wa = `https://wa.me/${st.whatsapp}?text=${encodeURIComponent(`Hi Cloud Trails! About my booking ${b.ref}: `)}`;
  $('#t-wa').href = wa; $('#top-wa').href = 'https://wa.me/' + st.whatsapp;

  const kinds = [...b.reupload_kinds, ...(b.can_pay && st.upi_ready ? ['payment'] : [])];
  $('#t-upload').hidden = !kinds.length;
  if (kinds.length) setupUploads(b, kinds);
}

function setupUploads(b, kinds) {
  const st = b.settings;
  const payKind = kinds.includes('payment');
  $('#t-pay').hidden = !payKind;
  if (payKind) {
    const amount = Math.max(0, b.pay_now - (b.paid_amount || 0)) || b.pay_now;
    $('#pay-amount').textContent = inr(amount);
    $('#upi-id-row').hidden = !st.upi_id; $('#upi-id').textContent = st.upi_id;
    const link = st.upi_id ? `upi://pay?pa=${encodeURIComponent(st.upi_id)}&pn=${encodeURIComponent(st.upi_payee || 'Cloud Trails')}&am=${amount}.00&cu=INR&tn=${encodeURIComponent('Cloud Trails ' + b.ref)}` : '';
    $('#upi-link').hidden = !link || !/Android|iPhone|iPad/i.test(navigator.userAgent);
    $('#upi-link').href = link || '#';
    const staticQr = () => {
      $('.pay-qr').hidden = !st.has_qr;
      $('#qr').innerHTML = st.has_qr ? `<img src="${API}/api/qr" alt="UPI QR code">` : '';
      $('#qr-note').textContent = `Scan with any UPI app and enter ${inr(amount)}`;
    };
    if (link) {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = () => { $('#qr').innerHTML = ''; new window.QRCode($('#qr'), { text: link, width: 196, height: 196, colorDark: '#0A100D', colorLight: '#ffffff' }); $('#qr-note').textContent = `Scan with any UPI app — ${inr(amount)} is filled in`; };
      s.onerror = staticQr;
      document.head.appendChild(s);
    } else staticQr();
  }
  $('#t-files').innerHTML = kinds.map((k) => `
    <div class="up" data-kind="${k}"><span class="up-label">${esc(b.upload_labels[k] || k)}</span>
      <label class="up-zone"><input type="file" accept="image/*,application/pdf" data-kind="${k}">
        <span class="up-empty"><span>Tap to upload</span></span><span class="up-preview" hidden></span></label></div>`).join('');
  document.querySelectorAll('#t-files input[type=file]').forEach((i) => i.addEventListener('change', () => {
    const f = i.files[0];
    if (!f) return;
    files[i.dataset.kind] = f;
    const pv = i.parentElement.querySelector('.up-preview');
    pv.innerHTML = f.type.startsWith('image/') ? `<img src="${URL.createObjectURL(f)}" alt=""><span class="up-meta">${esc(f.name)}</span>` : `<span class="pdf">PDF</span><span class="up-meta">${esc(f.name)}</span>`;
    pv.hidden = false; i.parentElement.querySelector('.up-empty').hidden = true;
    i.closest('.up').classList.add('has-file');
  }));
  $('#t-send').onclick = async () => {
    $('#t-up-err').textContent = '';
    if (!Object.keys(files).length) { $('#t-up-err').textContent = 'Choose a file first.'; return; }
    const fd = new FormData();
    for (const [k, f] of Object.entries(files)) fd.set(k, f, f.name);
    if ($('#upi_utr').value.trim()) fd.set('upi_utr', $('#upi_utr').value.trim());
    $('#t-send').disabled = true; $('#t-send').textContent = 'Uploading…';
    try {
      const r = await fetch(`${API}/api/bookings/${encodeURIComponent(ref)}/files?t=${encodeURIComponent(token)}`, { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Upload failed.');
      location.reload();
    } catch (e) {
      $('#t-up-err').textContent = e.message;
      $('#t-send').disabled = false; $('#t-send').textContent = 'Upload';
    }
  };
}

load();
