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
    vehicle_id: 'yamaha-rayzr-125', start: day(1) + 'T10:00', end: day(4) + 'T10:00',
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
  assert.equal(rentFor(700, 3), 2100);           // no discount under a week
  assert.equal(rentFor(700, 6, 600), 4200);
  assert.equal(rentFor(700, 7, 600), 4200);      // weekly price: ₹600/day
  assert.equal(rentFor(700, 10, 600), 6000);
  assert.equal(rentFor(700, 7), 4900);           // no weekly price set
  assert.equal(rentFor(700, 7, 800), 4900);      // weekly price higher than day rate is ignored
  assert.equal(rentFor(1500, 7, 0), 10500);
  assert.equal(rentFor(700, 30, 600, 15000), 15000);   // monthly price
  assert.equal(rentFor(700, 45, 600, 15000), 22500);   // pro-rated after 30 days
  assert.equal(rentFor(700, 29, 600, 15000), 17400);   // under 30 days: weekly price
  assert.equal(rentFor(700, 30, 600, 0), 18000);       // no monthly price set
  assert.equal(rentalDays('2026-11-01T10:00', '2026-11-02T10:00'), 1);
  assert.equal(rentalDays('2026-11-01T10:00', '2026-11-02T10:59'), 1); // 1-hour grace
  assert.equal(rentalDays('2026-11-01T10:00', '2026-11-02T11:30'), 2);
  const q = quote({ vehicle: { day_rate: 700, week_rate: 600, deposit: 2000, name: 'X' }, start: '2026-11-01T10:00', end: '2026-11-04T10:00', delivery: true, collection: false, settings: { delivery_fee: 200 } });
  assert.equal(q.total, 2100 + 200);
  assert.equal(q.guide_fee, 0);
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
  assert.equal(created.total, 2100 + 200);

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
  assert.equal(j.total, 2 * 2100 + 4500 + 200);
  assert.equal(j.deposit, 2 * 2000 + 1000);

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
  assert.equal(det.booking.total, 2 * 7 * 600 + 7 * 1500 + 200); // scooty weekly price; the Hunter has none
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
  const q = quote({ items: [{ vehicle: { id: 'a', name: 'A', day_rate: 700, week_rate: 600, deposit: 2000 }, qty: 3 }], start: '2026-11-01T10:00', end: '2026-11-08T10:00', settings: s });
  assert.equal(q.days, 7);
  assert.equal(q.rent, 3 * 4200);
  assert.equal(q.savings, 3 * (4900 - 4200));
  assert.match(q.lines[0].label, /weekly price ₹600\/day/);
  assert.equal(q.qty, 3);
});

test('deposit setting updates every vehicle; one vehicle can still differ', async () => {
  const env = makeEnv();
  const cookie = await adminCookie(env);
  let r;
  let vs = (await (await admin(env, cookie, '/vehicles')).json()).vehicles;
  assert.ok(vs.every((v) => v.deposit === 1000));
  // Change the deposit for everyone
  r = await admin(env, cookie, '/settings', { default_deposit: '1500' });
  assert.equal(r.status, 200);
  vs = (await (await admin(env, cookie, '/vehicles')).json()).vehicles;
  assert.ok(vs.every((v) => v.deposit === 1500));
  // One vehicle different; saving other settings leaves it alone
  await admin(env, cookie, '/vehicles', { id: 'royal-enfield-hunter-350', name: 'Royal Enfield Hunter 350', day_rate: 1500, deposit: 3000, units: 3, sort: 5 });
  await admin(env, cookie, '/settings', { default_deposit: '1500', delivery_fee: '200' });
  vs = (await (await admin(env, cookie, '/vehicles')).json()).vehicles;
  assert.equal(vs.find((v) => v.id === 'royal-enfield-hunter-350').deposit, 3000);
  // ...unless asked to apply to all
  await admin(env, cookie, '/settings', { default_deposit: '1500', apply_deposit_all: true });
  vs = (await (await admin(env, cookie, '/vehicles')).json()).vehicles;
  assert.equal(vs.find((v) => v.id === 'royal-enfield-hunter-350').deposit, 1500);
  // Bad value refused
  r = await admin(env, cookie, '/settings', { default_deposit: 'abc' });
  assert.equal(r.status, 400);
});

