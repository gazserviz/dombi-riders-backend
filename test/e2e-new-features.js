const { chromium } = require('playwright');
const path = require('path');

const BASE = 'http://localhost:3000';
const SHOTS = '/tmp/shots';

(async () => {
  const fs = require('fs');
  fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`); });
  page.on('pageerror', err => errors.push(`[pageerror] ${err.message}`));

  function log(msg) { console.log('== ' + msg); }

  // ---- LOGIN ---------------------------------------------------------------
  log('login');
  await page.goto(`${BASE}/login.html`);
  await page.fill('#email', 'admin@dombi.bg');
  await page.fill('#password', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/home.html', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  log('logged in, url=' + page.url());

  // ---- HOME: service-due km info --------------------------------------------
  await page.goto(`${BASE}/home.html`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/01-home.png`, fullPage: true });

  // ---- NEW VEHICLE with odometer fields --------------------------------------
  log('vehicle-new: create vehicle with odometer fields');
  await page.goto(`${BASE}/vehicle-new.html`);
  await page.waitForTimeout(400);
  await page.fill('input[name="plate_number"]', 'CA7777XX');
  await page.fill('input[name="make"]', 'Test');
  await page.fill('input[name="model"]', 'Vehicle');
  await page.fill('input[name="initial_odometer_km"]', '15000');
  await page.fill('input[name="service_interval_months"]', '4');
  await page.fill('input[name="service_interval_km"]', '8000');
  await page.screenshot({ path: `${SHOTS}/02-vehicle-new-form.png`, fullPage: true });
  await page.click('button[type="submit"]');
  await page.waitForURL('**/vehicle-detail.html**', { timeout: 5000 });
  const vehicleUrl = page.url();
  const newVehicleId = new URL(vehicleUrl).searchParams.get('id');
  log('created vehicle id=' + newVehicleId);

  // ---- VEHICLE DETAIL: Пробег tab --------------------------------------------
  await page.waitForTimeout(500);
  await page.click('.tab[data-tab="odometer"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/03-vehicle-odometer-tab.png`, fullPage: true });

  log('add manual odometer reading');
  await page.click('#addOdoBtn');
  await page.waitForTimeout(200);
  await page.fill('#odoForm input[name="km"]', '15800');
  await page.fill('#odoForm input[name="note"]', 'тест ръчно въвеждане');
  await page.click('#odoForm button[type="submit"]');
  await page.waitForTimeout(700);
  await page.click('.tab[data-tab="odometer"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/04-vehicle-odometer-after-manual.png`, fullPage: true });

  // ---- CONTRACT NEW with start_odometer_km -----------------------------------
  log('contract-new: create contract with start_odometer_km');
  await page.goto(`${BASE}/contract-new.html`);
  await page.waitForTimeout(400);
  await page.selectOption('select[name="vehicle_id"]', { label: (await page.locator('select[name="vehicle_id"] option', { hasText: 'CA7777XX' }).textContent()) });
  await page.selectOption('select[name="renter_type"]', 'personal_use');
  await page.fill('input[name="renter_name"]', 'Тестов Наемател');
  await page.fill('input[name="rate_amount"]', '50');
  await page.fill('input[name="start_odometer_km"]', '15800');
  await page.screenshot({ path: `${SHOTS}/05-contract-new-form.png`, fullPage: true });
  await page.click('button[type="submit"]');
  await page.waitForURL('**/contracts.html**', { timeout: 5000 });
  await page.waitForTimeout(500);

  // find the newly created contract's print link (last row, our test renter)
  const contractHref = await page.locator('tr', { hasText: 'Тестов Наемател' }).locator('a', { hasText: 'Печат' }).getAttribute('href');
  log('contract print href=' + contractHref);

  // ---- CONTRACT PRINT: download links + esign panel --------------------------
  await page.goto(`${BASE}${contractHref}`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/06-contract-print.png`, fullPage: true });

  const wordLink = await page.locator('a', { hasText: 'Изтегли Word' }).getAttribute('href');
  const pdfLink = await page.locator('a', { hasText: 'Изтегли PDF' }).getAttribute('href');
  log('word link=' + wordLink + ' pdf link=' + pdfLink);

  // in-person signature: draw + submit
  log('contract: in-person signature draw+submit');
  await page.fill('#esignName', 'Playwright Тест');
  await page.fill('#esignRole', 'Наемател');
  const canvasBox = await page.locator('#esignCanvas').boundingBox();
  await page.mouse.move(canvasBox.x + 20, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 20);
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 90);
  await page.mouse.up();
  await page.screenshot({ path: `${SHOTS}/07-contract-signature-drawn.png`, fullPage: true });
  await page.click('#esignSubmitBtn');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/08-contract-signed.png`, fullPage: true });

  // remote send (expect graceful "not configured" message, no crash)
  log('contract: remote send (expect graceful degrade)');
  await page.fill('#esignEmail', 'test@example.bg');
  await page.click('#esignSendBtn');
  await page.waitForTimeout(700);
  const remoteMsg = await page.locator('#esignRemoteMsg').textContent();
  log('remote msg: ' + remoteMsg);
  await page.screenshot({ path: `${SHOTS}/09-contract-remote-send.png`, fullPage: true });

  // ---- PROTOCOL PRINT (seed hp-1): download links + esign panel --------------
  log('protocol-print (hp-1)');
  await page.goto(`${BASE}/protocol-print.html?id=hp-1`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/10-protocol-print.png`, fullPage: true });
  const protoStatusBadge = await page.locator('#esignStatusBadge').textContent();
  log('protocol status badge: ' + protoStatusBadge);

  // ---- TEMPLATES PAGE ---------------------------------------------------------
  log('templates.html');
  await page.goto(`${BASE}/templates.html`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/11-templates.png`, fullPage: true });

  await page.fill('#builtinForm textarea[name="content"]', 'PLAYWRIGHT ТЕСТОВ ТЕКСТ ЗА ОБЩИ УСЛОВИЯ');
  await page.click('#builtinForm button[type="submit"]');
  await page.waitForTimeout(600);
  const builtinMsg = await page.locator('#builtinMsg').textContent();
  log('builtin save msg: ' + builtinMsg);
  await page.screenshot({ path: `${SHOTS}/12-templates-saved.png`, fullPage: true });

  // switch to contract tab
  await page.click('.tab[data-type="contract"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/13-templates-contract-tab.png`, fullPage: true });

  // revert protocol builtin content back to empty (cleanup)
  await page.click('.tab[data-type="protocol"]');
  await page.waitForTimeout(400);
  await page.fill('#builtinForm textarea[name="content"]', '');
  await page.click('#builtinForm button[type="submit"]');
  await page.waitForTimeout(500);

  // ---- verify docx download actually works (HEAD-ish check via fetch in-page) ----
  log('verify docx/pdf downloads return 200 + correct content-type');
  const checkDownload = async (url) => {
    return await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'same-origin' });
      const buf = await res.arrayBuffer();
      return { status: res.status, contentType: res.headers.get('content-type'), bytes: buf.byteLength };
    }, url);
  };
  console.log('protocol docx:', JSON.stringify(await checkDownload(`${BASE}/api/protocols/hp-1/docx`)));
  console.log('protocol pdf:', JSON.stringify(await checkDownload(`${BASE}/api/protocols/hp-1/pdf`)));
  console.log('contract docx:', JSON.stringify(await checkDownload(`${BASE}${wordLink}`)));
  console.log('contract pdf:', JSON.stringify(await checkDownload(`${BASE}${pdfLink}`)));

  console.log('\\n=== CONSOLE/PAGE ERRORS ===');
  if (errors.length) errors.forEach(e => console.log(e)); else console.log('(none)');

  await browser.close();
  console.log('\\nDONE. new vehicle id=' + newVehicleId + ' contract href=' + contractHref);
})().catch(e => { console.error('TEST SCRIPT FAILED:', e); process.exit(1); });
