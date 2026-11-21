// Wunschspiele (Abstimmung für den nächsten Stammtisch). Mock-Discord auf :8801 und .dev.vars wie in test/wanted.mjs; Worker per test/reset.sh.
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const W = 'http://localhost:8799/api';
const USERS = { 555: { username: 'eva_x', global_name: 'Eva', nick: 'Eva vom Server', roles: ['777'] }, 556: { username: 'fritz', global_name: 'Fritz', nick: null, roles: ['777'] }, 557: { username: 'gast', global_name: 'Gast', nick: null, roles: [] }, 558: { username: 'hans', global_name: 'Hans', nick: null, roles: ['777'] }, 559: { username: 'ida', global_name: 'Ida', nick: null, roles: ['777'] } };
const msgs = []; let cur = '555', n = 0;
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const u = new URL(req.url, 'http://x'), out = (d, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (u.pathname === '/set') { cur = u.searchParams.get('as'); return out({}); }
    if (u.pathname === '/authorize') { res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=c${cur}&state=${u.searchParams.get('state')}` }); return res.end(); }
    if (u.pathname === '/oauth2/token') return out({ access_token: 'at' + new URLSearchParams(b).get('code').slice(1) });
    if (u.pathname === '/users/@me') { const id = req.headers.authorization.replace('Bearer at', ''); return out({ id, username: USERS[id].username, global_name: USERS[id].global_name }); }
    let m;
    if ((m = u.pathname.match(/^\/guilds\/g1\/members\/(\d+)$/))) { const x = USERS[m[1]]; return x ? out({ user: { id: m[1], username: x.username, global_name: x.global_name }, nick: x.nick, roles: x.roles }) : out({}, 404); }
    if (u.pathname === '/guilds/g1/roles') return out([{ id: 'g1', permissions: '1024' }, { id: '777', permissions: '0' }]);
    if (u.pathname === '/channels/CH1') return out({ id: 'CH1', permission_overwrites: [] });
    if (req.method === 'POST' && (m = u.pathname.match(/^\/channels\/(CH[12])\/messages$/))) { const id = 'msg' + (++n); msgs.push({ id, ch: m[1], ...JSON.parse(b) }); return out({ id }); }
    if (req.method === 'PATCH') { msgs.push({ patch: u.pathname, ...JSON.parse(b) }); return out({ id: 'x' }); }
    out({}, 404);
  });
}).listen(8801);

const hex = (k) => Array.from(crypto.getRandomValues(new Uint8Array(k)), (x) => x.toString(16).padStart(2, '0')).join('');
async function login(id) {
  await fetch('http://localhost:8801/set?as=' + id); const nn = hex(16);
  let r = await fetch(W + '/auth/discord?n=' + nn, { redirect: 'manual' }); const cookie = r.headers.get('set-cookie').split(';')[0];
  r = await fetch(r.headers.get('location'), { redirect: 'manual' }); await fetch(r.headers.get('location'), { headers: { cookie } });
  return (await (await fetch(W + '/auth/poll?n=' + nn)).json()).token;
}
const call = (m, p, tok, b) => fetch(W + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { 'x-session': tok } : {}) }, body: b ? JSON.stringify(b) : undefined });
import { execSync } from 'node:child_process';
const sql = (q) => execSync(`npx wrangler d1 execute n3-spiele --local --command ${JSON.stringify(q)}`, { stdio: 'pipe' });

const eva = await login('555'), fritz = await login('556'), gast = await login('557');
let r = await (await call('GET', '/votes')).json();
assert.match(r.day, /^\d{4}-\d{2}-\d{2}$/); assert.equal(r.max, 5); assert.deepEqual(r.list, []);
const day = r.day;
// Ohne Anmeldung keine Stimme
assert.equal((await call('POST', '/votes', null, { gameId: 13, game: 'CATAN' })).status, 403);
// Eva und Fritz wollen CATAN, der Gast (ohne Mitgliederrolle) darf auch abstimmen
r = await (await call('POST', '/votes', eva, { gameId: 13, game: 'CATAN', year: 1995 })).json();
assert.equal(r.list[0].n, 1); assert.deepEqual(r.mine, ['13']);
await call('POST', '/votes', fritz, { gameId: 13, game: 'Die Siedler von Catan' });
await call('POST', '/votes', gast, { gameId: 13, game: 'CATAN' });
await call('POST', '/votes', gast, { game: 'Selbstgebautes Spiel', mem: true });
// doppelt abstimmen zählt nur einmal
await call('POST', '/votes', eva, { gameId: 13, game: 'CATAN' });
r = await (await call('GET', '/votes')).json();
assert.equal(r.list.length, 2); assert.equal(r.list[0].key, '13'); assert.equal(r.list[0].n, 3); assert.deepEqual(r.list[0].names, ['Eva vom Server', 'Fritz', 'Gast']);
assert.equal(r.list[1].key, 'n:selbstgebautes spiel'); assert.equal(r.list[1].mem, true); assert.equal(r.list[0].game, 'CATAN');
console.log('ranking ok');
// Stimme zurücknehmen
r = await (await call('POST', '/votes', fritz, { gameId: 13, game: 'CATAN', on: false })).json();
assert.equal(r.list[0].n, 2); assert.deepEqual(r.mine, []);
// Höchstens 5 Stimmen pro Person
for (const id of [1, 2, 3, 4]) assert.equal((await call('POST', '/votes', eva, { gameId: 100 + id, game: 'Spiel ' + id })).status, 200);
r = await call('POST', '/votes', eva, { gameId: 200, game: 'Zu viel' }); assert.equal(r.status, 409); assert.equal((await r.json()).error, 'vote_limit');
assert.equal((await call('POST', '/votes', eva, { gameId: 101, game: 'Spiel 1', on: false })).status, 200);
assert.equal((await call('POST', '/votes', eva, { gameId: 200, game: 'Jetzt geht es' })).status, 200);
// Ungültig
assert.equal((await call('POST', '/votes', eva, { game: '' })).status, 400);
console.log('limit ok');
// /my liefert die eigenen Stimmen
r = await (await call('GET', '/my', eva)).json();
assert.deepEqual(r.votes.sort(), ['102', '103', '104', '13', '200']);
// Stimmen eines vergangenen Stammtischs zählen nicht und werden nachts gelöscht
sql("INSERT INTO votes(day, game_key, discord_id, name, game, created_at) VALUES('2020-01-07', '13', '559', 'Ida', 'CATAN', '2020-01-01')");
r = await (await call('GET', '/votes')).json(); assert.equal(r.list.find((x) => x.key === '13').n, 2);
await fetch('http://localhost:8799/cdn-cgi/handler/scheduled?cron=17+3+*+*+*');
await new Promise((res) => setTimeout(res, 3000));
assert.match(sql("SELECT COUNT(*) AS n FROM votes WHERE day < '2021-01-01'").toString(), /"n": 0/);
assert.match(sql(`SELECT COUNT(*) AS n FROM votes WHERE day = '${day}'`).toString(), /"n": 7/);
console.log('expiry ok');
// Runden anbieten nur für Mitglieder; Nicht-Mitglieder spielen bei bestehenden Runden mit (am Stammtisch-Tag).
r = await call('POST', '/parties', gast, { game: 'CATAN', gameId: 13, date: day, time: '18:00', seats: 4, note: 'Hallo, ich bin neu hier und würde gern CATAN spielen, kenne die Regeln.' });
assert.equal(r.status, 403); assert.equal((await r.json()).error, 'members_only_offer');
r = await call('POST', '/parties', eva, { game: 'CATAN', gameId: 13, date: day, time: '18:00', seats: 4 }); assert.equal(r.status, 200); const pid = (await r.json()).id;
r = await call('POST', `/parties/${pid}/join`, gast, { key: 'gastkey01', name: 'Gast' }); assert.equal(r.status, 200);
console.log('members only offer ok');
// Ohne Stammtisch-Tage keine Abstimmung
await fetch(W + '/admin/booking', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-token': 'test-admin-pw' }, body: JSON.stringify({ memberRole: '777', weekdays: [], monthly: [] }) });
r = await (await call('GET', '/votes')).json(); assert.equal(r.day, ''); assert.deepEqual(r.list, []);
assert.equal((await call('POST', '/votes', eva, { gameId: 13, game: 'CATAN' })).status, 409);
console.log('no stammtisch ok');
console.log('ALL VOTES TESTS PASSED');
process.exit(0);