test('weekly price setting updates every scooty, not bikes', async () => {
  const env = makeEnv();
  const cookie = await adminCookie(env);
  const list = async () => (await (await admin(env, cookie, '/vehicles')).json()).vehicles;
  let vs = await list();
  assert.equal(vs.find((v) => v.id === 'tvs-ntorq-125').week_rate, 600);
  assert.equal(vs.find((v) => v.id === 'royal-enfield-hunter-350').week_rate, 0);
  let r = await admin(env, cookie, '/settings', { week_rate_scooty: '550' });
  assert.equal(r.status, 200);
  vs = await list();
  assert.ok(vs.filter((v) => v.category.startsWith('Scooty')).every((v) => v.week_rate === 550));
  assert.equal(vs.find((v) => v.id === 'royal-enfield-hunter-350').week_rate, 0);
  // The bike's own weekly price is set in Fleet & prices and used in quotes
  await admin(env, cookie, '/vehicles', { id: 'royal-enfield-hunter-350', name: 'Royal Enfield Hunter 350', category: 'Bike · 350cc', day_rate: 1500, week_rate: 1200, deposit: 1000, units: 3, sort: 5 });
  const cfg = await (await call(env, '/api/config')).json();
  assert.equal(cfg.vehicles.find((v) => v.id === 'royal-enfield-hunter-350').week_rate, 1200);
  assert.equal(cfg.settings.guide_rate, undefined);
  r = await admin(env, cookie, '/settings', { week_rate_scooty: 'x' });
  assert.equal(r.status, 400);
});

test('monthly price: setting updates scooties; 30-day booking priced monthly', async () => {
  const env = makeEnv();
  const cookie = await adminCookie(env);
  const list = async () => (await (await admin(env, cookie, '/vehicles')).json()).vehicles;
  let vs = await list();
  assert.equal(vs.find((v) => v.id === 'tvs-ntorq-125').month_rate, 15000);
  assert.equal(vs.find((v) => v.id === 'royal-enfield-hunter-350').month_rate, 0);
  await admin(env, cookie, '/settings', { month_rate_scooty: '14000' });
  vs = await list();
  assert.ok(vs.filter((v) => v.category.startsWith('Scooty')).every((v) => v.month_rate === 14000));
  // Saving a vehicle from an older form (no month_rate field) keeps its monthly price
  await admin(env, cookie, '/vehicles', { id: 'tvs-ntorq-125', name: 'TVS NTORQ 125', category: 'Scooty · Sporty', day_rate: 700, deposit: 1000, units: 5, sort: 4 });
  vs = await list();
  assert.equal(vs.find((v) => v.id === 'tvs-ntorq-125').month_rate, 14000);
  assert.equal(vs.find((v) => v.id === 'tvs-ntorq-125').week_rate, 600);
  const cfg = await (await call(env, '/api/config')).json();
  const v = cfg.vehicles.find((x) => x.id === 'tvs-ntorq-125');
  const q = quote({ items: [{ vehicle: v, qty: 2 }], start: '2026-11-01T10:00', end: '2026-12-01T10:00', settings: cfg.settings });
  assert.equal(q.days, 30);
  assert.equal(q.rent, 2 * 14000);
  assert.match(q.lines[0].label, /monthly price/);
});

test('customer finds bookings by mobile number + date of birth; admin search matches typed phone', async () => {
  const env = makeEnv();
  const cookie = await adminCookie(env);
  let r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm(bookingData()) });
  const created = await r.json();
  assert.equal(r.status, 201, JSON.stringify(created));
  const look = (body, ip = '1.1.1.1') => call(env, '/api/bookings/lookup', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) });
  // Wrong date of birth finds nothing (same answer as an unknown number)
  r = await look({ phone: '9876543210', dob: '1990-01-01' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).bookings.length, 0);
  // Right number in any format + right DOB
  r = await look({ phone: '+91 98765 43210', dob: '1996-04-12' });
  const j = await r.json();
  assert.equal(j.bookings.length, 1);
  assert.equal(j.bookings[0].ref, created.ref);
  // The signed link opens the status page; a tampered one doesn't
  r = await call(env, `/api/bookings/${created.ref}?t=${encodeURIComponent(j.bookings[0].token)}`);
  assert.equal(r.status, 200);
  r = await call(env, `/api/bookings/${created.ref}?t=${encodeURIComponent(j.bookings[0].token.slice(0, -2) + 'xx')}`);
  assert.equal(r.status, 404);
  // A link for one booking can't open another
  r = await call(env, `/api/bookings/CT-ZZZZZZ?t=${encodeURIComponent(j.bookings[0].token)}`);
  assert.equal(r.status, 404);
  // Validation and throttling
  r = await look({ phone: '123', dob: '1996-04-12' });
  assert.equal(r.status, 400);
  for (let i = 0; i < 10; i++) await look({ phone: '9876543210', dob: '1990-01-0' + (i % 9 + 1) }, '2.2.2.2');
  r = await look({ phone: '9876543210', dob: '1996-04-12' }, '2.2.2.2');
  assert.equal(r.status, 429);
  // Admin search finds the booking however the number is typed
  for (const q of ['98765 43210', '+91 9876543210', '09876543210', '43210']) {
    const list = await (await admin(env, cookie, '/bookings?q=' + encodeURIComponent(q))).json();
    assert.equal(list.total, 1, q);
  }
});

