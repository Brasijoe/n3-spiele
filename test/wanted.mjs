// „Hat jemand …?“ (Spiel im Bot-Kanal suchen). Startet selbst einen Mock-Discord auf :8801 (OAuth, Bot-API, Kanal CH1).
// Worker per test/reset.sh mit .dev.vars: ADMIN_TOKEN=test-admin-pw, DISCORD_API_BASE=http://localhost:8801, DISCORD_OAUTH_URL=http://localhost:8801/authorize,
// DISCORD_CLIENT_SECRET=x, DISCORD_BOT_TOKEN=TESTTOKEN, PUBLIC_URL=http://localhost:8799, DISCORD_GUILD_ID=g1, DISCORD_CHANNEL_ID=CH1, DISCORD_WANTED_CHANNEL_ID=CH2,
// DISCORD_MEMBER_ROLE_ID=777, DISCORD_PUBLIC_KEY=<pub aus DK_FILE>. DK_FILE = JSON {pub, priv} (Ed25519, priv als PKCS8 base64).
// Mock-Nutzer: 555 Eva (Mitglied, Server-Name „Eva vom Server“), 556 Fritz (Mitglied), 557 Gast (keine Mitgliederrolle), 558 Hans, 559 Ida (Mitglieder).
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
const call = (m, p, tok, b, h = {}) => fetch(W + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { 'x-session': tok } : {}), ...h }, body: b ? JSON.stringify(b) : undefined });
const { priv } = JSON.parse(fs.readFileSync(process.env.DK_FILE, 'utf8'));
const key = await crypto.subtle.importKey('pkcs8', Buffer.from(priv, 'base64'), 'Ed25519', false, ['sign']);
async function interact(obj) {
  const body = JSON.stringify({ guild_id: 'g1', channel_id: 'CH1', ...obj }), ts = String(Date.now());
  const sig = Buffer.from(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(ts + body))).toString('hex');
  return (await fetch(W + '/discord/interactions', { method: 'POST', headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body })).json();
}
const as = (id) => ({ member: { user: { id, username: USERS[id].username, global_name: USERS[id].global_name }, nick: USERS[id].nick, roles: USERS[id].roles } });
const wait = (ms = 600) => new Promise((r) => setTimeout(r, ms));

import { execSync } from 'node:child_process';
const sql = (q) => execSync(`npx wrangler d1 execute n3-spiele --local --command ${JSON.stringify(q)}`, { stdio: 'pipe' });
const berlinIso = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(d);
// nächster Mittwoch (kein Stammtisch-Tag nach Standardregel)
const wed = (() => { const d = new Date(Date.now() + 864e5); while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1); return berlinIso(d); })();
const wedTxt = wed.split('-').reverse().join('.');

const eva = await login('555'), fritz = await login('556'), gast = await login('557'), hans = await login('558');
let r = await call('POST', '/wanted', null, { game: 'X' }); assert.equal(r.status, 403);
// Schon in der Sammlung (CATAN, BGG 13) oder bei Mitgliedern: keine Discord-Frage
r = await call('POST', '/wanted', eva, { gameId: 13, game: 'CATAN' }); assert.equal((await r.json()).error, 'in_club');
await call('POST', '/member-games', fritz, { game: 'Selbstgebautes Spiel', consent: true });
r = await call('POST', '/wanted', eva, { game: 'selbstgebautes spiel' }); assert.equal((await r.json()).error, 'in_members');
console.log('available check ok');

