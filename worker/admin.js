// Admin API (/admin/api/*). Every route except login requires the admin session cookie.

import { getSettings, saveSettings, listVehicles, peakBooked, peakOf, bookingItems, nowISO, logEvent, DEFAULT_SETTINGS } from './db.js';
import { requireAdmin, login, logoutCookie, adminConfigured } from './auth.js';
import { getFile, putFile, deleteFile, purgeBookingDocs } from './storage.js';
import { DOC_KINDS, docLabel, isDocKind } from './public.js';
import { quote, nowIST, parseLocal, itemsSummary } from '../js/pricing.js';
import { json, bad, HttpError, str, sniffMime, csvCell } from './util.js';
import { vapidKeys, validEndpoint, notifyAdmins } from './push.js';

const STATUSES = ['pending', 'confirmed', 'ongoing', 'completed', 'cancelled', 'rejected'];

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function getBooking(env, id) {
  const b = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(Number(id) || 0).first();
  if (!b) throw new HttpError(404, 'Booking not found.');
  return b;
}

function strip(b) {
  const { token_hash, ...rest } = b;
  return rest;
}

export async function handleAdmin(request, env, url) {
  const path = url.pathname.replace(/^\/admin\/api/, '') || '/';
  const m = request.method;

  if (path === '/login' && m === 'POST') {
    const cookie = await login(request, env);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }
  if (path === '/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': logoutCookie(request) });
  if (path === '/me' && m === 'GET') {
    if (!adminConfigured(env)) return json({ ok: false, setup: true, error: 'Add the ADMIN_PASSWORD secret in Cloudflare to open the admin panel.' }, 503);
    await requireAdmin(request, env);
    return json({ ok: true, today: nowIST().slice(0, 10), storage: env.FILES ? 'r2' : 'kv', email_alerts: Boolean(env.RESEND_API_KEY) });
  }

  await requireAdmin(request, env);

  if (path === '/stats' && m === 'GET') return stats(env);
  if (path === '/push' && m === 'GET') return pushInfo(env);
  if (path === '/push/subscribe' && m === 'POST') return pushSubscribe(env, await body(request));
  if (path === '/push/remove' && m === 'POST') return pushRemove(env, await body(request));
  if (path === '/push/test' && m === 'POST') return json({ ok: true, ...(await notifyAdmins(env, { title: 'Cloud Trails', body: 'Notifications are working. You\'ll get one like this for every new booking.', url: '/admin/#/', tag: 'test' })) });
  if (path === '/bookings' && m === 'GET') return listBookings(env, url);
  if (path === '/export.csv' && m === 'GET') return exportCsv(env, url);
  if (path === '/schedule' && m === 'GET') return schedule(env, url);
  if (path === '/calendar' && m === 'GET') return calendar(env, url);

  let mm;
  if ((mm = path.match(/^\/bookings\/(\d+)$/)) && m === 'GET') return bookingDetail(env, mm[1]);
  if ((mm = path.match(/^\/bookings\/(\d+)\/action$/)) && m === 'POST') return bookingAction(env, mm[1], await body(request));
  if ((mm = path.match(/^\/bookings\/(\d+)\/purge-docs$/)) && m === 'POST') {
    const b = await getBooking(env, mm[1]);
    const n = await purgeBookingDocs(env, b.id);
    await logEvent(env, b.id, 'admin', 'docs_purged', `${n} file(s) deleted`);
    return json({ ok: true, deleted: n });
  }
  if ((mm = path.match(/^\/files\/([a-f0-9]{32})$/)) && m === 'GET') return serveFile(env, mm[1], url);

  if (path === '/vehicles' && m === 'GET') return json({ vehicles: await listVehicles(env, { all: true }) });
  if (path === '/vehicles' && m === 'POST') return saveVehicle(env, await body(request));
  if (path === '/settings' && m === 'GET') return json({ settings: await getSettings(env) });
  if (path === '/settings' && m === 'POST') return updateSettings(env, await body(request));
  if (path === '/settings/qr' && m === 'POST') return uploadQr(request, env);
  if (path === '/settings/qr' && m === 'DELETE') {
    const s = await getSettings(env);
    if (s.qr_file_id) await deleteFile(env, s.qr_file_id);
    await saveSettings(env, { qr_file_id: '' });
    return json({ ok: true });
  }
  throw new HttpError(404, 'Not found.');
}

