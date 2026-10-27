// Optional email alert for new bookings, sent through Resend (https://resend.com).
// Needs the secret RESEND_API_KEY and an address in Admin → Settings → "Alert email".
// Without them nothing is sent; new bookings still appear in the admin panel.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function notifyNewBooking(env, settings, b, origin) {
  if (!env.RESEND_API_KEY || !settings.notify_email) return;
  const from = env.NOTIFY_FROM || 'Cloud Trails Bookings <onboarding@resend.dev>';
  const link = `${origin}/admin/#/booking/${b.id}`;
  const html = `
    <h2>New booking ${esc(b.ref)}</h2>
    <p><b>${esc(b.name)}</b> · ${esc(b.phone)}</p>
    <p>${esc(b.vehicle_name)}${b.guide ? ' + guide' : ''}<br>${esc(b.start_at.replace('T', ' '))} → ${esc(b.end_at.replace('T', ' '))} (${b.days} day${b.days > 1 ? 's' : ''})</p>
    <p>${b.handover === 'delivery' ? 'Doorstep delivery: ' + esc(b.handover_address) : 'Pickup at counter'}<br>
       ${b.return_mode === 'collection' ? 'Collection from: ' + esc(b.return_address) : 'Return at counter'}</p>
    <p>Total ₹${b.total} · pay now ₹${b.pay_now} · deposit ₹${b.deposit} · payment: ${esc(b.payment_status)}${b.upi_utr ? ' (UTR ' + esc(b.upi_utr) + ')' : ''}</p>
    <p><a href="${esc(link)}">Open in admin</a></p>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: settings.notify_email.split(',').map((s) => s.trim()).filter(Boolean), subject: `New booking ${b.ref} — ${b.name}, ${b.vehicle_name}`, html }),
  });
}
