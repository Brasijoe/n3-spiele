// Mitgliederregel und Stammtisch-Tage. Läuft gegen test/reset.sh mit Mock-Discord auf :8801 (wie test/web-login.mjs), dazu in .dev.vars DISCORD_MEMBER_ROLE_ID=777.
// Mock-Nutzer: 555 Eva (hat Rolle 777 = Mitglied), 556 Fritz (keine Rolle). Erwartet „heute“ = 2026-11-11 (Daten unten ggf. anpassen).
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
const W = 'http://localhost:8799/api', M = 'http://localhost:8801';
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, '0')).join('');
async function login(id) {
  await fetch(M + '/set?as=' + id); const n = hex(16);
  let r = await fetch(W + '/auth/discord?n=' + n, { redirect: 'manual' }); const cookie = r.headers.get('set-cookie').split(';')[0];
  r = await fetch(r.headers.get('location'), { redirect: 'manual' }); r = await fetch(r.headers.get('location'), { headers: { cookie } });
  return (await (await fetch(W + '/auth/poll?n=' + n)).json()).token;
}
const call = (m, p, tok, b, h = {}) => fetch(W + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { 'x-session': tok } : {}), ...h }, body: b ? JSON.stringify(b) : undefined });
const eva = await login('555'), fritz = await login('556');
assert.equal((await (await call('GET', '/my', eva)).json()).member, true);
assert.equal((await (await call('GET', '/my', fritz)).json()).member, false);
assert.equal((await (await call('GET', '/auth/me', fritz)).json()).member, false);
const intro = 'Hallo, ich bin Fritz, zum ersten Mal da und kenne das Spiel gut, kann es erklären.';
// member: any day
let r = await call('POST', '/parties', eva, { game: 'Azul', date: '2026-11-19', time: '18:00', seats: 4 }); assert.equal(r.status, 200);
// non-member: offering rounds is members only (any day, with or without intro); event codes stay exempt (below)
for (const d of ['2026-11-19', '2026-11-17', '2026-12-05']) { r = await call('POST', '/parties', fritz, { game: 'Azul', date: d, time: '18:00', seats: 4, note: intro }); assert.equal(r.status, 403); assert.equal((await r.json()).error, 'members_only_offer'); }
// Ältere Runde eines Nicht-Mitglieds (von früher) bleibt bearbeitbar:
const fp = 'oldfritz1';
execSync(`npx wrangler d1 execute n3-spiele --local --command "INSERT INTO parties(id, game, date, time, seats, host, host_key_hash, note, attendees, created_at, host_discord) VALUES('${fp}', 'Azul', '2026-11-17', '18:00', 4, 'Fritz', 'x', 'n', '{}', '2026-11-10', '556')"`, { stdio: 'pipe' });
console.log('web create rules ok');
// edit: move to Thursday refused, to another Tuesday ok, empty note refused
r = await call('PUT', '/parties/' + fp, fritz, { game: 'Azul', date: '2026-11-19', time: '18:00', seats: 4, note: intro }); assert.equal((await r.json()).error, 'stammtisch_only');
r = await call('PUT', '/parties/' + fp, fritz, { game: 'Azul', date: '2026-11-24', time: '18:00', seats: 4, note: '' }); assert.equal((await r.json()).error, 'intro_missing');
r = await call('PUT', '/parties/' + fp, fritz, { game: 'Azul', date: '2026-11-24', time: '18:00', seats: 4, note: intro }); assert.equal(r.status, 200);
console.log('web edit rules ok');
// admin settings: extra Thursday + skip Tuesday; role cleared -> no restriction
const A = { 'x-admin-token': 'test-admin-pw' };
r = await call('PUT', '/admin/booking', null, { memberRole: '777', weekdays: [2], monthly: [{ nth: 1, wd: 6 }], extra: ['2026-11-19'], skip: ['2026-11-17'] }, A); const bk = await r.json(); assert.deepEqual(bk.next.slice(0, 3), ['2026-11-19', '2026-11-24', '2026-12-01']);
r = await call('POST', '/parties', fritz, { game: 'Azul', date: '2026-11-19', time: '18:00', seats: 4, note: intro }); assert.equal((await r.json()).error, 'members_only_offer');
assert.equal((await call('PUT', '/admin/booking', null, { memberRole: '' })).status, 403);
r = await call('PUT', '/admin/booking', null, { memberRole: '', weekdays: [2], monthly: [] }, A); assert.equal((await r.json()).memberRole, '');
assert.equal((await (await fetch(W + '/booking')).json()).memberRule, false);
r = await call('POST', '/parties', fritz, { game: 'Azul', date: '2026-11-20', time: '18:00', seats: 4 }); assert.equal(r.status, 200);
assert.equal((await (await call('GET', '/my', fritz)).json()).member, true);
console.log('admin settings ok');
// event code ignores the rule
await call('PUT', '/admin/booking', null, { memberRole: '777', weekdays: [2], monthly: [{ nth: 1, wd: 6 }] }, A);
r = await call('POST', '/admin/events', null, { name: 'Con', from: '2026-11-20', to: '2026-11-21', validUntil: '2026-11-21' }, A); const ev = await r.json();
r = await call('POST', '/parties', null, { game: 'Azul', date: '2026-11-20', time: '18:00', seats: 4, host: 'Gast' }, { 'x-event-code': ev.code }); assert.equal(r.status, 200);
console.log('event code exempt ok');
