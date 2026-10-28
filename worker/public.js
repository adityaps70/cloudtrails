// Public booking API used by book.html and track.html.

import { getSettings, listVehicles, peakBooked, nowISO, logEvent, PUBLIC_SETTINGS } from './db.js';
import { AGREEMENT, CONSENTS, TERMS_VERSION, termsHash } from './terms.js';
import { putFile, getFile } from './storage.js';
import { quote, nowIST, parseLocal, rentalDays } from '../js/pricing.js';
import { json, bad, HttpError, clientIp, randomRef, randomHex, sha256Hex, str, normPhone, isEmail, isDate, sniffMime } from './util.js';
import { notifyNewBooking } from './notify.js';

export const DOC_KINDS = {
  licence_front: { label: 'Driving licence (front)', required: true },
  licence_back: { label: 'Driving licence (back)', required: true },
  id_front: { label: 'Government ID (front)', required: true },
  id_back: { label: 'Government ID (back)', required: false },
  selfie: { label: 'Your photo (selfie)', required: true },
  payment: { label: 'Payment screenshot', required: false },
  signature: { label: 'Signature', required: true },
};
const MAX_FILE = 10 * 1024 * 1024;
const ID_TYPES = ['Aadhaar', 'Passport', 'Voter ID', 'PAN card', 'Other government ID'];

function publicSettings(s) {
  const out = {};
  for (const k of PUBLIC_SETTINGS) out[k] = s[k];
  out.upi_ready = Boolean(s.upi_id || s.qr_file_id || s.qr_static_path);
  out.has_qr = Boolean(s.qr_file_id || s.qr_static_path);
  return out;
}

export async function getConfig(env) {
  const [settings, vehicles] = await Promise.all([getSettings(env), listVehicles(env)]);
  return json({
    now: nowIST(),
    settings: publicSettings(settings),
    vehicles: vehicles.map((v) => ({ id: v.id, name: v.name, category: v.category, tagline: v.tagline, image: v.image, day_rate: v.day_rate, deposit: v.deposit })),
    terms: { version: TERMS_VERSION, agreement: AGREEMENT, consents: CONSENTS },
    id_types: ID_TYPES,
  });
}

function checkWindow(start, end, s) {
  const errors = {};
  const now = nowIST();
  const open = Number(s.open_hour || 9), close = Number(s.close_hour || 22);
  const lead = Number(s.min_lead_hours || 0);
  const maxDays = Number(s.max_days || 30);
  const a = parseLocal(start), b = parseLocal(end);
  if (!isFinite(a)) errors.start = 'Pick a start date and time.';
  if (!isFinite(b)) errors.end = 'Pick a return date and time.';
  if (errors.start || errors.end) return errors;
  const hourOk = (t) => { const h = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60; return h >= open && h <= close; };
  if (a < parseLocal(now) + lead * 3600000) errors.start = `Start time must be at least ${lead} hour${lead === 1 ? '' : 's'} from now.`;
  else if (!hourOk(a)) errors.start = `Handover is between ${open}:00 and ${close}:00.`;
  if (b <= a) errors.end = 'Return must be after the start.';
  else if (!hourOk(b)) errors.end = `Returns are between ${open}:00 and ${close}:00.`;
  else if (rentalDays(start, end) > maxDays) errors.end = `Online bookings are up to ${maxDays} days. Message us for longer rentals.`;
  return errors;
}

export async function availability(env, url) {
  const start = url.searchParams.get('start'), end = url.searchParams.get('end');
  const settings = await getSettings(env);
  const errors = checkWindow(start, end, settings);
  if (Object.keys(errors).length) return json({ ok: false, errors }, 200);
  const vehicles = await listVehicles(env);
  const out = [];
  for (const v of vehicles) {
    const used = await peakBooked(env, v.id, start, end);
    out.push({ id: v.id, available: Math.max(0, v.units - used) });
  }
  return json({ ok: true, days: rentalDays(start, end), vehicles: out });
}

