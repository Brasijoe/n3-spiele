// Mindestzahl für Runden im Worker (Mock-Discord auf :8801, Setup wie test/wanted.mjs: .dev.vars, DK_FILE, test/reset.sh).
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const W = 'http://localhost:8799/api';
const USERS = { 555: { username: 'eva_x', global_name: 'Eva', nick: 'Eva vom Server', roles: ['777'] }, 556: { username: 'fritz', global_name: 'Fritz', nick: null, roles: ['777'] }, 557: { username: 'gast', global_name: 'Gast', nick: null, roles: [] }, 558: { username: 'hans', global_name: 'Hans', nick: null, roles: ['777'] }, 559: { username: 'ida', global_name: 'Ida', nick: null, roles: ['777'] } };
const msgs = [], calls = [], history = []; let cur = '555', n = 0;
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
    if (u.pathname === '/users/@me/channels') { calls.push({ m: req.method, p: u.pathname, b: JSON.parse(b) }); return out({ id: 'DM' + JSON.parse(b).recipient_id }); }
    if (u.pathname.startsWith('/channels/')) {
      if (req.method === 'GET' && u.pathname === '/channels/CH1/messages') return out(history);
      const j = b ? JSON.parse(b) : null; calls.push({ m: req.method, p: u.pathname, b: j });
      if (req.method === 'POST' && (m = u.pathname.match(/^\/channels\/(\w+)\/messages\/(\w+)\/threads$/))) return out({ id: 'T' + m[2] });
      if (req.method === 'POST' && (m = u.pathname.match(/^\/channels\/(\w+)\/messages$/))) { const id = 'msg' + (++n); msgs.push({ id, ch: m[1], ...j }); return out({ id }); }
      if (req.method === 'PUT' || req.method === 'DELETE') { res.writeHead(204); return res.end(); }
      if (req.method === 'PATCH') return out({ id: 'x' });
    }
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


const eva = await login('555'), fritz = await login('556'), hans = await login('558');
const tue = (() => { const d = new Date(Date.now() + 864e5); while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1); return berlinIso(d); })();
const get = async (id) => (await (await call('GET', '/parties')).json()).find((p) => p.id === id);

// Web: ungültige Mindestzahl, dann Runde mit mind. 3 von 4.
let r = await call('POST', '/parties', eva, { game: 'Azul', gameId: 230802, date: tue, time: '18:00', seats: 4, minPlayers: 5, note: '' });
assert.equal(r.status, 400); assert.equal((await r.json()).error || 'bad_min', 'bad_min');
r = await call('POST', '/parties', eva, { game: 'Azul', gameId: 230802, date: tue, time: '18:00', seats: 4, minPlayers: 3, note: '' });
const pid = (await r.json()).id; await wait(1500);
assert.equal((await get(pid)).minPlayers, 3);
const post = msgs.find((q) => q.ch === 'CH1' && JSON.stringify(q).includes('Azul') && q.embeds && q.embeds[0].title);
assert.match(post.embeds[0].fields[1].value, /Mindestens 3: es fehlen noch 2/);
const T = 'T' + post.id;
assert.ok(msgs.some((q) => q.ch === T && /sobald mindestens 3 dabei sind/.test(q.content)), 'thread intro mentions minimum');
const ov = () => calls.filter((c) => c.p.startsWith('/channels/CH1/messages') && c.b && c.b.embeds && c.b.embeds[0].title === '📋 Offene Runden').pop();
assert.match(ov().b.embeds[0].description, /mind\. 3, fehlen 2/);
console.log('create ok');

// Zweite Zusage über Discord, dritte über Web: Mindestzahl erreicht → Nachricht im Thread.
await interact({ type: 3, ...as('556'), data: { custom_id: 'join:' + pid }, message: { id: post.id } }); await wait(800);
assert.ok(!msgs.some((q) => q.ch === T && /Mindestzahl erreicht/.test(q.content)), 'not yet reached');
r = await call('POST', `/parties/${pid}/join`, hans, { key: 'khans1', name: 'Hans' }); assert.equal(r.status, 200); await wait(1500);
assert.equal(msgs.filter((q) => q.ch === T && /Mindestzahl erreicht/.test(q.content)).length, 1, 'reached message once');
assert.match(ov().b.embeds[0].description, /✅ steht/);
// Absage → wieder darunter.
await interact({ type: 3, ...as('556'), data: { custom_id: 'leave:' + pid }, message: { id: post.id } }); await wait(800);
assert.ok(msgs.some((q) => q.ch === T && /Wieder unter der Mindestzahl/.test(q.content)), 'dropped message');
console.log('thread notices ok');

// Bearbeiten im Web: Mindestzahl auf 2 → erreicht; leer → keine Mindestzahl mehr.
r = await call('PUT', '/parties/' + pid, eva, { game: 'Azul', gameId: 230802, date: tue, time: '18:00', seats: 4, minPlayers: 2, note: '' }); assert.equal(r.status, 200); await wait(1200);
assert.equal(msgs.filter((q) => q.ch === T && /Mindestzahl erreicht/.test(q.content)).length, 2);
r = await call('PUT', '/parties/' + pid, eva, { game: 'Azul', gameId: 230802, date: tue, time: '18:00', seats: 4, minPlayers: null, note: '' }); await wait(800);
assert.equal((await get(pid)).minPlayers, null);
// Discord: /party mit mindestens, Bearbeiten-Fenster mit „3-5“.
const sp = await interact({ type: 2, ...as('555'), data: { name: 'party', options: [{ name: 'spiel', value: 'Catan' }, { name: 'datum', value: tue }, { name: 'plaetze', value: 4 }, { name: 'mindestens', value: 6 }] } });
assert.match(sp.data.content, /Mindestens: 2 bis 4/);
await interact({ type: 2, ...as('555'), data: { name: 'party', options: [{ name: 'spiel', value: 'Catan' }, { name: 'datum', value: tue }, { name: 'plaetze', value: 4 }, { name: 'mindestens', value: 3 }] } }); await wait(1200);
const cat = (await (await call('GET', '/parties')).json()).find((p) => p.game === 'Catan');
assert.equal(cat.minPlayers, 3);
const modal = await interact({ type: 3, ...as('555'), data: { custom_id: 'edit:' + cat.id } });
assert.equal(modal.data.components[3].components[0].value, '3-4');
const comps = (o) => Object.entries(o).map(([k, v]) => ({ type: 1, components: [{ type: 4, custom_id: k, value: v }] }));
await interact({ type: 5, ...as('555'), data: { custom_id: 'edit:' + cat.id, components: comps({ spiel: 'Catan', datum: tue, uhrzeit: '18:00', plaetze: '2-5', hinweis: '' }) } }); await wait(800);
let c2 = await get(cat.id); assert.equal(c2.minPlayers, 2); assert.equal(c2.seats, 5);
await interact({ type: 5, ...as('555'), data: { custom_id: 'edit:' + cat.id, components: comps({ spiel: 'Catan', datum: tue, uhrzeit: '18:00', plaetze: '5', hinweis: '' }) } }); await wait(800);
c2 = await get(cat.id); assert.equal(c2.minPlayers, null);
console.log('edit ok');
console.log('ALL OK');
process.exit(0);
