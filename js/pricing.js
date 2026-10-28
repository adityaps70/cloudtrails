// Cloud Trails pricing — shared by the booking page (browser) and the Worker (server).
// The server always recalculates; the browser copy is only for showing the live total.
//
// Rules (match the pricing table on the site):
//   1–2 days  : day rate × days
//   3–6 days  : 10% off the day rate        (scooty 3 days = ₹1,890)
//   7+ days   : weekly rate = 5.5 × day rate (scooty 7 days = ₹3,850), pro-rated per extra day
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

export function rentFor(dayRate, days) {
  dayRate = Number(dayRate) || 0;
  if (days <= 0) return 0;
  if (days < 3) return dayRate * days;
  if (days < 7) return Math.round(dayRate * 0.9) * days;
  return Math.round((dayRate * 5.5 * days) / 7);
}

export function discountLabel(days) {
  if (days >= 7) return 'Weekly rate';
  if (days >= 3) return '10% multi-day discount';
  return '';
}

/** Effective price per day for a rental of `days` days (after the multi-day / weekly discount). */
export function perDay(dayRate, days) {
  return days > 0 ? Math.round(rentFor(dayRate, days) / days) : Number(dayRate) || 0;
}

/**
 * @param {object} p
 * @param {Array<{vehicle:{id?:string, day_rate:number, deposit:number, name:string}, qty:number}>} [p.items]
 *        the vehicles in the booking (several of the same model = qty)
 * @param {{day_rate:number, deposit:number, name:string}} [p.vehicle]  single vehicle (older callers)
 * @param {string} p.start  "YYYY-MM-DDTHH:MM" (India time)
 * @param {string} p.end
 * @param {boolean} p.guide       one local guide rides with the group
 * @param {boolean} p.delivery    vehicles delivered to the customer (one flat fee per booking)
 * @param {boolean} p.collection  vehicles collected from the customer at the end (one flat fee per booking)
 * @param {object} p.settings     { guide_rate, delivery_fee, collection_fee, pay_mode, advance_amount }
 */
export function quote({ items, vehicle, start, end, guide, delivery, collection, settings }) {
  const s = settings || {};
  const days = rentalDays(start, end);
  if (!items) items = vehicle ? [{ vehicle, qty: 1 }] : [];
  const list = items
    .map((i) => ({ vehicle: i.vehicle, qty: Math.max(0, Math.floor(Number(i.qty) || 0)) }))
    .filter((i) => i.vehicle && i.qty > 0)
    .map((i) => {
      const each = rentFor(i.vehicle.day_rate, days);
      return {
        vehicle_id: i.vehicle.id, name: i.vehicle.name, qty: i.qty, day_rate: Number(i.vehicle.day_rate) || 0,
        rent: each * i.qty, deposit: (Number(i.vehicle.deposit) || 0) * i.qty,
        full: (Number(i.vehicle.day_rate) || 0) * days * i.qty,
      };
    });
  const qty = list.reduce((a, i) => a + i.qty, 0);
  const rent = list.reduce((a, i) => a + i.rent, 0);
  const deposit = list.reduce((a, i) => a + i.deposit, 0);
  const guide_fee = guide ? rentFor(Number(s.guide_rate ?? 1000), days) : 0;
  const delivery_fee = delivery ? Number(s.delivery_fee ?? 200) : 0;
  const collection_fee = collection ? Number(s.collection_fee ?? 200) : 0;
  const total = rent + guide_fee + delivery_fee + collection_fee;
  const savings = list.reduce((a, i) => a + i.full - i.rent, 0) + (guide ? Number(s.guide_rate ?? 1000) * days - guide_fee : 0);

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
    const tag = discountLabel(days);
    const d = `${days} day${days > 1 ? 's' : ''}`;
    for (const i of list) lines.push({ label: `${i.qty > 1 ? i.qty + ' × ' : ''}${i.name} · ${d}${tag ? ' · ' + tag : ''}`, amount: i.rent });
    if (guide_fee) lines.push({ label: `Local guide · ${d}`, amount: guide_fee });
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