r = await call('POST', '/wanted', eva, { gameId: 999999, game: 'Testspiel X', year: 2024, note: 'Am liebsten dienstags' }); assert.equal(r.status, 200);
const w1 = await r.json(); assert.match(w1.url, /discord\.com\/channels\/g1\/CH2\/msg/);
let m = msgs.at(-1); assert.equal(m.ch, 'CH2'); assert.match(m.content, /sucht \*\*Testspiel X\*\*/); assert.deepEqual(m.allowed_mentions, { parse: [] });
assert.deepEqual(m.components[0].components.map((b) => b.custom_id), [`wantr:${w1.id}`, `wanth:${w1.id}`, `wanti:${w1.id}`, `wantx:${w1.id}`]);
r = await call('POST', '/wanted', fritz, { gameId: 999999, game: 'Testspiel X' }); const d = await r.json(); assert.equal(d.error, 'already_wanted'); assert.equal(d.id, w1.id);
let list = await (await fetch(W + '/wanted')).json(); assert.equal(list.length, 1); assert.equal(list[0].by, 'Eva vom Server'); assert.equal(list[0].req_discord, undefined);
assert.deepEqual((await (await call('GET', '/my', eva)).json()).wanted, [w1.id]);
console.log('post wanted ok');

// „Will auch mitspielen“: Webseite (Gast, ohne Mitgliederrolle) und Discord (Hans)
r = await call('POST', `/wanted/${w1.id}/interest`, eva, { on: true }); assert.equal((await r.json()).error, 'own_request');
r = await call('POST', `/wanted/${w1.id}/interest`, gast, { on: true }); assert.equal(r.status, 200);
assert.deepEqual((await (await call('GET', '/my', gast)).json()).wantedJoined, [w1.id]);
let x = await interact({ type: 3, ...as('558'), data: { custom_id: `wanti:${w1.id}` } }); assert.match(x.data.content, /Notiert/);
await wait();
list = await (await fetch(W + '/wanted')).json(); assert.deepEqual(list[0].interested, ['Gast', 'Hans']);
const p = msgs.filter((q) => q.patch).at(-1); assert.match(JSON.stringify(p.embeds), /Wollen auch mitspielen \(2\)/);
console.log('interest ok');