/** Validates the booking form. Returns { errors, clean }. Exported for tests. */
export function validateBooking(d, settings, vehicle) {
  const errors = checkWindow(d.start, d.end, settings);
  const clean = {};
  if (!vehicle) errors.vehicle = 'Choose a vehicle.';

  clean.name = str(d.name, 80);
  if (clean.name.length < 3) errors.name = 'Enter your full name as on your licence.';
  clean.phone = normPhone(d.phone);
  if (!clean.phone) errors.phone = 'Enter a valid mobile number (10 digits, or with country code).';
  clean.email = str(d.email, 120).toLowerCase();
  if (clean.email && !isEmail(clean.email)) errors.email = 'That email doesn\'t look right.';
  clean.dob = str(d.dob, 10);
  if (!isDate(clean.dob)) errors.dob = 'Enter your date of birth.';
  else {
    const t = nowIST().slice(0, 10);
    const age = Number(t.slice(0, 4)) - Number(clean.dob.slice(0, 4)) - (t.slice(5) < clean.dob.slice(5) ? 1 : 0);
    if (age < 18) errors.dob = 'Riders must be 18 or older.';
    if (age > 100) errors.dob = 'Check your date of birth.';
  }
  clean.address = str(d.address, 300);
  if (clean.address.length < 8) errors.address = 'Enter your permanent address.';
  clean.hometown = str(d.hometown, 80);
  clean.emergency_name = str(d.emergency_name, 80);
  if (clean.emergency_name.length < 2) errors.emergency_name = 'Add an emergency contact.';
  clean.emergency_phone = normPhone(d.emergency_phone);
  if (!clean.emergency_phone) errors.emergency_phone = 'Enter a valid number for your emergency contact.';
  else if (clean.emergency_phone === clean.phone) errors.emergency_phone = 'Use someone other than yourself.';
  clean.licence_no = str(d.licence_no, 24).toUpperCase().replace(/\s+/g, ' ');
  if (!/^[A-Z0-9][A-Z0-9 \-\/]{6,22}$/.test(clean.licence_no)) errors.licence_no = 'Enter your driving licence number.';
  clean.licence_expiry = str(d.licence_expiry, 10);
  if (!isDate(clean.licence_expiry)) errors.licence_expiry = 'Enter the licence validity date.';
  else if (clean.licence_expiry < String(d.end || '').slice(0, 10)) errors.licence_expiry = 'Your licence must be valid for the whole rental.';
  clean.id_type = ID_TYPES.includes(d.id_type) ? d.id_type : '';
  if (!clean.id_type) errors.id_type = 'Choose the ID you are uploading.';
  clean.pillion_name = str(d.pillion_name, 80);
  clean.notes = str(d.notes, 600);

  clean.guide = d.guide ? 1 : 0;
  clean.handover = d.handover === 'delivery' ? 'delivery' : 'pickup';
  clean.handover_address = clean.handover === 'delivery' ? str(d.handover_address, 300) : '';
  clean.handover_landmark = clean.handover === 'delivery' ? str(d.handover_landmark, 160) : '';
  if (clean.handover === 'delivery' && clean.handover_address.length < 8) errors.handover_address = 'Enter the delivery address in Shillong.';
  clean.return_mode = d.return_mode === 'collection' ? 'collection' : 'counter';
  clean.return_address = clean.return_mode === 'collection' ? (str(d.return_address, 300) || clean.handover_address) : '';
  if (clean.return_mode === 'collection' && clean.return_address.length < 8) errors.return_address = 'Enter where we should collect the vehicle.';

  clean.upi_utr = str(d.upi_utr, 40).replace(/\s+/g, '');
  if (clean.upi_utr && !/^[A-Za-z0-9]{6,40}$/.test(clean.upi_utr)) errors.upi_utr = 'The UPI reference is usually a 12-digit number.';

  const consents = d.consents || {};
  for (const c of CONSENTS) if (consents[c.id] !== true) { errors.consents = 'Please tick every box to agree.'; break; }
  clean.consent_name = str(d.consent_name, 80);
  if (clean.consent_name.toLowerCase().replace(/\s+/g, ' ') !== clean.name.toLowerCase().replace(/\s+/g, ' '))
    errors.consent_name = 'Type your full name exactly as entered above.';
  if (d.terms_version !== TERMS_VERSION) errors.terms = 'The rental agreement was updated. Please reload the page and review it again.';

  clean.start = d.start; clean.end = d.end;
  return { errors, clean };
}

