import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { purgeOldDocuments } from '../worker/index.js';
import { makeEnv, ctx } from './harness.mjs';
import { quote, rentFor, rentalDays, nowIST } from '../js/pricing.js';
import { CONSENTS, TERMS_VERSION } from '../worker/terms.js';

const BASE = 'http://localhost:8787';
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(1)]);

function day(offset) {
  return new Date(Date.parse(nowIST().slice(0, 10)) + offset * 86400000).toISOString().slice(0, 10);
}

function call(env, path, init = {}) {
  return worker.fetch(new Request(BASE + path, init), env, ctx);
}

function bookingData(over = {}) {
  return {
    vehicle_id: 'yamaha-rayzr-125', start: day(1) + 'T10:00', end: day(4) + 'T10:00', guide: false,
    handover: 'delivery', handover_address: 'Laitumkhrah Main Road, near Don Bosco Square', handover_landmark: 'Opposite the bakery',
    return_mode: 'counter',
    name: 'Riya Sharma', phone: '98765 43210', email: 'riya@example.com', dob: '1996-04-12', address: '12 MG Road, Guwahati, Assam',
    hometown: 'Guwahati', emergency_name: 'Amit Sharma', emergency_phone: '9876500000',
    licence_no: 'AS01 20190012345', licence_expiry: '2035-01-01', id_type: 'Aadhaar',
    upi_utr: '432198765432', consents: Object.fromEntries(CONSENTS.map((c) => [c.id, true])), consent_name: 'riya sharma',
    terms_version: TERMS_VERSION, ...over,
  };
}

function bookingForm(data, files = {}) {
  const fd = new FormData();
  fd.set('data', JSON.stringify(data));
  const defaults = { licence_front: JPG, licence_back: JPG, id_front: JPG, selfie: JPG, signature: PNG, payment: JPG };
  for (const [k, v] of Object.entries({ ...defaults, ...files })) {
    if (v) fd.set(k, new Blob([v]), k + '.bin');
  }
  return fd;
}

async function adminCookie(env) {
  const r = await call(env, '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password-123' }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

function admin(env, cookie, path, body) {
  return call(env, '/admin/api' + path, body === undefined ? { headers: { cookie } } : {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-ct-admin': '1', origin: BASE }, body: JSON.stringify(body),
  });
}

test('pricing matches the published table', () => {
  assert.equal(rentFor(700, 1), 700);
  assert.equal(rentFor(700, 3), 1890);
  assert.equal(rentFor(700, 7), 3850);
  assert.equal(rentFor(1500, 3), 4050);
  assert.equal(rentFor(1500, 7), 8250);
  assert.equal(rentFor(1000, 3), 2700);
  assert.equal(rentFor(1000, 7), 5500);
  assert.equal(rentalDays('2026-11-01T10:00', '2026-11-02T10:00'), 1);
  assert.equal(rentalDays('2026-11-01T10:00', '2026-11-02T10:59'), 1); // 1-hour grace
  assert.equal(rentalDays('2026-11-01T10:00', '2026-11-02T11:30'), 2);
  const q = quote({ vehicle: { day_rate: 700, deposit: 2000, name: 'X' }, start: '2026-11-01T10:00', end: '2026-11-04T10:00', guide: true, delivery: true, collection: false, settings: { delivery_fee: 200 } });
  assert.equal(q.total, 1890 + 2700 + 200);
  assert.equal(q.pay_now, q.total);
  assert.equal(q.deposit, 2000);
});

test('config lists the fleet and terms', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/config');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.vehicles.length, 5);
  assert.equal(j.terms.version, TERMS_VERSION);
  assert.equal(j.settings.upi_ready, false);
  assert.equal(j.settings.delivery_fee, '200');
});

