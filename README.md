# Cloud Trails Rentals

Website and online booking platform for Cloud Trails Rentals, Shillong.

- **Website** (`index.html`): the public site, served by the Cloudflare Worker at cloudtrails.in (DNS on Cloudflare since Oct 2026; GitHub Pages was the earlier host).
- **Booking page** (`book.html`): customers choose dates and a vehicle, pick counter pickup or doorstep delivery (and counter return or doorstep collection), enter their details, upload their licence, ID and a selfie, sign the rental agreement and pay by UPI.
- **Booking status page** (`track.html`): each customer gets a private link to follow their booking and re-upload anything you ask for.
- **Admin panel** (cloudtrails.in/admin): review bookings, check documents and payments, confirm, hand over, close rentals, see the day's deliveries and returns, check availability, and edit the fleet, prices and settings.
- **Backend** (`worker/`): a Cloudflare Worker with a D1 database (`cloudtrails`) and private document storage in KV (`cloudtrails-documents`). Both are already created in the Cloudflare account and referenced in `wrangler.jsonc`.

## Deploy (one time, about 5 minutes)

1. **Create the Worker from this repo.** In Cloudflare go to **Workers & Pages → Create → Import a repository**, pick `adityaps70/cloudtrails`, keep the defaults (no build command, deploy command `npx wrangler deploy`) and deploy. After that, every push to `main` redeploys.
2. **Set the admin password.** Go to **Workers & Pages → cloudtrails → Settings → Variables and Secrets → Add**, choose type **Secret**, name it `ADMIN_PASSWORD` and enter a strong password (8+ characters). Optionally add `SESSION_SECRET` (any long random text).
3. **Live site connection:** `js/config.js` points cloudtrails.in (GitHub Pages) at the Worker, https://cloudtrails.apsapsaps43.workers.dev.
4. **Open the admin** at `https://cloudtrails.<your-subdomain>.workers.dev/admin`, sign in, and in **Settings** add your UPI ID (and optionally your UPI QR image). In **Fleet & prices**, set how many of each vehicle you have.

Until step 3 is done, the booking page on cloudtrails.in shows a "book on WhatsApp" fallback, so nothing breaks in the meantime.

### Optional

- **Email alert for each new booking:** add the secret `RESEND_API_KEY` (from resend.com) and put your address in Admin → Settings → Alert email.
- **R2 instead of KV for documents:** enable R2 in the Cloudflare dashboard, create a bucket `cloudtrails-documents`, and uncomment `r2_buckets` in `wrangler.jsonc`.
- **Custom domain for the Worker** (e.g. `book.cloudtrails.in`): needs the domain's DNS on Cloudflare (it's on GoDaddy now).

## How it works

- **Prices** come from `js/pricing.js`, which the browser and the Worker share. The rules are: 1–2 days at the day rate, 3–6 days 10% off, and 7+ days at the weekly rate (5.5 × the day rate). A rental day is 24 hours, with a 1-hour grace period. Delivery and collection fees, the guide rate and what's paid online are set in Admin → Settings.
- **Availability:** each vehicle model has a number of units. Bookings that are pending, confirmed or on the road hold a unit. The booking page shows "booked out" when every unit overlaps.
- **Booking statuses:** pending → confirmed → on the road → completed, or cancelled / rejected. Payment and documents each have their own check (to verify → verified, or mismatch / re-upload).
- **Rental agreement:** the text is in `worker/terms.js`. Each booking stores the terms version, a hash of the wording, the typed name, the drawn signature, the time, the IP and the device. If you change the wording, bump `TERMS_VERSION`.
- **Privacy:** documents are only served to a signed-in admin. A daily job deletes the documents of finished bookings after the retention period (30 days by default). The signature is kept as the consent record.

## Develop and test

```
npm test                      # API tests (Node 22+, uses node:sqlite as a stand-in for D1)
node tests/harness.mjs        # local server on http://localhost:8787 (admin password: test-password-123)
node tests/e2e.mjs shots/     # browser run-through with Playwright (set PLAYWRIGHT_PATH if it's installed globally)
```

`npx wrangler dev` also works if you prefer the real Cloudflare runtime.
