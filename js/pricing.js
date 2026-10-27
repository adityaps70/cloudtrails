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

/**
 * @param {object} p
 * @param {{day_rate:number, deposit:number, name:string}} p.vehicle
 * @param {string} p.start  "YYYY-MM-DDTHH:MM" (India time)
 * @param {string} p.end
 * @param {boolean} p.guide
 * @param {boolean} p.delivery    vehicle delivered to the customer
 * @param {boolean} p.collection  vehicle collected from the customer at the end
 * @param {object} p.settings     { guide_rate, delivery_fee, collection_fee, pay_mode, advance_amount }
 */
export function quote({ vehicle, start, end, guide, delivery, collection, settings }) {
  const s = settings || {};
  const days = rentalDays(start, end);
  const rent = rentFor(vehicle?.day_rate, days);
  const guide_fee = guide ? rentFor(Number(s.guide_rate ?? 1000), days) : 0;
  const delivery_fee = delivery ? Number(s.delivery_fee ?? 200) : 0;
  const collection_fee = collection ? Number(s.collection_fee ?? 200) : 0;
  const total = rent + guide_fee + delivery_fee + collection_fee;
  const deposit = Number(vehicle?.deposit) || 0;

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
    lines.push({ label: `${vehicle?.name || 'Vehicle'} × ${days} day${days > 1 ? 's' : ''}${tag ? ' · ' + tag : ''}`, amount: rent });
    if (guide_fee) lines.push({ label: `Local guide × ${days} day${days > 1 ? 's' : ''}`, amount: guide_fee });
    if (delivery_fee) lines.push({ label: 'Doorstep delivery', amount: delivery_fee });
    if (collection_fee) lines.push({ label: 'Doorstep collection at return', amount: collection_fee });
  }
  return { days, rent, guide_fee, delivery_fee, collection_fee, total, deposit, pay_now, pay_later, lines };
}

export function inr(n) {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
}
