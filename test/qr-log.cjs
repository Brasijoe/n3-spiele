// Browser-Test für das Eintragen per QR-Code (braucht test/reset.sh: Port 8799, Admin-Passwort test-admin-pw).
const { chromium, devices } = require('playwright');
const assert = require('node:assert/strict');
const B = 'http://localhost:8799', A = { 'x-admin-token': 'test-admin-pw' };
const shots = process.env.SHOTS;
(async () => {
  const key = (await (await fetch(B + '/api/admin/logkey', { method: 'POST', headers: A })).json()).key;
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['Pixel 7'] }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route('**/api/bgg/search*', (r) => r.fulfill({ json: [{ id: 295947, n: 'Cascadia', y: 2021, e: false }] }));
  await p.goto(B + '/?log=' + key); await p.waitForTimeout(800);
  assert.equal(await p.isVisible('#modal'), true, 'dialog opens after scan');
  assert.equal(new URL(p.url()).search, '', 'key removed from address bar');
  assert.equal(await p.isVisible('#fCodeWrap'), false); assert.equal(await p.isVisible('#fByWrap'), true);
  if (shots) await p.screenshot({ path: shots + '/mobile-open.png' });
  await p.fill('#gQ', 'cascadia'); await p.waitForTimeout(700); await p.locator('#gRes li', { hasText: 'Cascadia' }).first().click();
  await p.click('#save'); await p.waitForTimeout(300);
  assert.match(await p.textContent('#fMsg'), /Namen/);
  await p.fill('#fBy', 'Lena'); await p.fill('#fPlayers', '3');
  if (shots) await p.screenshot({ path: shots + '/mobile-filled.png' });
  await p.click('#save'); await p.waitForTimeout(1200);
  let plays = await (await fetch(B + '/api/plays')).json();
  assert.equal(plays[0].loggedBy, 'Lena'); assert.equal(plays[0].via, 'qr'); assert.equal(plays[0].gameId, 295947);
  // Später ohne Scan: Schlüssel und Name sind gemerkt
  await p.goto(B + '/'); await p.waitForTimeout(600); assert.equal(await p.isVisible('#modal'), false);
  await p.click('.rec-head [data-guest-log]'); assert.equal(await p.inputValue('#fBy'), 'Lena'); assert.equal(await p.isVisible('#fCodeWrap'), false);
  await p.click('#cancel');
  // Neuer Schlüssel: alter wird abgelehnt, Code-Feld erscheint wieder
  await fetch(B + '/api/admin/logkey', { method: 'POST', headers: A });
  await p.click('.rec-head [data-guest-log]'); await p.fill('#gQ', 'cascadia'); await p.waitForTimeout(700); await p.locator('#gRes li').first().click(); await p.click('#save'); await p.waitForTimeout(800);
  assert.match(await p.textContent('#fMsg'), /nicht mehr gültig/); assert.equal(await p.isVisible('#fCodeWrap'), true);
  // Veralteter Aushang: Hinweis gleich beim Öffnen
  await p.goto(B + '/?log=' + key); await p.waitForTimeout(1000); assert.match(await p.textContent('#fMsg'), /nicht mehr gültig/);
  // Verwaltung: QR-Code und Aushang
  const d = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await d.goto(B + '/'); await d.click('#admLink'); await d.fill('#admPw', 'test-admin-pw'); await d.click('#admForm button[type=submit]'); await d.waitForTimeout(1200);
  assert.equal(await d.locator('#qrImg svg').count(), 1);
  const href = await d.getAttribute('#qrPrint', 'href'); const cur = (await (await fetch(B + '/api/admin/logkey', { headers: A })).json()).key;
  assert.equal(href, 'qr.html#' + cur);
  if (shots) { await d.locator('#qrAdm').scrollIntoViewIfNeeded(); await d.locator('#admin .adm-block', { has: d.locator('#qrAdm') }).screenshot({ path: shots + '/admin.png' }); }
  await d.goto(B + '/' + href); await d.waitForTimeout(800);
  assert.equal(await d.locator('.qr svg').count(), 2); assert.equal(await d.locator('.sheet[lang=en]').count(), 1);
  assert.equal(await d.locator('.url').count(), 0); assert.ok(!(await d.textContent('body')).includes(cur), 'key not printed as text');
  if (shots) { await d.screenshot({ path: shots + '/poster.png', fullPage: true }); await d.pdf({ path: shots + '/poster.pdf', format: 'A4', printBackground: true }); }
  assert.deepEqual(errs, []);
  console.log('qr-log ok'); await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