async function readUpload(file, kind) {
  if (!file || typeof file === 'string' || !file.size) return null;
  if (file.size > MAX_FILE) throw bad(`${DOC_KINDS[kind]?.label || kind} is larger than 10 MB.`, { field: kind });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  const allowed = kind === 'signature' ? ['image/png'] : ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
  if (!allowed.includes(mime)) throw bad(`${DOC_KINDS[kind]?.label || kind} must be a photo (JPG/PNG) or PDF.`, { field: kind });
  return { bytes, mime };
}

export async function createBooking(request, env, ctx) {
  const ip = clientIp(request);
  const settings = await getSettings(env);
  if (settings.booking_enabled !== '1') throw new HttpError(503, 'Online booking is paused right now. Please message us on WhatsApp.');

  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE created_ip = ? AND created_at > ?")
    .bind(ip, new Date(Date.now() - 3600 * 1000).toISOString()).first();
  if ((recent?.n || 0) >= 6) throw new HttpError(429, 'Too many bookings from this connection. Please message us on WhatsApp.');

  let form;
  try { form = await request.formData(); } catch { throw bad('Could not read the form. Please try again.'); }
  let d;
  try { d = JSON.parse(form.get('data') || '{}'); } catch { throw bad('Could not read the form. Please try again.'); }

  const vehicle = await env.DB.prepare('SELECT * FROM vehicles WHERE id = ? AND active = 1').bind(String(d.vehicle_id || '')).first();
  const { errors, clean } = validateBooking(d, settings, vehicle);

  // Files
  const uploads = {};
  for (const kind of Object.keys(DOC_KINDS)) {
    try {
      const f = await readUpload(form.get(kind), kind);
      if (f) uploads[kind] = f;
    } catch (e) { errors[kind] = e.message; }
  }
  for (const [kind, meta] of Object.entries(DOC_KINDS)) {
    if (meta.required && !uploads[kind] && !errors[kind]) errors[kind] = kind === 'signature' ? 'Please sign in the box.' : `Upload your ${meta.label.toLowerCase()}.`;
  }

  const q = vehicle ? quote({ vehicle, start: clean.start, end: clean.end, guide: clean.guide, delivery: clean.handover === 'delivery', collection: clean.return_mode === 'collection', settings }) : null;
  const upiReady = Boolean(settings.upi_id || settings.qr_file_id || settings.qr_static_path);
  const paymentNeeded = q && q.pay_now > 0 && upiReady;
  if (paymentNeeded && !uploads.payment && !errors.payment) errors.payment = 'Upload the screenshot of your UPI payment.';

  if (Object.keys(errors).length) throw new HttpError(422, 'Please fix the highlighted fields.', { errors });

  // Availability, checked last so it's as fresh as possible.
  const used = await peakBooked(env, vehicle.id, clean.start, clean.end);
  if (used >= vehicle.units) throw new HttpError(409, `Sorry — every ${vehicle.name} is booked for those dates. Pick another vehicle or time.`, { errors: { vehicle: 'Not available for these dates.' } });

  const ref = randomRef();
  const token = randomHex(20);
  const now = nowISO();
  const payment_status = q.pay_now === 0 ? 'none' : uploads.payment ? 'submitted' : 'awaiting';
  const res = await env.DB.prepare(`INSERT INTO bookings (
      ref, token_hash, status, payment_status, docs_status, vehicle_id, vehicle_name, guide, start_at, end_at, days,
      handover, handover_address, handover_landmark, return_mode, return_address,
      name, phone, email, dob, address, hometown, emergency_name, emergency_phone, licence_no, licence_expiry, id_type, pillion_name, notes,
      rent, guide_fee, delivery_fee, collection_fee, total, deposit, pay_now, upi_utr,
      consent_name, consent_at, consent_ip, consent_ua, terms_version, terms_hash, created_ip, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)`).bind(
    ref, await sha256Hex(token), 'pending', payment_status, 'submitted', vehicle.id, vehicle.name, clean.guide, clean.start, clean.end, q.days,
    clean.handover, clean.handover_address || null, clean.handover_landmark || null, clean.return_mode, clean.return_address || null,
    clean.name, clean.phone, clean.email || null, clean.dob, clean.address, clean.hometown || null, clean.emergency_name, clean.emergency_phone,
    clean.licence_no, clean.licence_expiry, clean.id_type, clean.pillion_name || null, clean.notes || null,
    q.rent, q.guide_fee, q.delivery_fee, q.collection_fee, q.total, q.deposit, q.pay_now, clean.upi_utr || null,
    clean.consent_name, now, ip, str(request.headers.get('user-agent'), 300), TERMS_VERSION, await termsHash(), ip, now, now,
  ).run();
  const bookingId = res.meta.last_row_id;

  try {
    for (const [kind, f] of Object.entries(uploads)) await putFile(env, { bookingId, kind, mime: f.mime, bytes: f.bytes });
  } catch (e) {
    // Roll back so a half-saved booking doesn't hold a vehicle.
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled', admin_notes = ? WHERE id = ?").bind('Upload failed: ' + e.message, bookingId).run();
    throw new HttpError(500, 'We could not save your documents. Please try again in a minute.');
  }
  await logEvent(env, bookingId, 'customer', 'created', `${vehicle.name}, ${clean.start.replace('T', ' ')} → ${clean.end.replace('T', ' ')}, ${clean.handover === 'delivery' ? 'delivery' : 'counter pickup'} / ${clean.return_mode === 'collection' ? 'collection' : 'counter return'}`);

  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first();
  ctx?.waitUntil?.(notifyNewBooking(env, settings, booking, new URL(request.url).origin).catch(() => {}));

  return json({ ok: true, ref, token, total: q.total, pay_now: q.pay_now, deposit: q.deposit }, 201);
}