test('web push: payload encryption (RFC 8291) round-trips and VAPID header verifies', async () => {
  const { encryptPayload, sendPush, notifyAdmins, newBookingMessage } = await import('../worker/push.js');
  const { b64url, fromB64url } = await import('../worker/util.js');
  const env = makeEnv();
  // A "browser" subscription
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const sub = { id: 1, endpoint: 'https://web.push.apple.com/abc', p256dh: b64url(uaPub), auth: b64url(authSecret) };

  const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify({ title: 'Hi', body: 'There' }));
  // Decrypt like a browser would
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), cipher = body.slice(21 + idlen);
  assert.equal(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0), 4096);
  const h = async (k, d) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), d));
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
  const te = new TextEncoder();
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const ikm = await h(await h(authSecret, secret), cat(te.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const prk = await h(salt, ikm);
  const cek = (await h(prk, cat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await h(prk, cat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher));
  assert.equal(plain[plain.length - 1], 2);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain.slice(0, -1))), { title: 'Hi', body: 'There' });

  // sendPush: check headers and the VAPID signature, using a fake push service
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: url.includes('gone') ? 410 : 201 }); };
  try {
    assert.equal(await sendPush(env, sub, { title: 'x' }), 201);
    const hdr = calls[0].init.headers;
    assert.equal(hdr['content-encoding'], 'aes128gcm');
    const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(hdr.authorization);
    const [hh, cc, ss] = t.split('.');
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(cc)));
    assert.equal(claims.aud, 'https://web.push.apple.com');
    const pub = await crypto.subtle.importKey('raw', fromB64url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(ss), te.encode(hh + '.' + cc)));

    // Admin API: subscribe, list, test, expired device is dropped
    const cookie = await adminCookie(env);
    let r = await admin(env, cookie, '/push');
    let info = await r.json();
    assert.equal(info.publicKey, k);           // same key the browser subscribes with
    assert.equal(info.devices.length, 0);
    r = await admin(env, cookie, '/push/subscribe', { subscription: { endpoint: 'https://evil.example.com/x', keys: { p256dh: sub.p256dh, auth: sub.auth } } });
    assert.equal(r.status, 400);
    await admin(env, cookie, '/push/subscribe', { subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, label: 'iPhone · home-screen app' });
    await admin(env, cookie, '/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/gone', keys: { p256dh: sub.p256dh, auth: sub.auth } }, label: 'Old phone' });
    info = await (await admin(env, cookie, '/push')).json();
    assert.equal(info.devices.length, 2);
    calls.length = 0;
    const res = await (await admin(env, cookie, '/push/test', {})).json();
    assert.equal(res.sent, 1);
    assert.equal(res.failed, 1);
    info = await (await admin(env, cookie, '/push')).json();
    assert.deepEqual(info.devices.map((d) => d.label), ['iPhone · home-screen app']);
    // New-booking message
    const msg = newBookingMessage({ id: 7, ref: 'CT-ABC123', name: 'Riya', vehicle_name: '2 × TVS NTORQ 125', start_at: '2026-11-01T10:00', end_at: '2026-11-08T10:00', total: 8400 });
    assert.equal(msg.url, '/admin/#/booking/7');
    assert.match(msg.body, /Riya · 2 × TVS NTORQ 125/);
    assert.match(msg.body, /₹8,400/);
    const n = await notifyAdmins(env, msg);
    assert.equal(n.sent, 1);
    // Remove the device
    await admin(env, cookie, '/push/remove', { endpoint: sub.endpoint });
    assert.equal((await (await admin(env, cookie, '/push')).json()).devices.length, 0);
  } finally { globalThis.fetch = realFetch; }
});

test('admin can permanently delete a booking with its documents', async () => {
  const env = makeEnv();
  const cookie = await adminCookie(env);
  const r0 = await call(env, '/api/bookings', { method: 'POST', body: bookingForm(bookingData()) });
  const created = await r0.json();
  const list = await (await admin(env, cookie, '/bookings')).json();
  const id = list.bookings[0].id;
  const fileIds = (await env.DB.prepare('SELECT id FROM files WHERE booking_id = ?').bind(id).all()).results.map((f) => f.id);
  assert.ok(fileIds.length >= 5);
  let r = await admin(env, cookie, `/bookings/${id}/delete`, { confirm_ref: 'CT-WRONG1' });
  assert.equal(r.status, 400);
  r = await admin(env, cookie, `/bookings/${id}/delete`, { confirm_ref: created.ref.toLowerCase() });
  assert.equal(r.status, 200);
  assert.equal((await (await admin(env, cookie, '/bookings')).json()).total, 0);
  for (const t of ['files', 'booking_items', 'events']) assert.equal((await env.DB.prepare(`SELECT COUNT(*) n FROM ${t} WHERE booking_id = ?`).bind(id).first()).n, 0, t);
  for (const f of fileIds) assert.equal(await env.DOCS.get('f/' + f), null);
  r = await call(env, `/api/bookings/${created.ref}?t=${created.token}`);
  assert.equal(r.status, 404);
});

