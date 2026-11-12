// Mitspielen: an Stammtisch-Tagen und bei Event-Runden alle, an anderen Tagen nur Mitglieder (Webseite + Discord-Button). Startet selbst einen Mock-Discord auf :8801 (OAuth, Bot-API, Kanal CH1).
// Worker per test/reset.sh mit .dev.vars: ADMIN_TOKEN=test-admin-pw, DISCORD_API_BASE=http://localhost:8801, DISCORD_OAUTH_URL=http://localhost:8801/authorize,
// DISCORD_CLIENT_SECRET=x, DISCORD_BOT_TOKEN=TESTTOKEN, PUBLIC_URL=http://localhost:8799, DISCORD_GUILD_ID=g1, DISCORD_CHANNEL_ID=CH1,
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
    if (req.method === 'POST' && u.pathname === '/channels/CH1/messages') { const id = 'msg' + (++n); msgs.push({ id, ...JSON.parse(b) }); return out({ id }); }
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


// Datumswerte relativ zu heute: nächster Dienstag (Stammtisch) und nächster Donnerstag (kein Stammtisch).
const day = (wd) => { const d = new Date(); d.setUTCHours(12); do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== wd); return d.toISOString().slice(0, 10); };
const tue = day(2), thu = day(4);
const A = { 'x-admin-token': 'test-admin-pw' };
await call('PUT', '/admin/booking', null, { memberRole: '777', weekdays: [2], monthly: [{ nth: 1, wd: 6 }] }, A);
const eva = await login('555'), gast = await login('557');
const mk = async (date) => { const r = await call('POST', '/parties', eva, { game: 'Azul', date, time: '18:00', seats: 6 }); assert.equal(r.status, 200); return (await r.json()).id; };
const pThu = await mk(thu), pTue = await mk(tue);
const join = (id, tok, name) => call('POST', '/parties/' + id + '/join', tok, { key: hex(6), name });
// Webseite: Donnerstag ohne Anmeldung / als Nicht-Mitglied abgelehnt, als Mitglied ok; Dienstag für alle
let r = await join(pThu, null, 'Anonym'); assert.equal(r.status, 403); assert.equal((await r.json()).error, 'join_login');
r = await join(pThu, gast, 'Gast'); assert.equal(r.status, 403); assert.equal((await r.json()).error, 'join_members_only');
r = await join(pThu, await login('556'), 'Fritz'); assert.equal(r.status, 200);
r = await join(pTue, null, 'Anonym'); assert.equal(r.status, 200);
r = await join(pTue, gast, 'Gast'); assert.equal(r.status, 200);
console.log('web join rules ok');
// Event-Runde an einem Nicht-Stammtisch-Tag: alle dürfen
r = await call('POST', '/admin/events', null, { name: 'Con', from: thu, to: thu, validUntil: thu }, A); const ev = await r.json();
r = await call('POST', '/parties', null, { game: 'Azul', date: thu, time: '18:00', seats: 4, host: 'Orga' }, { 'x-event-code': ev.code }); assert.equal(r.status, 200); const pEv = (await r.json()).id;
r = await join(pEv, null, 'Anonym'); assert.equal(r.status, 200);
console.log('event round open ok');
// Discord-Button
const click = (id, uid) => interact({ type: 3, data: { custom_id: 'join:' + id }, ...as(uid), message: { id: 'm1', flags: 0 } });
let d = await click(pThu, '557'); assert.match(d.data.content, /nur Mitglieder/);
d = await click(pThu, '558'); assert.equal(d.type, 7);
d = await click(pTue, '559'); assert.equal(d.type, 7);
d = await click(pEv, '557'); assert.equal(d.type, 7);
d = await click(pTue, '557'); assert.notEqual(d.type, 4, JSON.stringify(d));
// ohne Mitgliederrolle in der Verwaltung: keine Einschränkung
await call('PUT', '/admin/booking', null, { memberRole: '', weekdays: [2], monthly: [] }, A);
r = await join(pThu, null, 'Anonym2'); assert.equal(r.status, 200);
console.log('discord join rules ok');
await wait(); process.exit(0);
