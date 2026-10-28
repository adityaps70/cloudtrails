// Browser run-through of the whole flow against the local dev server (node tests/harness.mjs).
// Usage: node tests/e2e.mjs <screenshot-dir>
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || 'playwright');
import path from 'node:path';

const OUT = process.argv[2] || '.';
const BASE = 'http://localhost:8787';
const IMG = path.resolve('images/fleet-guided-tour.png');      // 2.5 MB → exercises compression
const SMALL = path.resolve('images/pexels-photo-11089921.jpg');
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
const errors = [];

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

// --- admin: set a UPI ID first
const adminCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const admin = await adminCtx.newPage();
admin.on('pageerror', (e) => errors.push('admin: ' + e.message));
await admin.goto(BASE + '/admin/');
await admin.fill('#pw', 'test-password-123');
await admin.click('#login-form button');
await admin.waitForSelector('.stats');
await admin.goto(BASE + '/admin/#/settings');
await admin.waitForSelector('#s-upi_id');
await admin.fill('#s-upi_id', 'cloudtrails@okicici');
await admin.click('#save');
await admin.waitForTimeout(500);
await shot(admin, '10-admin-settings');

// --- customer on a phone
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('book: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/cdnjs|fontshare|fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await page.goto(BASE + '/book.html?vehicle=tvs-ntorq-125');
await page.waitForSelector('#vehicles .veh');
await page.waitForTimeout(400);
await shot(page, '01-ride');

// Step 1 → "1 week" preset, then 2 NTORQs + 1 Hunter
await page.click('#presets .preset[data-days="7"]');
await page.waitForTimeout(500);
await shot(page, '01b-week');
await page.click('.veh[data-id="tvs-ntorq-125"] [data-step="1"]');
await page.click('.veh[data-id="royal-enfield-hunter-350"] .veh-add');
await page.waitForTimeout(300);
const qty = await page.$$eval('.veh .stepper output', (o) => o.map((x) => x.textContent).join(','));
if (qty !== '2,1') errors.push('expected quantities 2,1, got ' + qty);
await shot(page, '01c-group');
// Calendar: tap a custom range (start → end) and back to a week
await page.click('#cal-next');
const days = await page.$$eval('#cal-months .cal-day:not([disabled])', (b) => b.map((x) => x.dataset.date));
await page.click(`#cal-months .cal-day[data-date="${days[3]}"]`);
await page.click(`#cal-months .cal-day[data-date="${days[6]}"]`);
const picked = [await page.inputValue('#start-date'), await page.inputValue('#end-date')];
if (picked[0] !== days[3] || picked[1] !== days[6]) errors.push('calendar range pick failed: ' + picked);
await page.click('#presets .preset[data-days="7"]');
await page.waitForTimeout(400);
const sd = await page.inputValue('#start-date');
await page.click('#bar-next');

// Step 2 → delivery + collection
await page.click('label.opt:has(input[value="delivery"])');
await page.fill('#handover_address', 'Hotel Polo Towers, Polo Ground, Shillong');
await page.click('label.opt:has(input[value="collection"])');
await page.waitForTimeout(200);
await shot(page, '02-handover');
await page.click('#bar-next');

// Step 3 → details (try with a bad phone first)
await page.fill('#name', 'Riya Sharma');
await page.selectOption('.dpick[data-for="dob"] .dp-d', '12');
await page.selectOption('.dpick[data-for="dob"] .dp-m', '4');
await page.selectOption('.dpick[data-for="dob"] .dp-y', '1996');
if (await page.inputValue('#dob') !== '1996-04-12') errors.push('dob picker gave ' + await page.inputValue('#dob'));
await page.fill('#phone', '12345');
await page.fill('#address', '12 MG Road, Guwahati, Assam 781001');
await page.fill('#emergency_name', 'Amit Sharma (brother)');
await page.fill('#emergency_phone', '9876500000');
await page.click('#bar-next');
const phoneErr = await page.textContent('[data-err="phone"]');
if (!phoneErr) errors.push('expected a phone validation error');
await shot(page, '03-details-error');
await page.fill('#phone', '98765 43210');
await page.click('#bar-next');

// Step 4 → documents
await page.fill('#licence_no', 'ML05 20190012345');
await page.selectOption('.dpick[data-for="licence_expiry"] .dp-d', '30');
await page.selectOption('.dpick[data-for="licence_expiry"] .dp-m', '6');
await page.selectOption('.dpick[data-for="licence_expiry"] .dp-y', '2034');
await page.selectOption('#id_type', 'Aadhaar');
await page.setInputFiles('.up[data-kind="licence_front"] input', IMG);
await page.setInputFiles('.up[data-kind="licence_back"] input', SMALL);
await page.setInputFiles('.up[data-kind="id_front"] input', SMALL);
// Selfie with the live camera (Chromium's fake camera)
await page.click('.up[data-kind="selfie"] .cam-open');
await page.waitForSelector('#cam-shoot:not([disabled])', { timeout: 10000 });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '04a-camera.png') });
await page.click('#cam-shoot');
await page.waitForSelector('#cam-review:not([hidden])');
await page.screenshot({ path: path.join(OUT, '04b-camera-review.png') });
await page.click('#cam-use');
await page.waitForSelector('.up[data-kind="selfie"].has-file');
await page.waitForFunction(() => document.querySelectorAll('.up.has-file').length >= 4, null, { timeout: 15000 });
// Two other riders (3 vehicles)
await page.fill('#rider1_name', 'Kabir Sharma');
await page.fill('#rider1_licence_no', 'AS01 20200011111');
await page.setInputFiles('.up[data-kind="rider1_licence"] input', SMALL);
await page.fill('#rider2_name', 'Meera Das');
await page.fill('#rider2_licence_no', 'ML05 20210022222');
await page.setInputFiles('.up[data-kind="rider2_licence"] input', SMALL);
await page.waitForFunction(() => document.querySelectorAll('.up.has-file').length >= 6, null, { timeout: 15000 });
await shot(page, '04-documents');
await page.click('#bar-next');

