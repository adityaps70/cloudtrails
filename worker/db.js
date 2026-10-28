// D1 schema, seed data and small query helpers.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Scooty', tagline TEXT, image TEXT,
  day_rate INTEGER NOT NULL, week_rate INTEGER NOT NULL DEFAULT 0, month_rate INTEGER NOT NULL DEFAULT 0, deposit INTEGER NOT NULL DEFAULT 0, units INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', payment_status TEXT NOT NULL DEFAULT 'submitted',
  docs_status TEXT NOT NULL DEFAULT 'submitted', reupload_kinds TEXT, customer_message TEXT,
  vehicle_id TEXT NOT NULL, vehicle_name TEXT NOT NULL, guide INTEGER NOT NULL DEFAULT 0,
  start_at TEXT NOT NULL, end_at TEXT NOT NULL, days INTEGER NOT NULL,
  handover TEXT NOT NULL DEFAULT 'pickup', handover_address TEXT, handover_landmark TEXT,
  return_mode TEXT NOT NULL DEFAULT 'counter', return_address TEXT,
  name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, dob TEXT, address TEXT, hometown TEXT,
  emergency_name TEXT, emergency_phone TEXT, licence_no TEXT, licence_expiry TEXT, id_type TEXT,
  pillion_name TEXT, notes TEXT,
  rent INTEGER NOT NULL DEFAULT 0, guide_fee INTEGER NOT NULL DEFAULT 0, delivery_fee INTEGER NOT NULL DEFAULT 0,
  collection_fee INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, deposit INTEGER NOT NULL DEFAULT 0,
  pay_now INTEGER NOT NULL DEFAULT 0, upi_utr TEXT, paid_amount INTEGER, deposit_collected INTEGER, deposit_refunded INTEGER,
  consent_name TEXT, consent_at TEXT, consent_ip TEXT, consent_ua TEXT, terms_version TEXT, terms_hash TEXT,
  assigned_reg TEXT, handover_km INTEGER, return_km INTEGER, fuel_out TEXT, damage_notes TEXT,
  reject_reason TEXT, admin_notes TEXT, docs_purged_at TEXT, created_ip TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_vehicle_time ON bookings (vehicle_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings (created_at);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, booking_id INTEGER, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_booking ON files (booking_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_booking ON events (booking_id);
CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS booking_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER NOT NULL, vehicle_id TEXT NOT NULL, vehicle_name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1, day_rate INTEGER NOT NULL DEFAULT 0, rent INTEGER NOT NULL DEFAULT 0, deposit INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_booking ON booking_items (booking_id);
CREATE INDEX IF NOT EXISTS idx_items_vehicle ON booking_items (vehicle_id);
`;

// Columns added after the first release (SQLite has no "ADD COLUMN IF NOT EXISTS").
const ADDED_COLUMNS = {
  bookings: { riders: 'TEXT', vehicle_count: 'INTEGER NOT NULL DEFAULT 1' },
  vehicles: {
    week_rate: 'INTEGER NOT NULL DEFAULT 0',   // ₹/day on bookings of 7+ days (0 = no weekly price)
    month_rate: 'INTEGER NOT NULL DEFAULT 0',  // ₹ per 30 days on bookings of 30+ days (0 = no monthly price)
  },
};

export const SEED_VEHICLES = [
  { id: 'yamaha-rayzr-125', name: 'Yamaha RayZR 125', category: 'Scooty · Automatic', image: 'images/thumbs/fleet-yamaha-rayzr-125.jpg', day_rate: 700, week_rate: 600, month_rate: 15000, deposit: 1000, units: 5, sort: 1 },
  { id: 'suzuki-avenis-125', name: 'Suzuki Avenis 125', category: 'Scooty · Automatic', image: 'images/thumbs/fleet-suzuki-avenis-125.jpg', day_rate: 700, week_rate: 600, month_rate: 15000, deposit: 1000, units: 5, sort: 2 },
  { id: 'suzuki-burgman-street-125', name: 'Suzuki Burgman Street 125', category: 'Scooty · Maxi comfort', image: 'images/thumbs/fleet-suzuki-burgman-street-125.jpg', day_rate: 700, week_rate: 600, month_rate: 15000, deposit: 1000, units: 5, sort: 3 },
  { id: 'tvs-ntorq-125', name: 'TVS NTORQ 125', category: 'Scooty · Sporty', image: 'images/thumbs/fleet-tvs-ntorq-125.jpg', day_rate: 700, week_rate: 600, month_rate: 15000, deposit: 1000, units: 5, sort: 4 },
  { id: 'royal-enfield-hunter-350', name: 'Royal Enfield Hunter 350', category: 'Bike · 350cc', image: 'images/thumbs/fleet-royal-enfield-hunter-350.jpg', day_rate: 1500, week_rate: 0, month_rate: 0, deposit: 1000, units: 3, sort: 5 },
];

export const DEFAULT_SETTINGS = {
  booking_enabled: '1',
  business_name: 'Cloud Trails Rentals',
  whatsapp: '918257929949',   // business phone (with country code)
  upi_id: '',
  upi_payee: 'Cloud Trails Rentals',
  pay_mode: 'rent',          // rent | rent_deposit | advance | none
  advance_amount: '500',
  week_rate_scooty: '600',  // ₹/day for scooties on 7+ day bookings; saving a new value updates every scooty
  month_rate_scooty: '15000', // ₹ per 30 days for scooties on 30+ day bookings; saving a new value updates every scooty
  default_deposit: '1000',  // refundable deposit per vehicle; saving a new value updates every vehicle
  delivery_fee: '200',
  collection_fee: '200',
  delivery_area: 'Anywhere within Shillong city',
  counter_address: 'La Shimti, Mawdiangdiang (Golf Links area), New Shillong, Meghalaya 793018',
  open_hour: '9',
  close_hour: '22',
  min_lead_hours: '2',
  max_days: '30',
  doc_retention_days: '30',
  notify_email: '',
  qr_file_id: '',
  qr_static_path: '',      // a QR image shipped with the site (e.g. images/upi-qr.png), used when none is uploaded
};

// Settings the public booking page may see.
export const PUBLIC_SETTINGS = [
  'booking_enabled', 'business_name', 'whatsapp', 'upi_id', 'upi_payee', 'pay_mode', 'advance_amount',
  'delivery_fee', 'collection_fee', 'delivery_area', 'counter_address', 'open_hour', 'close_hour', 'min_lead_hours', 'max_days',
];

const schemaReadyFor = new WeakMap();

export function ensureSchema(env) {
  let schemaReady = schemaReadyFor.get(env.DB);
  if (!schemaReady) {
    schemaReady = (async () => {
      const statements = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
      await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
      for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
        const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        const have = new Set((results || []).map((r) => r.name));
        for (const [col, type] of Object.entries(cols)) {
          if (!have.has(col)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
        }
      }
      // Bookings made before multi-vehicle support: give each one its single line item.
      await env.DB.prepare(`INSERT INTO booking_items (booking_id, vehicle_id, vehicle_name, qty, day_rate, rent, deposit)
        SELECT b.id, b.vehicle_id, b.vehicle_name, 1, 0, b.rent, b.deposit FROM bookings b
        WHERE NOT EXISTS (SELECT 1 FROM booking_items i WHERE i.booking_id = b.id)`).run();
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM vehicles').first();
      if (!row || !row.n) {
        await env.DB.batch(SEED_VEHICLES.map((v) =>
          env.DB.prepare('INSERT OR IGNORE INTO vehicles (id,name,category,tagline,image,day_rate,week_rate,month_rate,deposit,units,active,sort) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)')
            .bind(v.id, v.name, v.category, v.tagline || null, v.image, v.day_rate, v.week_rate || 0, v.month_rate || 0, v.deposit, v.units, v.sort)));
      }
    })().catch((e) => { schemaReadyFor.delete(env.DB); throw e; });
    schemaReadyFor.set(env.DB, schemaReady);
  }
  return schemaReady;
}

export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of results || []) s[r.key] = r.value ?? '';
  return s;
}

export async function saveSettings(env, patch) {
  const keys = Object.keys(patch).filter((k) => k in DEFAULT_SETTINGS);
  if (!keys.length) return;
  await env.DB.batch(keys.map((k) =>
    env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(k, String(patch[k] ?? ''))));
}

export async function listVehicles(env, { all = false } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM vehicles ${all ? '' : 'WHERE active = 1'} ORDER BY sort, name`).all();
  return results || [];
}

