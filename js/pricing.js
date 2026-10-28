// Cloud Trails pricing — shared by the booking page (browser) and the Worker (server).
// The server always recalculates; the browser copy is only for showing the live total.
//
// Rules:
//   1–6 days  : day rate × days
//   7+ days   : the vehicle's weekly price per day (e.g. scooty ₹600 instead of ₹700), if it has one
//   30+ days  : the vehicle's monthly price per 30 days, pro-rated per day (e.g. scooty ₹15,000 = ₹500/day), if it has one
// The cheapest price that applies is used.
// A rental day is 24 hours, with a 1-hour grace period before the next day is charged.

export const IST_OFFSET_MS = 330 * 60 * 1000;

/** Parse "YYYY-MM-DDTHH:MM" as a wall-clock time (no timezone) into minutes since epoch-ish. */
export function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** Current wall-clock time in India as "YYYY-MM-DDTHH:MM". */
export function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 16);
}

export function rentalDays(start, end) {
  const a = parseLocal(start), b = parseLocal(end);
  if (!isFinite(a) || !isFinite(b) || b <= a) return 0;
  const hours = (b - a) / 3600000;
  return Math.max(1, Math.ceil((hours - 1) / 24));
}

/**
 * Rent for one vehicle over `days` days, and which price was used.
 * @returns {{ rent:number, per:number, tier:'day'|'week'|'month' }}
 */
export function priceFor(vehicle, days) {
  const day = Number(vehicle?.day_rate) || 0;
  const w = Number(vehicle?.week_rate) || 0;
  const m = Number(vehicle?.month_rate) || 0;
  if (days <= 0) return { rent: 0, per: day, tier: 'day' };
  let best = { rent: day * days, tier: 'day' };
  if (days >= 7 && w > 0 && w * days < best.rent) best = { rent: w * days, tier: 'week' };
  if (days >= 30 && m > 0 && Math.round((m * days) / 30) < best.rent) best = { rent: Math.round((m * days) / 30), tier: 'month' };
  return { ...best, per: Math.round(best.rent / days) };
}

/** Price per day for a rental of `days` days (after any weekly / monthly price). */
export function perDay(dayRate, days, weekRate, monthRate) {
  return priceFor({ day_rate: dayRate, week_rate: weekRate, month_rate: monthRate }, days).per;
}

export function rentFor(dayRate, days, weekRate, monthRate) {
  return priceFor({ day_rate: dayRate, week_rate: weekRate, month_rate: monthRate }, days).rent;
}

/**
 * @param {object} p
 * @param {Array<{vehicle:{id?:string, day_rate:number, week_rate?:number, month_rate?:number, deposit:number, name:string}, qty:number}>} [p.items]
 *        the vehicles in the booking (several of the same model = qty)
 * @param {{day_rate:number, deposit:number, name:string}} [p.vehicle]  single vehicle (older callers)
 * @param {string} p.start  "YYYY-MM-DDTHH:MM" (India time)
 * @param {string} p.end
 * @param {boolean} p.delivery    vehicles delivered to the customer (one flat fee per booking)
 * @param {boolean} p.collection  vehicles collected from the customer at the end (one flat fee per booking)
 * @param {object} p.settings     { delivery_fee, collection_fee, pay_mode, advance_amount }
 */
export function quote({ items, vehicle, start, end, delivery, collection, settings }) {
  const s = settings || {};
  const days = rentalDays(start, end);
  if (!items) items = vehicle ? [{ vehicle, qty: 1 }] : [];
  const list = items
    .map((i) => ({ vehicle: i.vehicle, qty: Math.max(0, Math.floor(Number(i.qty) || 0)) }))
    .filter((i) => i.vehicle && i.qty > 0)
    .map((i) => {
      const p = priceFor(i.vehicle, days);
      const each = p.rent;
      return {
        vehicle_id: i.vehicle.id, name: i.vehicle.name, qty: i.qty, day_rate: p.per, tier: p.tier, month_rate: Number(i.vehicle.month_rate) || 0,
        rent: each * i.qty, deposit: (Number(i.vehicle.deposit) || 0) * i.qty,
        full: (Number(i.vehicle.day_rate) || 0) * days * i.qty,
      };
    });
  const qty = list.reduce((a, i) => a + i.qty, 0);
  const rent = list.reduce((a, i) => a + i.rent, 0);
  const deposit = list.reduce((a, i) => a + i.deposit, 0);
  const guide_fee = 0; // guides are no longer offered; kept so older bookings still add up
  const delivery_fee = delivery ? Number(s.delivery_fee ?? 200) : 0;
  const collection_fee = collection ? Number(s.collection_fee ?? 200) : 0;
  const total = rent + guide_fee + delivery_fee + collection_fee;
  const savings = list.reduce((a, i) => a + i.full - i.rent, 0);

  let pay_now;
  switch (s.pay_mode) {
    case 'rent_deposit': pay_now = total + deposit; break;
    case 'advance': pay_now = Math.min(total, Number(s.advance_amount) || 500); break;
    case 'none': pay_now = 0; break;
    default: pay_now = total; // 'rent' — pay rent + fees online, deposit at handover
  }
  const pay_later = total + deposit - pay_now;

  const lines = [];
  if (days) {
    const d = `${days} day${days > 1 ? 's' : ''}`;
    for (const i of list) lines.push({ label: `${i.qty > 1 ? i.qty + ' × ' : ''}${i.name} · ${d}${i.tier === 'week' ? ` · weekly price ${inr(i.day_rate)}/day` : i.tier === 'month' ? ` · monthly price ${inr(i.month_rate)}/30 days` : ''}`, amount: i.rent });
    if (delivery_fee) lines.push({ label: 'Doorstep delivery', amount: delivery_fee });
    if (collection_fee) lines.push({ label: 'Doorstep collection at return', amount: collection_fee });
  }
  return { days, qty, items: list, rent, guide_fee, delivery_fee, collection_fee, total, deposit, pay_now, pay_later, savings, lines };
}

/** "2 × TVS NTORQ 125 + Royal Enfield Hunter 350" */
export function itemsSummary(items) {
  return (items || []).filter((i) => i.qty > 0).map((i) => `${i.qty > 1 ? i.qty + ' × ' : ''}${i.name || i.vehicle_name || i.vehicle?.name}`).join(' + ');
}

export function inr(n) {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
}
