// Anmelden mit der Discord-App: Code von der Webseite, /login im Bot-Kanal, Seite holt die Sitzung ab. Setup wie test/member-games.mjs.
// Worker per test/reset.sh mit .dev.vars: ADMIN_TOKEN=test-admin-pw, DISCORD_API_BASE=http://localhost:8801, DISCORD_OAUTH_URL=http://localhost:8801/authorize,
// DISCORD_CLIENT_SECRET=x, DISCORD_BOT_TOKEN=TESTTOKEN, PUBLIC_URL=http://localhost:8799, DISCORD_GUILD_ID=g1, DISCORD_CHANNEL_ID=CH1,
// DISCORD_MEMBER_ROLE_ID=777, DISCORD_PUBLIC_KEY=<pub aus DK_FILE>. DK_FILE = JSON {pub, priv} (Ed25519, priv als PKCS8 base64).
// Mock-Nutzer: 555 Eva (Mitglied, Server-Name „Eva vom Server“), 556 Fritz (Mitglied), 557 Gast (keine Mitgliederrolle), 558 Hans, 559 Ida (Mitglieder).
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const W = 'http://localhost:8799/api';
const USERS = { 555: { username: 'eva_x', global_name: 'Eva', nick: 'Eva vom Server', roles: ['777'] }, 556: { username: 'fritz', global_name: 'Fritz', nick: null, roles: ['777'] }, 557: { username: 'gast', global_name: 'Gast', nick: null, roles: [] }, 558: { username: 'hans', global_name: 'Hans', nick: null, roles: ['777'] }, 560: { username: 'neu', global_name: 'Neu', nick: null, roles: [] }, 559: { username: 'ida', global_name: 'Ida', nick: null, roles: ['777'] } };
const msgs = []; let cur = '555', n = 0;
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const u = new URL(req.url, 'http://x'), out = (d, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (u.pathname === '/set') { cur = u.searchParams.get('as'); return out({}); }
    if (u.pathname === '/authorize') { res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=c${cur}&state=${u.searchParams.get('state')}` }); return res.end(); }
    if (u.pathname === '/oauth2/token') return out({ access_token: 'at' + new URLSearchParams(b).get('code').slice(1) });
    if (u.pathname === '/users/@me') { const id = req.headers.authorization.replace('Bearer at', ''); return out({ id, username: USERS[id].username, global_name: USERS[id].global_name }); }
    let m;
    if ((m = u.pathname.match(/^\/guilds\/g1\/members\/(\d+)$/))) { if (m[1] === '560') return out({}, 404); const x = USERS[m[1]]; return x ? out({ user: { id: m[1], username: x.username, global_name: x.global_name }, nick: x.nick, roles: x.roles }) : out({}, 404); }
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

const nonce = () => hex(16);
const poll = async (n) => { const r = await fetch(W + '/auth/poll?n=' + n); return { status: r.status, ...(await r.json()) }; };
const slash = (u, code) => interact({ type: 2, ...as(u), data: { name: 'login', options: [{ name: 'code', type: 3, value: code }] } });

let nn = nonce(), r = await call('POST', '/auth/appcode', null, { n: nn }); const { code } = await r.json();
assert.match(code, /^[A-Z2-9]{6}$/);
assert.deepEqual(await poll(nn), { status: 200, pending: true });
let x = await slash('556', 'falsch'); assert.match(x.data.content, /kenne ich nicht/); assert.equal(x.data.flags, 64);
x = await slash('556', code.toLowerCase().slice(0, 3) + '-' + code.slice(3)); assert.match(x.data.content, /Angemeldet/);
const p = await poll(nn); assert.match(p.token, /^[0-9a-f]{64}$/);
const me = await (await call('GET', '/my', p.token)).json(); assert.equal(me.name, 'Fritz');
x = await slash('555', code); assert.match(x.data.content, /kenne ich nicht/); // nur einmal gültig
console.log('app login ok');

nn = nonce(); const c2 = (await (await call('POST', '/auth/appcode', null, { n: nn })).json()).code;
x = await slash('560', c2); assert.match(x.data.content, /nicht geklappt|kenne/);
const p2 = await poll(nn); assert.equal(p2.status, 403); assert.equal(p2.error, 'not_member');
console.log('not on server -> not_member ok');
r = await call('POST', '/auth/appcode', null, { n: 'xyz' }); assert.equal(r.status, 400);
console.log('ALL OK'); process.exit(0);