async function bookingByToken(env, ref, token) {
  if (!/^CT-[A-Z0-9]{6}$/.test(String(ref)) || !/^[a-f0-9]{40}$/.test(String(token))) return null;
  const b = await env.DB.prepare('SELECT * FROM bookings WHERE ref = ?').bind(ref).first();
  if (!b || b.token_hash !== await sha256Hex(token)) return null;
  return b;
}

const CUSTOMER_EVENTS = {
  created: 'Booking received',
  confirmed: 'Booking confirmed',
  payment_verified: 'Payment verified',
  payment_mismatch: 'Payment needs attention',
  docs_verified: 'Documents verified',
  reupload_requested: 'Documents need re-upload',
  customer_upload: 'You uploaded new files',
  handover: 'Vehicle handed over',
  completed: 'Rental completed',
  rejected: 'Booking declined',
  cancelled: 'Booking cancelled',
};

export async function bookingStatus(env, ref, token) {
  const b = await bookingByToken(env, ref, token);
  if (!b) throw new HttpError(404, 'We couldn\'t find that booking. Check the link we gave you.');
  const settings = await getSettings(env);
  const { results } = await env.DB.prepare('SELECT at, action FROM events WHERE booking_id = ? ORDER BY id').bind(b.id).all();
  const timeline = (results || []).filter((e) => CUSTOMER_EVENTS[e.action]).map((e) => ({ at: e.at, label: CUSTOMER_EVENTS[e.action] }));
  const open = ['pending', 'confirmed'].includes(b.status);
  const canPay = open && ['awaiting', 'mismatch'].includes(b.payment_status);
  const reupload = open && b.docs_status === 'reupload' ? String(b.reupload_kinds || '').split(',').filter((k) => DOC_KINDS[k]) : [];
  return json({
    ref: b.ref, status: b.status, payment_status: b.payment_status, docs_status: b.docs_status,
    customer_message: b.customer_message, first_name: b.name.split(' ')[0],
    vehicle_name: b.vehicle_name, guide: !!b.guide, start: b.start_at, end: b.end_at, days: b.days,
    handover: b.handover, handover_address: b.handover_address, return_mode: b.return_mode, return_address: b.return_address,
    rent: b.rent, guide_fee: b.guide_fee, delivery_fee: b.delivery_fee, collection_fee: b.collection_fee,
    total: b.total, deposit: b.deposit, pay_now: b.pay_now, paid_amount: b.paid_amount,
    assigned_reg: ['confirmed', 'ongoing'].includes(b.status) ? b.assigned_reg : null,
    timeline, can_pay: canPay, reupload_kinds: reupload,
    upload_labels: Object.fromEntries(Object.entries(DOC_KINDS).map(([k, v]) => [k, v.label])),
    settings: publicSettings(settings),
  });
}

