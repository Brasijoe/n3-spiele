// Wunschspiele-Abstimmung in Discord (src/votepost.js). Startet selbst einen Mock-Discord auf :8801 (OAuth, Bot-API, Kanal CH1).
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
const tick = async () => { await fetch('http://localhost:8799/__scheduled?cron=*/20+*+*+*+*'); await wait(2500); };
const adm = { 'x-admin-token': 'test-admin-pw' };

// Aus: votePostDays 0 -> kein Post
let r = await call('PUT', '/admin/booking', null, { memberRole: '777', weekdays: [0, 1, 2, 3, 4, 5, 6], monthly: [], extra: [], skip: [], votePostDays: 0 }, adm);
assert.equal(r.status, 200); assert.equal((await r.json()).votePostDays, 0);
await tick();
assert.equal(msgs.filter((m) => m.embeds && /Wunschspiele/.test(m.embeds[0].title)).length, 0, 'kein Post, wenn aus');

// An (jeden Tag Stammtisch -> heute ist der Tag): Post mit @here, Link-Knopf, noch keine 👍-Knöpfe
r = await call('PUT', '/admin/booking', null, { memberRole: '777', weekdays: [0, 1, 2, 3, 4, 5, 6], monthly: [], extra: [], skip: [], votePostDays: 3, votePing: 'here' }, adm);
assert.equal((await r.json()).votePing, 'here');
await tick();
let posts = msgs.filter((m) => m.embeds && /Wunschspiele/.test(m.embeds[0].title));
assert.equal(posts.length, 1, 'ein Post');
assert.match(posts[0].content, /^@here /); assert.deepEqual(posts[0].allowed_mentions, { parse: ['everyone'] });
assert.equal(posts[0].components.length, 1); assert.deepEqual(posts[0].components[0].components.map((c) => c.custom_id || c.style), ['voteadd', 5]);
await tick();
assert.equal(msgs.filter((m) => m.embeds && /Wunschspiele/.test(m.embeds[0].title)).length, 1, 'nicht doppelt posten');

// Stimme auf der Webseite -> Post wird aktualisiert, 👍-Knopf erscheint
const eva = await login('555');
const before = msgs.length;
r = await call('POST', '/votes', eva, { gameId: 68448, game: '7 Wonders', year: 2010 });
assert.equal(r.status, 200);
const g = await (await call('GET', '/votes')).json();
assert.equal(g.list[0].n, 1); assert.match(g.post, /discord\.com\/channels\/g1\/CH1\/msg/);
await wait(1500);
let patch = msgs.slice(before).find((m) => m.patch);
assert.ok(patch, 'Post aktualisiert'); assert.match(patch.embeds[0].description, /7 Wonders\*\* · 👍 1 \(Eva vom Server\)/);
const btn = patch.components[0].components[0]; assert.equal(btn.custom_id, 'vote:68448');

// Discord-Knopf: Fritz stimmt mit, Eva nimmt ihre Stimme zurück
const msgId = posts[0].id;
let x = await interact({ type: 3, data: { custom_id: 'vote:68448' }, message: { id: msgId }, ...as('556') });
assert.match(x.data.content, /Notiert/); assert.equal(x.data.flags, 64);
x = await interact({ type: 3, data: { custom_id: 'vote:68448' }, message: { id: msgId }, ...as('555') });
assert.match(x.data.content, /zurückgenommen/);
let v = await (await call('GET', '/votes')).json();
assert.deepEqual(v.list[0].names, ['Fritz']);
// Alte Nachricht (andere ID) -> vorbei
x = await interact({ type: 3, data: { custom_id: 'vote:68448' }, message: { id: 'old' }, ...as('556') });
assert.match(x.data.content, /vorbei/);

// ➕ Anderes Spiel vorschlagen: Knopf öffnet Formular, Treffer zählt als Stimme, mehrere Treffer -> Auswahl, keiner -> Hinweis
x = await interact({ type: 3, data: { custom_id: 'voteadd' }, message: { id: msgId }, ...as('556') });
assert.equal(x.type, 9); assert.equal(x.data.custom_id, 'voteadd');
const modal = (q) => interact({ type: 5, data: { custom_id: 'voteadd', components: [{ type: 1, components: [{ type: 4, custom_id: 'q', value: q }] }] }, ...as('556') });
x = await modal('gibt es sicher nicht xyz'); assert.match(x.data.content, /nicht gefunden|weder/);
x = await modal('7 wonders'); assert.match(x.data.content, /Notiert/);
x = await modal('wonders');
if (x.data.components) { const b0 = x.data.components[0].components[0]; assert.match(b0.custom_id, /^voteadd:/); x = await interact({ type: 3, data: { custom_id: b0.custom_id }, ...as('556') }); }
assert.match(x.data.content, /Notiert/);
v = await (await call('GET', '/votes')).json();
assert.ok(v.list.filter((g) => g.names.includes('Fritz')).length >= 1);

// Geplante Runde für den Tag erscheint im Post
sql(`INSERT INTO parties(id, game_id, game, guest, date, time, seats, host, host_key_hash, note, attendees, created_at) VALUES('pv1', 68448, '7 Wonders', 0, '${v.day}', '18:30', 5, 'Lena', 'x', '', '{}', '2026-01-01T00:00:00Z')`);
const b2 = msgs.length; await tick();
patch = msgs.slice(b2).find((m) => m.patch);
assert.ok(patch && /Schon geplant/.test(patch.embeds[0].description) && /Runde 18:30 geplant/.test(patch.embeds[0].description), 'Runde im Post');

// Stammtisch vorbei -> beendet (Knöpfe weg), State geleert
sql(`UPDATE config SET value = json_set(value, '$.day', '2000-01-01') WHERE key = 'vote_post'`);
const b3 = msgs.length; await tick();
const closed = msgs.slice(b3).find((m) => m.patch && /beendet/.test(m.embeds[0].title));
assert.ok(closed, 'beendet'); assert.deepEqual(closed.components, []);
console.log('votepost ok');
process.exit(0);