async function stats(env) {
  const today = nowIST().slice(0, 10);
  const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const [pending, paymentCheck, docsCheck, handovers, returns, ongoing, overdue, revenue, week] = await Promise.all([
    q("SELECT COUNT(*) n FROM bookings WHERE status = 'pending'"),
    q("SELECT COUNT(*) n FROM bookings WHERE payment_status = 'submitted' AND status IN ('pending','confirmed')"),
    q("SELECT COUNT(*) n FROM bookings WHERE docs_status = 'submitted' AND status IN ('pending','confirmed')"),
    q("SELECT COUNT(*) n FROM bookings WHERE status IN ('pending','confirmed') AND start_at >= ? AND start_at < ?", today, tomorrow),
    q("SELECT COUNT(*) n FROM bookings WHERE status = 'ongoing' AND end_at >= ? AND end_at < ?", today, tomorrow),
    q("SELECT COUNT(*) n FROM bookings WHERE status = 'ongoing'"),
    q("SELECT COUNT(*) n FROM bookings WHERE status = 'ongoing' AND end_at < ?", nowIST()),
    q("SELECT COALESCE(SUM(total),0) s, COUNT(*) n FROM bookings WHERE status IN ('confirmed','ongoing','completed') AND substr(start_at,1,7) = ?", month),
    q("SELECT COUNT(*) n FROM bookings WHERE status IN ('pending','confirmed') AND start_at >= ? AND start_at < ?", today, new Date(Date.parse(today) + 7 * 86400000).toISOString().slice(0, 10)),
  ]);
  return json({
    today,
    pending: pending.n, payment_check: paymentCheck.n, docs_check: docsCheck.n,
    handovers_today: handovers.n, returns_today: returns.n, ongoing: ongoing.n, overdue: overdue.n,
    month_revenue: revenue.s, month_bookings: revenue.n, next_7_days: week.n,
  });
}

async function listBookings(env, url) {
  const p = url.searchParams;
  const where = [], args = [];
  const status = p.get('status');
  if (status && STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
  if (status === 'active') where.push("status IN ('pending','confirmed','ongoing')");
  if (p.get('payment') === 'submitted') where.push("payment_status = 'submitted'");
  if (p.get('docs') === 'submitted') where.push("docs_status = 'submitted'");
  const qtext = str(p.get('q'), 60);
  if (qtext) {
    const like = '%' + qtext.replace(/[%_]/g, '') + '%';
    // Phone numbers are stored as +91XXXXXXXXXX; match the digits however they were typed (spaces, +91, 0…).
    let digits = qtext.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    const phoneLike = digits.length >= 4 ? '%' + digits + '%' : like;
    where.push('(ref LIKE ? OR name LIKE ? OR phone LIKE ? OR emergency_phone LIKE ? OR licence_no LIKE ? OR assigned_reg LIKE ?)');
    args.push(like, like, phoneLike, phoneLike, like, like);
  }
  const from = p.get('from'), to = p.get('to');
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('end_at >= ?'); args.push(from); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push('start_at < ?'); args.push(to + 'T23:59'); }
  const sort = p.get('sort') === 'start' ? 'start_at ASC' : 'id DESC';
  const page = Math.max(1, Number(p.get('page')) || 1);
  const per = 50;
  const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [{ results }, count] = await Promise.all([
    env.DB.prepare(`SELECT id, ref, status, payment_status, docs_status, vehicle_name, guide, start_at, end_at, days, handover, return_mode,
                    name, phone, total, pay_now, paid_amount, assigned_reg, created_at
                    FROM bookings ${sqlWhere} ORDER BY ${sort} LIMIT ? OFFSET ?`).bind(...args, per, (page - 1) * per).all(),
    env.DB.prepare(`SELECT COUNT(*) n FROM bookings ${sqlWhere}`).bind(...args).first(),
  ]);
  return json({ bookings: results || [], total: count.n, page, per });
}