export async function customerUpload(request, env, ref, token) {
  const b = await bookingByToken(env, ref, token);
  if (!b) throw new HttpError(404, 'We couldn\'t find that booking.');
  if (!['pending', 'confirmed'].includes(b.status)) throw bad('This booking can no longer be changed.');
  const allowed = new Set();
  if (b.docs_status === 'reupload') for (const k of String(b.reupload_kinds || '').split(',')) if (DOC_KINDS[k]) allowed.add(k);
  if (['awaiting', 'mismatch'].includes(b.payment_status)) allowed.add('payment');
  if (!allowed.size) throw bad('Nothing needs uploading for this booking right now.');

  const form = await request.formData();
  const saved = [];
  for (const kind of allowed) {
    const f = await readUpload(form.get(kind), kind);
    if (!f) continue;
    await putFile(env, { bookingId: b.id, kind, mime: f.mime, bytes: f.bytes });
    saved.push(kind);
  }
  if (!saved.length) throw bad('Choose a file to upload.');
  const utr = str(form.get('upi_utr'), 40).replace(/\s+/g, '');
  const sets = ['updated_at = ?'];
  const vals = [nowISO()];
  if (saved.includes('payment')) { sets.push("payment_status = 'submitted'"); if (utr) { sets.push('upi_utr = ?'); vals.push(utr); } }
  const docKinds = saved.filter((k) => k !== 'payment');
  if (docKinds.length) {
    const remaining = String(b.reupload_kinds || '').split(',').filter((k) => k && !docKinds.includes(k));
    sets.push('reupload_kinds = ?'); vals.push(remaining.join(',') || null);
    if (!remaining.length) sets.push("docs_status = 'submitted'");
  }
  await env.DB.prepare(`UPDATE bookings SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, b.id).run();
  await logEvent(env, b.id, 'customer', 'customer_upload', saved.join(', '));
  return json({ ok: true, saved });
}

export async function publicQr(env, request) {
  const s = await getSettings(env);
  if (s.qr_file_id) {
    const f = await getFile(env, s.qr_file_id);
    if (f && f.row.kind === 'qr') return new Response(f.body, { headers: { 'content-type': f.row.mime, 'cache-control': 'public, max-age=300' } });
  }
  const path = String(s.qr_static_path || '').replace(/^\/+/, '');
  if (/^images\/[\w.\-\/]+\.(png|jpe?g|webp)$/.test(path) && env.ASSETS) {
    const r = await env.ASSETS.fetch(new Request(new URL('/' + path, request.url)));
    if (r.ok) return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'image/png', 'cache-control': 'public, max-age=300' } });
  }
  return new Response('Not found', { status: 404 });
}