// Step 5 → agreement + signature
for (const c of await page.$$('[data-consent]')) await c.check();
await page.fill('#consent_name', 'Riya Sharma');
await page.locator('#sig').scrollIntoViewIfNeeded();
const box = await (await page.$('#sig')).boundingBox();
await page.mouse.move(box.x + 30, box.y + 110);
await page.mouse.down();
for (let i = 0; i <= 24; i++) await page.mouse.move(box.x + 30 + i * 10, box.y + 110 - Math.sin(i / 2.5) * 35);
await page.mouse.up();
await shot(page, '05-agreement');
await page.click('#bar-next');

// Step 6 → pay
await page.waitForSelector('#pay-upi:not([hidden])');
await page.waitForTimeout(600);
await shot(page, '06-pay');
await page.click('#bar-next'); // without screenshot → error
const payErr = await page.textContent('[data-err="payment"]');
if (!payErr) errors.push('expected a payment screenshot error');
await page.fill('#upi_utr', '432198765432');
await page.setInputFiles('.up[data-kind="payment"] input', SMALL);
await page.waitForSelector('.up[data-kind="payment"].has-file');
await page.click('#bar-next');
await page.waitForSelector('#done:not([hidden])', { timeout: 20000 });
await shot(page, '07-done');
const trackHref = await page.getAttribute('#done-track', 'href');
const ref = await page.textContent('#done-ref');

// --- admin reviews it
await admin.goto(BASE + '/admin/#/');
await admin.waitForSelector('.stats');
await admin.waitForTimeout(300);
await shot(admin, '11-admin-dashboard');
await admin.goto(BASE + '/admin/#/bookings');
await admin.waitForSelector('tr.rowlink');
await shot(admin, '12-admin-bookings');
await admin.click('tr.rowlink');
await admin.waitForSelector('.det');
await admin.waitForTimeout(500);
await shot(admin, '13-admin-detail');
// ask for re-upload of licence back
await admin.click('[data-act="request_reupload"]');
await admin.check('#modal-body input[value="licence_back"]');
await admin.click('#modal-ok');
await admin.waitForSelector('#modal[hidden]', { state: 'attached' });
await admin.waitForTimeout(300);

// --- customer re-uploads on the status page
await page.goto(new URL(trackHref, BASE + '/').href);
await page.waitForSelector('#status:not([hidden])');
await shot(page, '08-track-reupload');
await page.setInputFiles('#t-files input[data-kind="licence_back"]', SMALL);
await page.click('#t-send');
await page.waitForLoadState('load');
await page.waitForSelector('#status:not([hidden])');
await page.waitForTimeout(300);

// --- admin verifies and confirms, hands over
await admin.reload();
await admin.waitForSelector('.det');
await admin.click('[data-act="verify_docs"]');
await admin.waitForTimeout(400);
await admin.click('[data-act="verify_payment"]');
await admin.click('#modal-ok');
await admin.waitForTimeout(400);
await admin.click('[data-act="confirm"]');
await admin.fill('#m-reg', 'ML05 AB 1234');
await admin.click('#modal-ok');
await admin.waitForTimeout(500);
await shot(admin, '14-admin-confirmed');
await admin.goto(BASE + '/admin/#/schedule?date=' + sd);
await admin.waitForSelector('.sched');
await shot(admin, '15-admin-schedule');
await admin.goto(BASE + '/admin/#/calendar');
await admin.waitForSelector('.tl-veh');
await shot(admin, '16-admin-calendar');
await admin.goto(BASE + '/admin/#/fleet');
await admin.waitForSelector('.fleet-tbl');
await shot(admin, '17-admin-fleet');

// admin on a phone
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await adminCtx.storageState() });
const mp = await m.newPage();
await mp.goto(BASE + '/admin/#/bookings');
await mp.waitForSelector('.bcard');
await shot(mp, '18-admin-mobile');

await page.reload();
await page.waitForSelector('#status:not([hidden])');
await shot(page, '09-track-confirmed');

// desktop booking page
const d = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const dp = await d.newPage();
dp.on('pageerror', (e) => errors.push('desktop: ' + e.message));
await dp.goto(BASE + '/book.html?vehicle=royal-enfield-hunter-350');
await dp.waitForSelector('#vehicles .veh');
await dp.waitForTimeout(500);
await dp.click('#presets .preset[data-days="7"]');
await dp.click('.veh[data-id="suzuki-burgman-street-125"] .veh-add');
await dp.click('.veh[data-id="suzuki-burgman-street-125"] [data-step="1"]');
await dp.waitForTimeout(400);
await shot(dp, '20-desktop-ride');
// Hover preview while choosing a custom range
const dd = await dp.$$eval('#cal-months .cal-day:not([disabled])', (b) => b.map((x) => x.dataset.date));
await dp.click(`#cal-months .cal-day[data-date="${dd[10]}"]`);
await dp.hover(`#cal-months .cal-day[data-date="${dd[15]}"]`);
await dp.waitForTimeout(200);
await dp.screenshot({ path: path.join(OUT, '20b-desktop-picking.png') });
await dp.goto(BASE + '/');
await dp.waitForTimeout(500);
await dp.screenshot({ path: path.join(OUT, '21-home.png') });

console.log(JSON.stringify({ ref, errors }, null, 1));
await browser.close();