test('return reminders: 4h for short rentals; 1d + 4h for 4–14 days; 5d + 1d + 4h for 15+ days', async () => {
  const { sendReturnReminders, remindersFor } = await import('../worker/reminders.js');
  assert.deepEqual(remindersFor(1), ['4h']);
  assert.deepEqual(remindersFor(3), ['4h']);
  assert.deepEqual(remindersFor(4), ['1d', '4h']);
  assert.deepEqual(remindersFor(14), ['1d', '4h']);
  assert.deepEqual(remindersFor(15), ['5d', '1d', '4h']);
  assert.deepEqual(remindersFor(30), ['5d', '1d', '4h']);

  const env = makeEnv();
  const cookie = await adminCookie(env);
  const mk = async (days, phone) => {
    const r = await call(env, '/api/bookings', { method: 'POST', body: bookingForm(bookingData({ start: day(1) + 'T10:00', end: day(1 + days) + 'T10:00', phone, emergency_phone: '9876500099' })) });
    const j = await r.json();
    assert.equal(r.status, 201, JSON.stringify(j));
    const b = await env.DB.prepare('SELECT id, end_at FROM bookings WHERE ref = ?').bind(j.ref).first();
    await admin(env, cookie, `/bookings/${b.id}/action`, { action: 'confirm' });
    return b;
  };
  const short = await mk(2, '9876511001'), week = await mk(7, '9876511002'), long = await mk(20, '9876511003');
  await env.DB.prepare("INSERT INTO push_subs (endpoint, p256dh, auth, label, created_at) VALUES ('https://web.push.apple.com/x', ?, ?, 'iPhone', '2026-01-01')")
    .bind('BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', 'tBHItJI5svbpez7KI4CCXg').run();
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url) => { sent.push(url); return new Response(null, { status: 201 }); };
  const at = (b, hoursBefore) => new Date(Date.parse(b.end_at + ':00Z') - hoursBefore * 3600 * 1000).toISOString().slice(0, 16);
  const kinds = async (b) => (await env.DB.prepare('SELECT kind FROM reminders_sent WHERE booking_id = ? ORDER BY kind').bind(b.id).all()).results.map((r) => r.kind);
  try {
    // 6 days before the long rental ends: nothing due anywhere
    assert.equal(await sendReturnReminders(env, at(long, 6 * 24)), 0);
    // 5 days before: the long rental's first reminder
    assert.equal(await sendReturnReminders(env, at(long, 5 * 24 - 0.1)), 1);
    assert.deepEqual(await kinds(long), ['5d']);
    // Running again sends nothing new
    assert.equal(await sendReturnReminders(env, at(long, 5 * 24 - 0.2)), 0);
    // 1 day before the week rental
    assert.equal(await sendReturnReminders(env, at(week, 23.9)), 1);
    assert.deepEqual(await kinds(week), ['1d']);
    // 4 hours before the short rental (it never gets a 1-day reminder)
    assert.equal(await sendReturnReminders(env, at(short, 3.9)), 1);
    assert.deepEqual(await kinds(short), ['4h']);
    // 3 hours before the week rental: its 4h reminder
    assert.equal(await sendReturnReminders(env, at(week, 3)), 1);
    assert.deepEqual(await kinds(week), ['1d', '4h']);
    // Long rental, 2 hours before the end: 1d was missed, only the closest (4h) is sent, both marked done
    assert.equal(await sendReturnReminders(env, at(long, 2)), 1);
    assert.deepEqual(await kinds(long), ['1d', '4h', '5d']);
    assert.equal(sent.length, 5);
    // History shows the reminder
    const ev = await env.DB.prepare("SELECT detail FROM events WHERE booking_id = ? AND action = 'return_reminder'").bind(short.id).all();
    assert.match(ev.results[0].detail, /4 hours before return — sent to 1 device/);
    // Cancelled bookings get nothing
    await admin(env, cookie, `/bookings/${short.id}/action`, { action: 'cancel', message: 'x' });
    await env.DB.prepare('DELETE FROM reminders_sent WHERE booking_id = ?').bind(short.id).run();
    assert.equal(await sendReturnReminders(env, at(short, 1)), 0);
  } finally { globalThis.fetch = realFetch; }
});