test('full booking → admin workflow → customer status', async () => {
  const env = makeEnv();
  const cookie = await adminCookie(env);
  await admin(env, cookie, '/settings', { upi_id: 'cloudtrails@okicici' });

  // Missing payment screenshot is rejected once UPI is configured
  let r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm(bookingData(), { payment: null }) });
  assert.equal(r.status, 422);
  assert.ok((await r.json()).errors.payment);

  r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm(bookingData()) });
  const created = await r.json();
  assert.equal(r.status, 201, JSON.stringify(created));
  assert.match(created.ref, /^CT-[A-Z0-9]{6}$/);
  assert.equal(created.total, 1890 + 200);

  // Status page
  r = await call(env, `/api/bookings/${created.ref}?t=${created.token}`);
  let st = await r.json();
  assert.equal(st.status, 'pending');
  assert.equal(st.payment_status, 'submitted');
  assert.equal(st.handover, 'delivery');
  r = await call(env, `/api/bookings/${created.ref}?t=${'0'.repeat(40)}`);
  assert.equal(r.status, 404);

  // Admin sees it
  r = await admin(env, cookie, '/bookings?status=pending');
  const list = await r.json();
  assert.equal(list.total, 1);
  const id = list.bookings[0].id;
  r = await admin(env, cookie, `/bookings/${id}`);
  const det = await r.json();
  assert.equal(det.files.length, 6);
  assert.equal(det.booking.token_hash, undefined);
  assert.equal(det.booking.phone, '+919876543210');

  // File view
  r = await admin(env, cookie, `/files/${det.files[0].id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');

  // Ask for re-upload, customer re-uploads
  r = await admin(env, cookie, `/bookings/${id}/action`, { action: 'request_reupload', kinds: ['licence_back'], message: 'Back side is blurry' });
  assert.equal(r.status, 200);
  r = await call(env, `/api/bookings/${created.ref}?t=${created.token}`);
  st = await r.json();
  assert.deepEqual(st.reupload_kinds, ['licence_back']);
  const fd = new FormData();
  fd.set('licence_back', new Blob([JPG]), 'x.jpg');
  r = await call(env, `/api/bookings/${created.ref}/files?t=${created.token}`, { method: 'POST', body: fd });
  assert.equal(r.status, 200, await r.clone().text());
  r = await call(env, `/api/bookings/${created.ref}?t=${created.token}`);
  st = await r.json();
  assert.equal(st.docs_status, 'submitted');

  // Verify, confirm, hand over, complete
  for (const a of [{ action: 'verify_docs' }, { action: 'verify_payment', amount: 2090 }, { action: 'confirm', assigned_reg: 'ml05 ab 1234' }]) {
    r = await admin(env, cookie, `/bookings/${id}/action`, a);
    assert.equal(r.status, 200, await r.clone().text());
  }
  r = await admin(env, cookie, `/bookings/${id}/action`, { action: 'complete' });
  assert.equal(r.status, 400); // must hand over first
  r = await admin(env, cookie, `/bookings/${id}/action`, { action: 'handover', km: 12034, fuel: 'Full' });
  assert.equal((await r.json()).booking.status, 'ongoing');
  r = await admin(env, cookie, `/bookings/${id}/action`, { action: 'complete', km: 12290, deposit_refunded: 2000 });
  const done = await r.json();
  assert.equal(done.booking.status, 'completed');
  assert.equal(done.booking.assigned_reg, 'ML05 AB 1234');

  r = await call(env, `/api/bookings/${created.ref}?t=${created.token}`);
  st = await r.json();
  assert.ok(st.timeline.some((e) => e.label === 'Rental completed'));

  // Stats, schedule, calendar, CSV
  for (const p of ['/stats', '/schedule', '/calendar', '/export.csv', '/vehicles', '/settings']) {
    r = await admin(env, cookie, p);
    assert.equal(r.status, 200, p);
  }
});

test('validation errors are specific', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/bookings', {
    method: 'POST',
    body: bookingForm(bookingData({ dob: day(-365 * 16), consent_name: 'someone else', phone: '123', handover_address: '' }), { selfie: null, signature: null, payment: null }),
  });
  const j = await r.json();
  assert.equal(r.status, 422);
  for (const k of ['dob', 'consent_name', 'phone', 'handover_address', 'selfie', 'signature']) assert.ok(j.errors[k], k);
  assert.equal(j.errors.payment, undefined); // UPI not configured → payment proof optional
});

test('fake file types are refused', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm(bookingData(), { licence_front: new TextEncoder().encode('<html><script>alert(1)</script></html>') }) });
  const j = await r.json();
  assert.equal(r.status, 422);
  assert.ok(j.errors.licence_front);
});

test('availability blocks overbooking', async () => {
  const env = makeEnv();
  const cookie = await adminCookie(env);
  await admin(env, cookie, '/vehicles', { id: 'royal-enfield-hunter-350', name: 'Royal Enfield Hunter 350', category: 'Bike', day_rate: 1500, deposit: 5000, units: 1, sort: 5 });
  const data = bookingData({ vehicle_id: 'royal-enfield-hunter-350', handover: 'pickup' });
  let r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm(data) });
  assert.equal(r.status, 201);
  r = await call(env, `/api/availability?start=${data.start}&end=${data.end}`);
  const av = await r.json();
  assert.equal(av.vehicles.find((v) => v.id === 'royal-enfield-hunter-350').available, 0);
  r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm({ ...data, start: day(2) + 'T12:00', end: day(5) + 'T12:00' }) });
  assert.equal(r.status, 409);
});

test('admin API is locked', async () => {
  const env = makeEnv();
  let r = await call(env, '/admin/api/bookings');
  assert.equal(r.status, 401);
  r = await call(env, '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
  assert.equal(r.status, 401);
  const cookie = await adminCookie(env);
  // Missing CSRF header
  r = await call(env, '/admin/api/settings', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  // Tampered cookie
  r = await call(env, '/admin/api/stats', { headers: { cookie: cookie.slice(0, -3) + 'abc' } });
  assert.equal(r.status, 401);
  // Without a password configured the admin is closed
  const env2 = makeEnv({ ADMIN_PASSWORD: '' });
  r = await call(env2, '/admin/api/me');
  assert.equal(r.status, 503);
});

test('site files are served, worker code is not', async () => {
  const env = makeEnv();
  assert.equal((await call(env, '/')).status, 200);
  assert.equal((await call(env, '/book.html')).status, 200);
  assert.equal((await call(env, '/worker/auth.js')).status, 404);
  assert.equal((await call(env, '/wrangler.jsonc')).status, 404);
  const r = await call(env, '/admin/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('CORS allows the live site only', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/config', { headers: { origin: 'https://cloudtrails.in' } });
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://cloudtrails.in');
  r = await call(env, '/api/bookings', { method: 'POST', headers: { origin: 'https://evil.example' }, body: bookingForm(bookingData()) });
  assert.equal(r.status, 403);
});

test('old documents are purged after the retention period', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm(bookingData()) });
  assert.equal(r.status, 201);
  await env.DB.prepare("UPDATE bookings SET status = 'completed', updated_at = '2020-01-01T00:00:00Z'").run();
  assert.equal(await purgeOldDocuments(env), 1);
  const { results } = await env.DB.prepare('SELECT kind FROM files').all();
  assert.deepEqual(results.map((x) => x.kind), ['signature']);
});

test('built-in QR image is served when set', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/qr');
  assert.equal(r.status, 404);
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('qr_static_path', 'images/upi-qr.png')").run();
  r = await call(env, '/api/qr');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/png/);
  const cfg = await (await call(env, '/api/config')).json();
  assert.equal(cfg.settings.has_qr, true);
  assert.equal(cfg.settings.upi_ready, true);
});

test('group booking: several vehicles, extra riders, quantity-aware availability', async () => {
  const env = makeEnv();
  const cookie = await adminCookie(env);
  await admin(env, cookie, '/vehicles', { id: 'tvs-ntorq-125', name: 'TVS NTORQ 125', category: 'Scooty · Sporty', day_rate: 700, deposit: 2000, units: 3, sort: 4 });
  const riders = [{ name: 'Kabir Sharma', phone: '9876511111', licence_no: 'AS01 20200011111' }, { name: 'Meera Das', licence_no: 'ML05 20210022222' }];
  const data = bookingData({ items: [{ vehicle_id: 'tvs-ntorq-125', qty: 2 }, { vehicle_id: 'royal-enfield-hunter-350', qty: 1 }], vehicle_id: undefined, riders });

  // A missing rider licence photo is caught
  let r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm(data, { rider1_licence: JPG }) });
  let j = await r.json();
  assert.equal(r.status, 422);
  assert.ok(j.errors.rider2_licence);
  assert.equal(j.errors.rider1_licence, undefined);

  // Duplicate licence numbers are refused
  r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm({ ...data, riders: [riders[0], { ...riders[1], licence_no: riders[0].licence_no }] }, { rider1_licence: JPG, rider2_licence: JPG }) });
  assert.ok((await r.json()).errors.rider2_licence_no);

  r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm(data, { rider1_licence: JPG, rider2_licence: JPG }) });
  j = await r.json();
  assert.equal(r.status, 201, JSON.stringify(j));
  assert.equal(j.total, 2 * 1890 + 4050 + 200);
  assert.equal(j.deposit, 2 * 2000 + 5000);

  // Only 1 NTORQ left for overlapping dates
  let av = await (await call(env, `/api/availability?start=${data.start}&end=${data.end}`)).json();
  assert.equal(av.vehicles.find((v) => v.id === 'tvs-ntorq-125').available, 1);
  r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm(bookingData({ items: [{ vehicle_id: 'tvs-ntorq-125', qty: 2 }], riders: [riders[0]] }), { rider1_licence: JPG }) });
  assert.equal(r.status, 409);

  // Admin sees items and riders; rescheduling keeps every vehicle
  const list = await (await admin(env, cookie, '/bookings')).json();
  assert.equal(list.bookings[0].vehicle_name, '2 × TVS NTORQ 125 + Royal Enfield Hunter 350');
  const id = list.bookings[0].id;
  let det = await (await admin(env, cookie, `/bookings/${id}`)).json();
  assert.equal(det.items.length, 2);
  assert.equal(det.riders.length, 2);
  assert.equal(det.doc_labels.rider2_licence, 'Rider 3 — driving licence');
  r = await admin(env, cookie, `/bookings/${id}/action`, { action: 'reschedule', start: day(1) + 'T10:00', end: day(8) + 'T10:00' });
  det = await r.json();
  assert.equal(r.status, 200, JSON.stringify(det));
  assert.equal(det.booking.total, 2 * 3850 + 8250 + 200); // weekly rate
  assert.deepEqual(det.items.map((i) => i.qty), [2, 1]);

  // Rider licence can be requested again and re-uploaded by the customer
  await admin(env, cookie, `/bookings/${id}/action`, { action: 'request_reupload', kinds: ['rider1_licence'] });
  const st = await (await call(env, `/api/bookings/${j.ref}?t=${j.token}`)).json();
  assert.deepEqual(st.reupload_kinds, ['rider1_licence']);
  assert.equal(st.items.length, 2);
  const fd = new FormData();
  fd.set('rider1_licence', new Blob([JPG]), 'x.jpg');
  r = await call(env, `/api/bookings/${j.ref}/files?t=${j.token}`, { method: 'POST', body: fd });
  assert.equal(r.status, 200);

  // Calendar counts quantities
  const cal = await (await admin(env, cookie, '/calendar?from=' + day(1))).json();
  assert.equal(cal.rows.find((x) => x.id === 'tvs-ntorq-125').cells[0], 2);
  assert.equal(cal.rows.find((x) => x.id === 'tvs-ntorq-125').bookings[0].qty, 2);
});

test('weekly pricing for a group', () => {
  const s = { delivery_fee: 200 };
  const q = quote({ items: [{ vehicle: { id: 'a', name: 'A', day_rate: 700, deposit: 2000 }, qty: 3 }], start: '2026-11-01T10:00', end: '2026-11-08T10:00', settings: s });
  assert.equal(q.days, 7);
  assert.equal(q.rent, 3 * 3850);
  assert.equal(q.savings, 3 * (4900 - 3850));
  assert.equal(q.qty, 3);
});