// Hab ich: Runde anlegen (Fritz). Eigene Suche nicht.
x = await interact({ type: 3, ...as('555'), data: { custom_id: `wantr:${w1.id}` } }); assert.match(x.data.content, /eigene Suche/);
x = await interact({ type: 3, ...as('556'), data: { custom_id: `wantr:${w1.id}` } }); assert.equal(x.type, 9);
const submit = (vals, u = '556', id = w1.id) => interact({ type: 5, ...as(u), data: { custom_id: `wantr:${id}`, components: Object.entries(vals).map(([k, v]) => ({ type: 1, components: [{ type: 4, custom_id: k, value: v }] })) } });
x = await submit({ datum: 'quatsch', uhrzeit: '18:00', plaetze: '4' }); assert.match(x.data.content, /Datum nicht verstanden/);
x = await submit({ datum: wedTxt, uhrzeit: '19:30', plaetze: '4' }); assert.equal(x.type, 7, JSON.stringify(x)); assert.match(x.data.content, /Fritz\*\* hat \*\*Testspiel X/);
await wait();
const party = (await (await fetch(W + '/parties')).json())[0];
assert.equal(party.host, 'Fritz'); assert.equal(party.date, wed); assert.equal(party.time, '19:30');
// Gast hat keine Mitgliederrolle und Mittwoch ist kein Stammtisch: nicht eingetragen, aber erwähnt
assert.deepEqual(Object.values(party.attendees).map((a) => a.name).sort(), ['Eva vom Server', 'Hans']);
m = msgs.filter((q) => q.ch === 'CH1').at(-1); assert.equal(m.ch, 'CH1'); assert.match(m.content, /<@555> <@558>, Fritz hat/); assert.match(m.content, /<@557> ihr wolltet auch/);
// Reservierungen: Suchende bis zur Bestätigung, „Will auch“ 24 Stunden; Bestätigen per „Ich bin dabei“, Gastgeber gibt frei
const att0 = party.attendees; assert.equal(att0.d555.res, 1); assert.equal(att0.d555.until, null); assert.equal(att0.d558.res, 1); assert.ok(att0.d558.until > new Date(Date.now() + 23 * 3600e3).toISOString());
assert.match(m.content, /Platz reserviert/); assert.match(JSON.stringify(m.embeds), /reserviert/);
x = await interact({ type: 3, ...as('558'), data: { custom_id: `join:${party.id}` } }); assert.equal(x.type, 7);
let pa = (await (await fetch(W + '/parties')).json()).find((q) => q.id === party.id).attendees; assert.ok(!pa.d558.res, 'hans confirmed');
// abgelaufene Reservierung zählt nicht mehr: Eva künstlich ablaufen lassen, Ida tritt bei
sql(`UPDATE parties SET attendees = json_set(attendees, '$.d555.until', '2020-01-01T00:00:00.000Z') WHERE id = '${party.id}'`);
x = await interact({ type: 3, ...as('559'), data: { custom_id: `join:${party.id}` } }); assert.equal(x.type, 7);
pa = (await (await fetch(W + '/parties')).json()).find((q) => q.id === party.id).attendees; assert.equal(pa.d555.out, 1, 'expired -> out'); assert.ok(pa.d559);
// Gastgeber gibt frei (Discord: Verwalten -> Reservierungen freigeben), Webseite bestätigt
sql(`UPDATE parties SET attendees = json_set(attendees, '$.d555', json('{"name":"Eva vom Server","at":"x","res":1,"until":null}')) WHERE id = '${party.id}'`);
x = await interact({ type: 3, ...as('556'), data: { custom_id: `manage:${party.id}` } }); assert.ok(JSON.stringify(x).includes('release:'));
r = await call('POST', `/parties/${party.id}/join`, eva, { key: 'evakey1', name: 'Eva' }); assert.equal((await r.json()).key, 'd555');
pa = (await (await fetch(W + '/parties')).json()).find((q) => q.id === party.id).attendees; assert.ok(!pa.d555.res && !pa.d555.out, 'eva confirmed on web');
sql(`UPDATE parties SET attendees = json_set(attendees, '$.d555', json('{"name":"Eva vom Server","at":"x","res":1,"until":null}')) WHERE id = '${party.id}'`);
r = await call('POST', `/parties/${party.id}/release`, hans); assert.equal(r.status, 403);
x = await interact({ type: 3, ...as('556'), data: { custom_id: `release:${party.id}` } }); assert.match(x.data.content, /freigegeben/);
pa = (await (await fetch(W + '/parties')).json()).find((q) => q.id === party.id).attendees; assert.equal(pa.d555.out, 1, 'released');
console.log('reservations ok');
x = await interact({ type: 3, ...as('558'), data: { custom_id: `wanth:${w1.id}` } }); assert.match(x.data.content, /Fritz hat das Spiel schon/);
assert.equal((await (await fetch(W + '/wanted')).json()).length, 0);
console.log('found with round ok');

// Suchen anlegen nur für Mitglieder
r = await call('POST', '/wanted', gast, { game: 'Gastspiel Y' }); assert.equal(r.status, 403); assert.equal((await r.json()).error, 'members_only');
r = await call('POST', '/wanted', hans, { game: 'Gastspiel Y' }); const w2 = await r.json(); assert.equal(r.status, 200);
// Hab ich ohne Runde
x = await interact({ type: 3, ...as('556'), data: { custom_id: `wanth:${w2.id}` } }); assert.equal(x.type, 7); assert.match(x.data.content, /Fritz\*\* hat \*\*Gastspiel Y/);
assert.equal(x.data.components[0].components[0].url, 'https://discord.com/users/558');
await wait(); assert.equal(msgs.at(-1).ch, 'CH2'); assert.match(msgs.at(-1).content, /^<@558> Fritz \(<@556>\) hat/);
console.log('found without round ok');

