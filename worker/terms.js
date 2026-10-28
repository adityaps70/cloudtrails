// Rental agreement and consent wording shown on the booking page and stored with every booking.
// Change TERMS_VERSION whenever the wording changes — each booking records the version and a hash of what it agreed to.

export const TERMS_VERSION = '2026-10-v2';

export const AGREEMENT = [
  {
    title: 'The rental',
    points: [
      'Cloud Trails Rentals ("Cloud Trails") rents the vehicle named in this booking to the rider for the dates and times shown. A rental day is 24 hours; returns more than 1 hour late are charged at ₹100 per hour, up to one extra day\'s rent.',
      'The vehicle is handed over clean, serviced, with a full tank and two helmets. Fuel, tolls, parking and any permits are the rider\'s cost. Return the vehicle with a full tank, or the shortfall is charged at the pump price plus ₹100.',
      'The refundable security deposit is collected at handover and returned after the vehicle comes back on time, undamaged, with a full tank and all accessories (helmets, keys, documents, rain cover).',
    ],
  },
  {
    title: 'The rider',
    points: [
      'I am at least 18 years old and hold a valid driving licence for this class of vehicle (gearless for scooters, with-gear for motorbikes). The documents I uploaded are genuine and belong to me.',
      'Only I (the named rider) will ride the vehicle. I will carry at most one pillion, and both of us will wear helmets at all times.',
      'I will not ride under the influence of alcohol or drugs, race, perform stunts, ride off-road, carry goods for hire, or sub-let the vehicle.',
      'I will follow traffic rules and the route briefing, avoid the roads Cloud Trails flags as unsafe after dark, and get an Inner Line Permit where one is required.',
      'If I book more than one vehicle, I am responsible for all of them. Each vehicle is ridden only by the rider named for it, who holds a valid licence and follows this agreement.',
    ],
  },
  {
    title: 'Damage, fines and breakdowns',
    points: [
      'I am responsible for any damage to, or loss of, the vehicle and accessories during the rental, up to the cost of repair or replacement at an authorised service centre, and for the days the vehicle is off the road for repair.',
      'Traffic challans, fines, towing and impound charges incurred during the rental are mine to pay, including challans that arrive after the vehicle is returned.',
      'In case of breakdown, accident or theft I will inform Cloud Trails immediately on +91 87308 83206 and will not get the vehicle repaired elsewhere without permission. Theft or accident must also be reported to the police.',
      'Cloud Trails may deduct unpaid charges from the deposit and may recover any amount above the deposit from me.',
    ],
  },
  {
    title: 'Bookings, changes and cancellation',
    points: [
      'A booking is confirmed only after Cloud Trails verifies my documents and payment. Cloud Trails may decline a booking, in which case any amount paid is refunded in full.',
      'Cancellations more than 24 hours before the start time get a full refund of the amount paid; within 24 hours, one day\'s rent is kept. No-shows are not refunded.',
      'For doorstep delivery or collection I will be present at the address given, with my original driving licence and ID for checking. Delivery is offered within Shillong city only.',
    ],
  },
  {
    title: 'My documents and data',
    points: [
      'I consent to Cloud Trails collecting and storing my name, contact details, driving licence, ID document, photo, signature and payment proof to verify my identity, manage this rental, and comply with the law, including sharing them with the police or other authorities if they ask.',
      'Cloud Trails will not sell or share my documents for any other purpose and will delete them within 30 days of the rental ending, unless a dispute, claim or legal requirement needs them kept longer.',
    ],
  },
];

export const CONSENTS = [
  { id: 'age_licence', text: 'I am 18 or older and every rider in this booking holds a valid driving licence for their vehicle.' },
  { id: 'agreement', text: 'I have read and agree to the rental agreement above, including damage, fine and fuel charges.' },
  { id: 'helmet', text: 'I and my pillion will wear helmets and ride sober, within traffic rules.' },
  { id: 'deposit', text: 'I understand the refundable deposit is collected at handover and returned after a clean return.' },
  { id: 'data', text: 'I consent to Cloud Trails storing my documents and details for this rental as described above.' },
];

export function termsText() {
  const parts = [`Cloud Trails Rentals — Rental agreement (${TERMS_VERSION})`];
  for (const s of AGREEMENT) {
    parts.push(s.title);
    for (const p of s.points) parts.push('- ' + p);
  }
  parts.push('Consents');
  for (const c of CONSENTS) parts.push('- ' + c.text);
  return parts.join('\n');
}

export async function termsHash() {
  const data = new TextEncoder().encode(termsText());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
