-- Cloud Trails booking schema (Cloudflare D1). Generated from worker/db.js; the Worker also creates these tables on first use
-- and adds the later columns (bookings.riders, bookings.vehicle_count).
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Scooty', tagline TEXT, image TEXT,
  day_rate INTEGER NOT NULL, deposit INTEGER NOT NULL DEFAULT 0, units INTEGER NOT NULL DEFAULT 1,
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