// Zurückziehen: nur selbst (oder Verwaltung)
r = await call('POST', '/wanted', eva, { game: 'Zieh zurück' }); const w3 = await r.json();
r = await call('DELETE', '/wanted/' + w3.id, fritz); assert.equal(r.status, 403);
r = await call('DELETE', '/wanted/' + w3.id, eva); assert.equal(r.status, 200);
await wait(); assert.match(msgs.filter((q) => q.patch).at(-1).content, /Zurückgezogen/);
// Tageslimit: Mitglieder 10, Nicht-Mitglieder 3 (zurückgezogene zählen mit); Fehler nennt den Stand.
r = await call('POST', '/wanted', eva, { game: 'Noch eins' }); assert.equal(r.status, 200); const w4 = await r.json();
for (let k = 4; k <= 10; k++) { r = await call('POST', '/wanted', eva, { game: 'Mitgliedersuche ' + k }); assert.equal(r.status, 200, 'eva ' + k); }
r = await call('POST', '/wanted', eva, { game: 'Zu viel' }); assert.equal(r.status, 429); assert.deepEqual(await r.json(), { error: 'day_limit', used: 10, max: 10 });
x = await interact({ type: 3, ...as('556'), data: { custom_id: `wantx:${w4.id}` } }); assert.match(x.data.content, /Nur wer gesucht hat/);
console.log('withdraw + rate limit ok');

// Antworten von der Webseite (nur angemeldet): Runde anlegen oder Termin später
const ida = await login('559');
r = await call('POST', '/wanted', hans, { game: 'Webspiel' }); const w5 = await r.json(); assert.equal(r.status, 200);
r = await call('POST', `/wanted/${w5.id}/found`, null, {}); assert.equal(r.status, 403);
r = await call('POST', `/wanted/${w5.id}/found`, hans, {}); assert.equal((await r.json()).error, 'own');
r = await call('POST', `/wanted/${w5.id}/found`, gast, { round: { date: wed, time: '18:00', seats: 4 } }); assert.equal((await r.json()).error, 'stammtisch_only');
r = await call('POST', `/wanted/${w5.id}/found`, fritz, { round: { date: wed, time: '25:00', seats: 4 } }); assert.equal((await r.json()).error, 'bad_time');
r = await call('POST', `/wanted/${w5.id}/found`, fritz, { round: { date: wed, time: '18:15', seats: 3, note: '' } }); let j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); assert.ok(j.partyId);
await wait();
let wp = (await (await fetch(W + '/parties')).json()).find((q) => q.id === j.partyId); assert.equal(wp.host, 'Fritz'); assert.deepEqual(Object.values(wp.attendees).map((a) => a.name), ['Hans']);
assert.ok(msgs.some((q) => q.patch && /Fritz\*\* hat \*\*Webspiel\*\* \(gesucht von Hans\) und bringt es/.test(q.content)));
assert.match(msgs.filter((q) => !q.patch).at(-1).content, /<@558>, Fritz hat \*\*Webspiel/);
r = await call('POST', `/wanted/${w5.id}/found`, gast, {}); assert.equal((await r.json()).error, 'gone');
r = await call('POST', '/wanted', ida, { game: 'Webspiel 2' }); const w6 = await r.json();
r = await call('POST', `/wanted/${w6.id}/found`, gast, {}); assert.equal(r.status, 200);
await wait();
assert.ok(msgs.some((q) => q.patch && /Gast\*\* hat \*\*Webspiel 2/.test(q.content) && q.components[0].components.length === 2));
assert.match(msgs.filter((q) => !q.patch).at(-1).content, /^<@559> Gast \(<@557>\) hat/);
console.log('answer from web ok');

// Ablauf nach 3 Monaten (nächtlicher Lauf)
assert.ok(w4.expiresAt > new Date(Date.now() + 88 * 864e5).toISOString().slice(0, 10));
sql(`UPDATE wanted SET expires_at = '2020-01-01' WHERE status = 'open'`);
assert.equal((await (await fetch(W + '/wanted')).json()).length, 0);
await fetch('http://localhost:8799/__scheduled?cron=17+3+*+*+*'); await wait(3000);
assert.match(msgs.filter((q) => q.patch).at(-1).content, /Abgelaufen/);
console.log('expire ok');
console.log('ALL OK');
process.exit(0);
