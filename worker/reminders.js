// Return reminders for the admin (push notifications), so the team can remind customers to bring vehicles back.
//
//   Rentals of up to 3 days  : 4 hours before the return time
//   Rentals of 4–14 days     : 1 day before, and 4 hours before
//   Rentals of 15 days or more: 5 days before, 1 day before, and 4 hours before
//
// Runs from the Worker's 15-minute cron. Each reminder is sent once per return time
// (if the booking is rescheduled, the reminders for the new time are sent again).

import { ensureSchema, logEvent, nowISO } from './db.js';
import { notifyAdmins } from './push.js';
import { nowIST, parseLocal } from '../js/pricing.js';

const H = 3600 * 1000;
export const REMINDER_KINDS = {
  '5d': { before: 5 * 24 * H, label: '5 days' },
  '1d': { before: 24 * H, label: '1 day' },
  '4h': { before: 4 * H, label: '4 hours' },
};

/** Which reminders a rental of `days` days gets. */
export function remindersFor(days) {
  if (days >= 15) return ['5d', '1d', '4h'];
  if (days >= 4) return ['1d', '4h'];
  return ['4h'];
}

function when(s) {
  const t = parseLocal(s);
  if (!isFinite(t)) return s;
  const d = new Date(t);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) + ', ' +
    d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

export function reminderMessage(b, kind) {
  const left = REMINDER_KINDS[kind].label;
  const ret = b.return_mode === 'collection' ? `Collect from ${b.return_address || 'customer'}` : 'Return at the counter';
  return {
    title: `Return in ${left}: ${b.ref}`,
    body: `${b.name} · ${b.phone}\n${b.vehicle_name} due back ${when(b.end_at)}. ${ret}. Tap to send them a reminder.`,
    url: `/admin/#/booking/${b.id}`,
    tag: `return-${b.ref}-${kind}`,
  };
}

/** Send any reminders that are due now. Returns how many were sent. */
export async function sendReturnReminders(env, now = nowIST()) {
  await ensureSchema(env);
  const nowT = parseLocal(now);
  const horizon = new Date(nowT + REMINDER_KINDS['5d'].before + H).toISOString().slice(0, 16);
  const { results } = await env.DB.prepare(
    `SELECT id, ref, name, phone, vehicle_name, start_at, end_at, days, return_mode, return_address FROM bookings
     WHERE status IN ('confirmed','ongoing') AND end_at > ? AND end_at <= ?`).bind(now, horizon).all();
  let sent = 0;
  for (const b of results || []) {
    const endT = parseLocal(b.end_at);
    const kinds = remindersFor(Number(b.days) || 1);
    // Reminders whose time has come (latest first); only the closest one is sent, older ones are marked done.
    const due = kinds.filter((k) => nowT >= endT - REMINDER_KINDS[k].before);
    if (!due.length) continue;
    const { results: done } = await env.DB.prepare('SELECT kind FROM reminders_sent WHERE booking_id = ? AND end_at = ?').bind(b.id, b.end_at).all();
    const doneSet = new Set((done || []).map((r) => r.kind));
    const pending = due.filter((k) => !doneSet.has(k));
    if (!pending.length) continue;
    const closest = pending[pending.length - 1]; // kinds are ordered from earliest to latest reminder
    await env.DB.batch(pending.map((k) =>
      env.DB.prepare('INSERT OR IGNORE INTO reminders_sent (booking_id, kind, end_at, sent_at) VALUES (?,?,?,?)').bind(b.id, k, b.end_at, nowISO())));
    const r = await notifyAdmins(env, reminderMessage(b, closest));
    await logEvent(env, b.id, 'system', 'return_reminder', `${REMINDER_KINDS[closest].label} before return — sent to ${r.sent} device${r.sent === 1 ? '' : 's'}`);
    sent++;
  }
  return sent;
}
