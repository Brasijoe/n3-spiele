const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const B = 'http://localhost:8799';
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push('pageerror ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
  p.on('requestfailed', (r) => errs.push('reqfailed ' + r.url()));
  const bggCalls = [];
  await p.route('**/api/bgg/search*', (route) => { const q = new URL(route.request().url()).searchParams.get('q'); bggCalls.push(q);
    route.fulfill({ json: [{ id: 295947, n: 'Cascadia', y: 2021, e: false }, { id: 230802, n: 'Azul', y: 2017, e: false }, { id: 999001, n: 'Cascadia: Landmarks', y: 2023, e: true }] }); });
  await p.goto(B + '/'); await p.waitForTimeout(500);
  assert.equal(await p.title(), 'Nerd Nexus Spielesammlung');
  const fonts = await p.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family + f.weight); });
  console.log('fonts loaded', fonts.length, 'google refs', await p.evaluate(() => document.documentElement.outerHTML.includes('googleapis')));
  console.log('plays shown:', await p.locator('#plays .play').count());

  // guest game with live BGG search
  await p.click('.rec-head [data-guest-log]'); await p.fill('#gQ', 'cascadia'); await p.waitForTimeout(700);
  console.log('results:', (await p.locator('#gRes li').allInnerTexts()).map((t) => t.replace(/\n/g, ' ')).join(' | '));
  console.log('hint:', await p.textContent('#gHint'));
  await p.locator('#gRes li', { hasText: 'Cascadia' }).first().click();
  await p.fill('#fCode', '0000'); await p.click('#save'); await p.waitForTimeout(500);
  console.log('wrong code msg:', await p.textContent('#fMsg'));
  await p.fill('#fCode', '1234'); await p.fill('#fDur', '90'); await p.click('#save'); await p.waitForTimeout(1200);
  let plays = await (await fetch(B + '/api/plays')).json();
  assert.equal(plays[0].guest, true); assert.equal(plays[0].gameId, 295947); assert.equal(plays[0].duration, 90);
  console.log('guest play saved; label shown:', await p.locator('#plays .play').first().innerText().then((t) => t.replace(/\n/g, ' ')));

  // picking a collection game in guest dialog logs it as club game
  await p.click('.rec-head [data-guest-log]'); await p.fill('#gQ', 'azul'); await p.waitForTimeout(700);
  await p.locator('#gRes li', { hasText: 'Azul' }).first().click(); await p.fill('#fCode', '1234'); await p.click('#save'); await p.waitForTimeout(1000);
  plays = await (await fetch(B + '/api/plays')).json(); assert.equal(plays[0].guest, false); assert.equal(plays[0].gameId, 230802);

  // parties: create, join (second browser context), leave, log
  await p.click('#tabs a[data-view=parties]'); await p.click('#ptNew'); await p.fill('#pQ', 'cascadia'); await p.waitForTimeout(700); await p.keyboard.press('Enter');
  assert.equal(await p.inputValue('#pTime'), '18:00');
  await p.fill('#pSeats', '3'); await p.fill('#pHost', 'Johannes'); await p.fill('#pCode', '1234'); await p.click('#pSave'); await p.waitForTimeout(1200);
  assert.equal(await p.locator('#ptUpcoming .party').count(), 1);
  const p2 = await (await b.newContext()).newPage(); await p2.goto(B + '/#partys'); await p2.waitForTimeout(500);
  await p2.click('[data-pjoin]'); await p2.fill('[data-pjoinform] input', 'Sara'); await p2.click('[data-pjoinform] button[type=submit]'); await p2.waitForTimeout(800);
  console.log('joined, seats text:', await p2.locator('.party .seats .meta').innerText());
  assert.equal(await p2.locator('[data-pdel]').count(), 0, 'visitor must not see delete');
  await p.reload(); await p.waitForTimeout(700);
  console.log('host sees:', await p.locator('.party .who').innerText().then((t) => t.replace(/\n/g, ' ')), '| delete visible for host:', await p.locator('[data-pdel]').count());
  await p2.click('[data-pleave]'); await p2.waitForTimeout(600);
  console.log('after leave:', await p2.locator('.party .seats .meta').innerText());

  // admin
  await p.click('#tabs a[data-view=collection]'); await p.click('#admLink'); await p.fill('#admPw', 'wrong'); await p.click('#admForm button[type=submit]'); await p.waitForTimeout(500);
  console.log('wrong admin msg:', await p.textContent('#admMsg'), '| admin hidden:', await p.isHidden('#admin'));
  await p.fill('#admPw', 'test-admin-pw'); await p.click('#admForm button[type=submit]'); await p.waitForTimeout(800);
  assert.equal(await p.isHidden('#admin'), false);
  console.log('admin plays rows:', await p.locator('#admPlays .adm-play').count());
  await p.locator('#admPlays [data-del]').first().click(); await p.locator('#admPlays [data-del]').first().click(); await p.waitForTimeout(800);
  console.log('after delete, plays in api:', (await (await fetch(B + '/api/plays')).json()).length);
  await p.fill('#newCode', '4321'); await p.click('#codeForm button[type=submit]'); await p.waitForTimeout(500); console.log('code msg:', await p.textContent('#codeMsg'));
  console.log('geeklist msg:', await p.textContent('#glMsg'));

  // embed in an iframe on a foreign origin
  const outer = await ctx.newPage(); const heights = [];
  await outer.exposeFunction('onH', (h) => heights.push(h));
  await outer.goto('http://localhost:8800/index.html'); await outer.waitForTimeout(2000);
  const fr = outer.frameLocator('#n3-games');
  console.log('iframe heights:', heights.slice(0, 4), '| embed class:', await outer.frames()[1].evaluate(() => document.documentElement.className), '| h1 visible:', await fr.locator('.band h1').isVisible(), '| lang:', await fr.locator('#tabs a').first().innerText());
  await fr.locator('.rec-head [data-guest-log]').scrollIntoViewIfNeeded(); await fr.locator('.rec-head [data-guest-log]').click();
  await outer.waitForTimeout(500);
  const box = await fr.locator('.dialog').first().boundingBox(); const vh = await outer.evaluate(() => innerHeight);
  console.log('dialog on screen:', Math.round(box.y), '..', Math.round(box.y + box.height), 'of viewport', vh); assert.ok(box.y >= 0 && box.y + box.height <= vh + 1, 'dialog visible in viewport');
  await outer.screenshot({ path: '../s7.png', fullPage: false });
  console.log('errors:', errs); await b.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
