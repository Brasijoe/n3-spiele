// „Mit Discord anmelden“ + eigene Einträge bearbeiten. Läuft gegen test/reset.sh mit einem Mock-Discord auf :8801
// (OAuth unter /authorize, Bot-API; .dev.vars: DISCORD_API_BASE, DISCORD_OAUTH_URL, DISCORD_CLIENT_SECRET, PUBLIC_URL=http://localhost:8799, DISCORD_GUILD_ID=g1, DISCORD_CHANNEL_ID=CH1).
// Mock-Nutzer: 555 Eva und 556 Fritz (dürfen), 557 (sieht den Kanal nicht), 999 (nicht auf dem Server).
import assert from 'node:assert/strict';
const W = 'http://localhost:8799/api', M = 'http://localhost:8801';
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, '0')).join('');
async function login(id) {
  await fetch(M + '/set?as=' + id);
  const n = hex(16);
  let r = await fetch(W + '/auth/discord?n=' + n, { redirect: 'manual' }); assert.equal(r.status, 302);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  r = await fetch(r.headers.get('location'), { redirect: 'manual' });
  r = await fetch(r.headers.get('location'), { headers: { cookie } }); assert.equal(r.status, 200);
  r = await fetch(W + '/auth/poll?n=' + n);
  return { status: r.status, ...(await r.json()) };
}
const call = (m, p, tok, b) => fetch(W + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { 'x-session': tok } : {}) }, body: b ? JSON.stringify(b) : undefined });

// ohne state-Cookie: abgelehnt
let r = await fetch(W + '/auth/callback?code=c555&state=' + hex(16)); assert.match(await r.text(), /nicht geklappt/);
assert.equal((await fetch(W + '/auth/poll?n=' + hex(16)).then((x) => x.json())).pending, true);

const eva = await login('555'); assert.equal(eva.status, 200); assert.match(eva.token, /^[0-9a-f]{64}$/);
assert.equal((await (await call('GET', '/auth/me', eva.token)).json()).name, 'Eva'); console.log('discord login ok');
assert.equal((await login('557')).error, 'no_channel'); assert.equal((await login('999')).error, 'not_member'); console.log('access checks ok');
const fritz = (await login('556')).token;

// Partie eintragen, bearbeiten, löschen – nur der eigene
r = await call('POST', '/plays', eva.token, { gameId: 1084, game: 'Azul', date: '2026-11-10', players: 3 }); assert.equal(r.status, 200);
const plays = await (await fetch(W + '/plays')).json(); const pl = plays[0]; assert.equal(pl.loggedBy, 'Eva');
let my = await (await call('GET', '/my', eva.token)).json(); assert.deepEqual(my.plays, [pl.id]);
assert.deepEqual((await (await call('GET', '/my', fritz)).json()).plays, []);
assert.equal((await call('PUT', '/plays/' + pl.id, fritz, { date: '2026-11-10', players: 4 })).status, 403);
assert.equal((await call('DELETE', '/plays/' + pl.id, fritz)).status, 403);
r = await call('PUT', '/plays/' + pl.id, eva.token, { date: '2026-11-09', players: 4, winner: 'Eva', loggedBy: 'Hacker' }); assert.equal(r.status, 200);
let p2 = (await (await fetch(W + '/plays')).json())[0]; assert.equal(p2.players, 4); assert.equal(p2.loggedBy, 'Eva'); console.log('own play edit ok, others forbidden');

// Runde anlegen, bearbeiten, löschen
r = await call('POST', '/parties', eva.token, { game: 'Azul', gameId: 1084, date: '2099-01-05', time: '18:00', seats: 4 }); assert.equal(r.status, 200);
const party = await r.json();
my = await (await call('GET', '/my', eva.token)).json(); assert.deepEqual(my.parties, [party.id]);
assert.equal((await call('PUT', '/parties/' + party.id, fritz, { game: 'Azul', date: '2099-01-06', seats: 3 })).status, 403);
r = await call('PUT', '/parties/' + party.id, eva.token, { game: 'Cascadia', gameId: 295947, date: '2099-01-06', time: '19:00', seats: 3, note: 'neu' }); assert.equal(r.status, 200, await r.text());
let pa = (await (await fetch(W + '/parties')).json()).find((x) => x.id === party.id); assert.equal(pa.game, 'Cascadia'); assert.equal(pa.date, '2099-01-06'); assert.equal(pa.seats, 3);
assert.equal((await call('DELETE', '/parties/' + party.id, fritz)).status, 403);
assert.equal((await call('DELETE', '/parties/' + party.id, eva.token)).status, 200); console.log('own party edit/delete ok');
assert.equal((await call('DELETE', '/plays/' + pl.id, eva.token)).status, 200); console.log('own play delete ok');

// Abmelden macht die Sitzung ungültig; Unsinn-Token
await call('POST', '/auth/logout', eva.token);
assert.equal((await call('GET', '/auth/me', eva.token)).status, 401);
assert.equal((await (await call('POST', '/plays', 'zz', { gameId: 1084, date: '2026-11-10', players: 3 })).json()).error, 'bad_session');
assert.equal((await call('POST', '/plays', '', { gameId: 1084, date: '2026-11-10', players: 3 })).status, 403);
console.log('logout ok');
process.exit(0);