export const ACTIVE_STATUSES = ['pending', 'confirmed', 'ongoing'];

/** How many units of a vehicle are booked at any moment between start and end (peak overlap). */
export async function peakBooked(env, vehicleId, start, end, excludeId = 0) {
  const { results } = await env.DB.prepare(
    `SELECT b.start_at, b.end_at, i.qty FROM booking_items i JOIN bookings b ON b.id = i.booking_id
      WHERE i.vehicle_id = ? AND b.status IN ('pending','confirmed','ongoing') AND b.id != ?
        AND b.start_at < ? AND b.end_at > ?`).bind(vehicleId, excludeId, end, start).all();
  return peakOf(results || [], start, end);
}

/** Highest number of vehicles out at the same moment between start and end (rows: start_at, end_at, qty). */
export function peakOf(rows, start, end) {
  if (!rows.length) return 0;
  const points = [];
  for (const r of rows) {
    const q = Number(r.qty) || 1;
    points.push([r.start_at < start ? start : r.start_at, q]);
    points.push([r.end_at > end ? end : r.end_at, -q]);
  }
  // Ends sort before starts at the same instant: a vehicle returned at 10:00 can go out again at 10:00.
  points.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  let cur = 0, peak = 0;
  for (const [, d] of points) { cur += d; peak = Math.max(peak, cur); }
  return peak;
}

export async function bookingItems(env, bookingId) {
  const { results } = await env.DB.prepare('SELECT vehicle_id, vehicle_name, qty, day_rate, rent, deposit FROM booking_items WHERE booking_id = ? ORDER BY id').bind(bookingId).all();
  return results || [];
}

export function nowISO() {
  return new Date().toISOString();
}

export async function logEvent(env, bookingId, actor, action, detail) {
  await env.DB.prepare('INSERT INTO events (booking_id, at, actor, action, detail) VALUES (?,?,?,?,?)')
    .bind(bookingId, nowISO(), actor, action, detail == null ? null : String(detail).slice(0, 2000)).run();
}