async function bookingDetail(env, id) {
  const b = await getBooking(env, id);
  const [{ results: files }, { results: events }] = await Promise.all([
    env.DB.prepare('SELECT id, kind, mime, size, created_at FROM files WHERE booking_id = ? ORDER BY created_at').bind(b.id).all(),
    env.DB.prepare('SELECT at, actor, action, detail FROM events WHERE booking_id = ? ORDER BY id').bind(b.id).all(),
  ]);
  let riders = [];
  try { riders = JSON.parse(b.riders || '[]'); } catch {}
  const kinds = new Set([...Object.keys(DOC_KINDS), ...(files || []).map((f) => f.kind), ...riders.map((_, i) => `rider${i + 1}_licence`)]);
  return json({
    booking: strip(b), items: await bookingItems(env, b.id), riders, files: files || [], events: events || [],
    doc_labels: Object.fromEntries([...kinds].map((k) => [k, docLabel(k)])),
  });
}

function int(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function bookingAction(env, id, d) {
  const b = await getBooking(env, id);
  const action = String(d.action || '');
  const now = nowISO();
  const set = {};
  let detail = '';
  const need = (...st) => { if (!st.includes(b.status)) throw bad(`Not possible while the booking is ${b.status}.`); };
  const msg = str(d.message, 500);

  switch (action) {
    case 'confirm':
      need('pending');
      set.status = 'confirmed';
      if (d.assigned_reg) set.assigned_reg = str(d.assigned_reg, 20).toUpperCase();
      set.customer_message = msg || null;
      detail = set.assigned_reg ? 'Vehicle ' + set.assigned_reg : '';
      break;
    case 'verify_payment': {
      const amt = int(d.amount ?? b.pay_now);
      if (amt == null) throw bad('Enter the amount received.');
      set.payment_status = 'verified'; set.paid_amount = amt;
      detail = '₹' + amt;
      break;
    }
    case 'payment_mismatch':
      need('pending', 'confirmed');
      set.payment_status = 'mismatch';
      set.customer_message = msg || 'We could not match your payment. Please upload the correct payment screenshot.';
      detail = set.customer_message;
      break;
    case 'verify_docs':
      set.docs_status = 'verified'; set.reupload_kinds = null;
      break;
    case 'request_reupload': {
      need('pending', 'confirmed');
      const kinds = (Array.isArray(d.kinds) ? d.kinds : []).filter((k) => isDocKind(k) && k !== 'signature' && k !== 'payment');
      if (!kinds.length) throw bad('Choose which documents to ask for again.');
      set.docs_status = 'reupload'; set.reupload_kinds = kinds.join(',');
      set.customer_message = msg || 'Please upload clearer copies of the documents listed below.';
      detail = kinds.join(', ');
      break;
    }
    case 'reject':
      need('pending', 'confirmed');
      set.status = 'rejected'; set.reject_reason = msg || 'Declined';
      set.customer_message = msg || 'Sorry, we could not accept this booking. Any amount paid will be refunded.';
      detail = set.reject_reason;
      break;
    case 'cancel':
      need('pending', 'confirmed');
      set.status = 'cancelled'; set.customer_message = msg || 'This booking was cancelled.';
      detail = msg;
      break;
    case 'handover':
      need('confirmed');
      set.status = 'ongoing';
      set.assigned_reg = str(d.assigned_reg || b.assigned_reg, 20).toUpperCase() || null;
      if (!set.assigned_reg) throw bad('Enter the registration number of the vehicle handed over.');
      set.handover_km = int(d.km); set.fuel_out = str(d.fuel, 20) || 'Full';
      set.deposit_collected = int(d.deposit_collected ?? b.deposit);
      set.customer_message = null;
      detail = `${set.assigned_reg}, ${set.handover_km ?? '?'} km, deposit ₹${set.deposit_collected ?? 0}`;
      break;
    case 'complete':
      need('ongoing');
      set.status = 'completed';
      set.return_km = int(d.km); set.damage_notes = str(d.damage_notes, 600) || null;
      set.deposit_refunded = int(d.deposit_refunded ?? b.deposit_collected ?? b.deposit);
      detail = `${set.return_km ?? '?'} km, refunded ₹${set.deposit_refunded ?? 0}${set.damage_notes ? ', ' + set.damage_notes : ''}`;
      break;
    case 'refund':
      need('cancelled', 'rejected');
      set.payment_status = 'refunded';
      detail = d.amount != null ? '₹' + int(d.amount) : '';
      break;
    case 'message':
      set.customer_message = msg || null;
      detail = msg;
      break;
    case 'note': {
      const t = str(d.text, 1000);
      if (!t) throw bad('Write a note first.');
      set.admin_notes = ((b.admin_notes ? b.admin_notes + '\n' : '') + `[${nowIST().replace('T', ' ')}] ${t}`).slice(-8000);
      detail = t;
      break;
    }
    case 'assign':
      set.assigned_reg = str(d.assigned_reg, 20).toUpperCase() || null;
      detail = set.assigned_reg || 'cleared';
      break;
    case 'reschedule': {
      need('pending', 'confirmed', 'ongoing');
      const start = String(d.start || b.start_at), end = String(d.end || b.end_at);
      if (!isFinite(parseLocal(start)) || !isFinite(parseLocal(end)) || parseLocal(end) <= parseLocal(start)) throw bad('Check the new dates.');
      // Vehicles: keep the booked ones, or swap a single-vehicle booking to another model.
      const current = await bookingItems(env, b.id);
      const wanted = current.length === 1 && current[0].qty === 1 && d.vehicle_id ? [{ vehicle_id: String(d.vehicle_id), qty: 1 }] : current;
      const items = [];
      for (const it of wanted) {
        const vehicle = await env.DB.prepare('SELECT * FROM vehicles WHERE id = ?').bind(it.vehicle_id).first();
        if (!vehicle) throw bad('Unknown vehicle.');
        const used = await peakBooked(env, vehicle.id, start, end, b.id);
        if (used + it.qty > vehicle.units && !d.force) throw new HttpError(409, `Not enough ${vehicle.name} free for part of that time (${Math.max(0, vehicle.units - used)} of ${vehicle.units}). Tick "override" to save anyway.`);
        items.push({ vehicle, qty: it.qty });
      }
      const settings = await getSettings(env);
      const q = quote({ items, start, end, delivery: b.handover === 'delivery', collection: b.return_mode === 'collection', settings });
      Object.assign(set, { start_at: start, end_at: end, days: q.days, vehicle_id: items[0].vehicle.id, vehicle_name: itemsSummary(q.items),
        rent: q.rent, guide_fee: q.guide_fee, delivery_fee: q.delivery_fee, collection_fee: q.collection_fee, total: q.total, deposit: q.deposit });
      await env.DB.batch([
        env.DB.prepare('DELETE FROM booking_items WHERE booking_id = ?').bind(b.id),
        ...q.items.map((i) => env.DB.prepare('INSERT INTO booking_items (booking_id, vehicle_id, vehicle_name, qty, day_rate, rent, deposit) VALUES (?,?,?,?,?,?,?)')
          .bind(b.id, i.vehicle_id, i.name, i.qty, i.day_rate, i.rent, i.deposit)),
      ]);
      detail = `${itemsSummary(q.items)}, ${start} → ${end}, total ₹${q.total} (was ₹${b.total})`;
      break;
    }
    default:
      throw bad('Unknown action.');
  }

  const keys = Object.keys(set);
  if (keys.length) {
    await env.DB.prepare(`UPDATE bookings SET ${keys.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map((k) => set[k]), now, b.id).run();
  }
  const eventName = { confirm: 'confirmed', verify_payment: 'payment_verified', verify_docs: 'docs_verified', request_reupload: 'reupload_requested', reject: 'rejected', cancel: 'cancelled', handover: 'handover', complete: 'completed' }[action] || action;
  await logEvent(env, b.id, 'admin', eventName, detail);
  return bookingDetail(env, b.id);
}

async function serveFile(env, id, url) {
  const f = await getFile(env, id);
  if (!f) throw new HttpError(404, 'File not found.');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' }[f.row.mime] || 'bin';
  const disp = url.searchParams.get('download') ? 'attachment' : 'inline';
  return new Response(f.body, {
    headers: {
      'content-type': f.row.mime,
      'content-disposition': `${disp}; filename="${f.row.kind}-${id.slice(0, 6)}.${ext}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

/* ---------------- push notifications ---------------- */
async function pushInfo(env) {
  const [{ publicKey }, { results }] = await Promise.all([
    vapidKeys(env),
    env.DB.prepare('SELECT id, endpoint, label, created_at, last_ok_at FROM push_subs ORDER BY id').all(),
  ]);
  return json({ publicKey, devices: results || [] });
}

async function pushSubscribe(env, d) {
  const s = d.subscription || {};
  const endpoint = String(s.endpoint || '');
  const p256dh = String(s.keys?.p256dh || ''), auth = String(s.keys?.auth || '');
  if (!validEndpoint(endpoint)) throw bad('This browser\'s push service isn\'t supported.');
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,30}$/.test(auth)) throw bad('Invalid subscription keys.');
  await env.DB.prepare(`INSERT INTO push_subs (endpoint, p256dh, auth, label, created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`)
    .bind(endpoint, p256dh, auth, str(d.label, 60) || 'Device', nowISO()).run();
  return pushInfo(env);
}

async function pushRemove(env, d) {
  if (d.endpoint) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(String(d.endpoint)).run();
  else if (int(d.id) != null) await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(int(d.id)).run();
  return pushInfo(env);
}

async function saveVehicle(env, d) {
  const id = str(d.id, 60).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  const name = str(d.name, 80);
  if (!id || !name) throw bad('A vehicle needs an ID and a name.');
  const day_rate = int(d.day_rate), units = int(d.units);
  const existing = await env.DB.prepare('SELECT week_rate, month_rate FROM vehicles WHERE id = ?').bind(id).first();
  // A form that doesn't send these keeps the vehicle's current weekly / monthly price.
  const week_rate = ('week_rate' in d ? int(d.week_rate) : existing?.week_rate) || 0;
  const month_rate = ('month_rate' in d ? int(d.month_rate) : existing?.month_rate) || 0;
  let deposit = int(d.deposit);
  if (deposit == null) deposit = int((await getSettings(env)).default_deposit) ?? 0;
  if (!day_rate) throw bad('Enter a day rate.');
  if (units == null) throw bad('Enter how many of this vehicle you have.');
  await env.DB.prepare(`INSERT INTO vehicles (id, name, category, tagline, image, day_rate, week_rate, month_rate, deposit, units, active, sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, tagline=excluded.tagline, image=excluded.image,
        day_rate=excluded.day_rate, week_rate=excluded.week_rate, month_rate=excluded.month_rate, deposit=excluded.deposit, units=excluded.units, active=excluded.active, sort=excluded.sort`)
    .bind(id, name, str(d.category, 60) || 'Scooty', str(d.tagline, 160) || null, str(d.image, 300) || null, day_rate, week_rate, month_rate, deposit ?? 0, units, d.active === false || d.active === 0 ? 0 : 1, int(d.sort) ?? 0).run();
  return json({ ok: true, vehicles: await listVehicles(env, { all: true }) });
}

async function updateSettings(env, d) {
  const patch = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (k === 'qr_file_id' || !(k in d)) continue;
    patch[k] = str(d[k], 300);
  }
  if ('upi_id' in patch && patch.upi_id && !/^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/.test(patch.upi_id)) throw bad('That UPI ID doesn\'t look right (example: cloudtrails@okicici).');
  if ('pay_mode' in patch && !['rent', 'rent_deposit', 'advance', 'none'].includes(patch.pay_mode)) throw bad('Unknown payment mode.');
  for (const k of ['default_deposit', 'week_rate_scooty', 'month_rate_scooty', 'delivery_fee', 'collection_fee', 'advance_amount', 'open_hour', 'close_hour', 'min_lead_hours', 'max_days', 'doc_retention_days']) {
    if (k in patch && (patch[k] === '' || int(patch[k]) == null)) throw bad(`${k.replace(/_/g, ' ')} must be a number.`);
  }
  if ('whatsapp' in patch) patch.whatsapp = patch.whatsapp.replace(/\D/g, '');
  const before = await getSettings(env);
  await saveSettings(env, patch);
  // A new deposit amount applies to every vehicle (one vehicle can still be changed in Fleet & prices).
  if ('default_deposit' in patch && (patch.default_deposit !== before.default_deposit || d.apply_deposit_all)) {
    await env.DB.prepare('UPDATE vehicles SET deposit = ?').bind(int(patch.default_deposit)).run();
  }
  // A new weekly price applies to every scooty (bikes have their own, set in Fleet & prices).
  if ('week_rate_scooty' in patch && (patch.week_rate_scooty !== before.week_rate_scooty || d.apply_week_all)) {
    await env.DB.prepare("UPDATE vehicles SET week_rate = ? WHERE category LIKE 'Scooty%'").bind(int(patch.week_rate_scooty)).run();
  }
  if ('month_rate_scooty' in patch && (patch.month_rate_scooty !== before.month_rate_scooty || d.apply_month_all)) {
    await env.DB.prepare("UPDATE vehicles SET month_rate = ? WHERE category LIKE 'Scooty%'").bind(int(patch.month_rate_scooty)).run();
  }
  return json({ ok: true, settings: await getSettings(env) });
}

async function uploadQr(request, env) {
  const form = await request.formData();
  const file = form.get('qr');
  if (!file || typeof file === 'string') throw bad('Choose your UPI QR image.');
  if (file.size > 3 * 1024 * 1024) throw bad('QR image must be under 3 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw bad('Upload the QR as a JPG or PNG.');
  const s = await getSettings(env);
  if (s.qr_file_id) await deleteFile(env, s.qr_file_id);
  const id = await putFile(env, { bookingId: null, kind: 'qr', mime, bytes });
  await saveSettings(env, { qr_file_id: id });
  return json({ ok: true, settings: await getSettings(env) });
}

async function schedule(env, url) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : nowIST().slice(0, 10);
  const next = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
  const cols = 'id, ref, status, payment_status, docs_status, vehicle_name, guide, start_at, end_at, handover, handover_address, handover_landmark, return_mode, return_address, name, phone, assigned_reg, total, pay_now, deposit';
  const [{ results: out }, { results: back }, { results: overdue }] = await Promise.all([
    env.DB.prepare(`SELECT ${cols} FROM bookings WHERE status IN ('pending','confirmed') AND start_at >= ? AND start_at < ? ORDER BY start_at`).bind(date, next).all(),
    env.DB.prepare(`SELECT ${cols} FROM bookings WHERE status = 'ongoing' AND end_at >= ? AND end_at < ? ORDER BY end_at`).bind(date, next).all(),
    env.DB.prepare(`SELECT ${cols} FROM bookings WHERE status = 'ongoing' AND end_at < ? ORDER BY end_at`).bind(nowIST()).all(),
  ]);
  return json({ date, handovers: out || [], returns: back || [], overdue: overdue || [] });
}

async function calendar(env, url) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : nowIST().slice(0, 10);
  const days = Math.min(31, Math.max(1, Number(url.searchParams.get('days')) || 14));
  const dates = Array.from({ length: days }, (_, i) => new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10));
  const end = new Date(Date.parse(from) + days * 86400000).toISOString().slice(0, 10);
  const vehicles = await listVehicles(env, { all: true });
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.ref, b.name, b.status, b.start_at, b.end_at, i.vehicle_id, i.qty FROM booking_items i JOIN bookings b ON b.id = i.booking_id
      WHERE b.status IN ('pending','confirmed','ongoing') AND b.start_at < ? AND b.end_at > ? ORDER BY b.start_at`).bind(end, from).all();
  const rows = vehicles.map((v) => {
    const mine = (results || []).filter((r) => r.vehicle_id === v.id);
    const cells = dates.map((d) => peakOf(mine.filter((r) => r.start_at < d + 'T23:59' && r.end_at > d + 'T00:00'), d + 'T00:00', d + 'T23:59'));
    const bookings = mine.map((r) => ({ id: r.id, ref: r.ref, name: r.name, status: r.status, start: r.start_at, end: r.end_at, qty: r.qty }));
    return { id: v.id, name: v.name, units: v.units, active: v.active, image: v.image, cells, bookings };
  });
  return json({ from, dates, rows, today: nowIST().slice(0, 10) });
}

async function exportCsv(env, url) {
  const from = url.searchParams.get('from') || '0000-00-00';
  const to = url.searchParams.get('to') || '9999-12-31';
  const { results } = await env.DB.prepare(`SELECT ref, status, payment_status, docs_status, vehicle_name, guide, start_at, end_at, days, handover, handover_address,
      return_mode, return_address, name, phone, email, licence_no, id_type, rent, guide_fee, delivery_fee, collection_fee, total, deposit, pay_now,
      paid_amount, upi_utr, deposit_collected, deposit_refunded, assigned_reg, handover_km, return_km, damage_notes, created_at
      FROM bookings WHERE start_at >= ? AND start_at <= ? ORDER BY start_at`).bind(from, to + 'T23:59').all();
  const rows = results || [];
  const head = rows.length ? Object.keys(rows[0]) : ['ref'];
  const csv = [head.join(','), ...rows.map((r) => head.map((h) => csvCell(r[h])).join(','))].join('\r\n');
  return new Response('﻿' + csv, {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="cloudtrails-bookings-${from}-to-${to}.csv"`, 'cache-control': 'no-store' },
  });
}

