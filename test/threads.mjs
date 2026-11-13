// Discord-Thread pro Runde (Mock-Discord auf :8801, Setup wie test/wanted.mjs: .dev.vars, DK_FILE).
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const W = 'http://localhost:8799/api';
const USERS = { 555: { username: 'eva_x', global_name: 'Eva', nick: 'Eva vom Server', roles: ['777'] }, 556: { username: 'fritz', global_name: 'Fritz', nick: null, roles: ['777'] }, 557: { username: 'gast', global_name: 'Gast', nick: null, roles: [] }, 558: { username: 'hans', global_name: 'Hans', nick: null, roles: ['777'] }, 559: { username: 'ida', global_name: 'Ida', nick: null, roles: ['777'] } };
const msgs = [], calls = []; let cur = '555', n = 0;
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
    if (u.pathname.startsWith('/channels/')) {
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
// Thread pro Runde: anlegen mit Namen + Startnachricht, Mitglieder hinzufügen/entfernen, Umbenennen, Absage, nächtliches Archivieren.
const thr = (pid) => calls.filter((c) => c.p.includes(pid));
const tue = (() => { const d = new Date(Date.now() + 864e5); while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1); return berlinIso(d); })();
const dTxt = (iso) => iso.split('-').reverse().join('.');
let r = await call('POST', '/parties', eva, { game: 'Terraforming Mars', gameId: 167791, date: tue, time: '18:00', seats: 4, note: '' });
assert.equal(r.status, 200); const p1 = (await r.json()).id; await wait(1500);
const ann = msgs.find((q) => q.ch === 'CH1' && JSON.stringify(q).includes('Terraforming Mars')); assert.ok(ann, 'announced');
const T = 'T' + ann.id;
const mk = calls.find((c) => c.p === `/channels/CH1/messages/${ann.id}/threads`); assert.ok(mk, 'thread created');
assert.equal(mk.b.name, `Terraforming Mars · Di ${dTxt(tue)}`);
assert.ok(msgs.some((q) => q.ch === T && /Absprachen zur Runde hier/.test(q.content)), 'first message');
assert.ok(calls.some((c) => c.m === 'PUT' && c.p === `/channels/${T}/thread-members/555`), 'host added');
console.log('thread created ok');

r = await call('POST', `/parties/${p1}/join`, fritz, { key: 'kfritz1', name: 'Fritz' }); assert.equal(r.status, 200); await wait(1200);
assert.ok(calls.some((c) => c.m === 'PUT' && c.p === `/channels/${T}/thread-members/556`), 'web joiner added');
r = await call('POST', `/parties/${p1}/join`, null, { key: 'kanon1', name: 'Anonym' }); assert.equal(r.status, 200); await wait(1000);
assert.equal(calls.filter((c) => c.m === 'PUT' && c.p.startsWith(`/channels/${T}/thread-members/`)).length, 2, 'anonymous not added, no duplicate PUTs');
let x = await interact({ type: 3, ...as('558'), data: { custom_id: `join:${p1}` } }); await wait(1000);
assert.ok(calls.some((c) => c.m === 'PUT' && c.p === `/channels/${T}/thread-members/558`), 'discord joiner added');
r = await call('POST', `/parties/${p1}/leave`, fritz, { key: 'kfritz1' }); await wait(1000);
assert.ok(calls.some((c) => c.m === 'DELETE' && c.p === `/channels/${T}/thread-members/556`), 'leaver removed');
console.log('thread members ok');

const nd = (() => { const d = new Date(tue + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })();
r = await call('PUT', `/parties/${p1}`, eva, { game: 'Terraforming Mars', gameId: 167791, date: nd, time: '19:00', seats: 4, note: '' }); assert.equal(r.status, 200); await wait(1000);
assert.ok(calls.some((c) => c.m === 'PATCH' && c.p === `/channels/${T}` && c.b.name === `Terraforming Mars · Di ${dTxt(nd)}`), 'renamed');
r = await call('DELETE', `/parties/${p1}`, eva); assert.equal(r.status, 200); await wait(1000);
assert.ok(msgs.some((q) => q.ch === T && /abgesagt/.test(q.content)), 'cancel message');
assert.ok(calls.some((c) => c.m === 'PATCH' && c.p === `/channels/${T}` && c.b.archived === true && c.b.locked === true), 'archived on cancel');
console.log('thread rename + cancel ok');

r = await call('POST', '/parties', hans, { game: 'Spirit Island', gameId: 162886, date: tue, time: '19:00', seats: 4, note: '' }); const p2 = (await r.json()).id; await wait(1500);
const T2 = 'T' + msgs.find((q) => q.ch === 'CH1' && JSON.stringify(q).includes('Spirit Island')).id;
sql(`UPDATE parties SET date = '2020-01-07' WHERE id = '${p2}'`);
await fetch('http://localhost:8799/__scheduled?cron=17+3+*+*+*'); await wait(4000);
assert.ok(calls.some((c) => c.m === 'PATCH' && c.p === `/channels/${T2}` && c.b.archived === true), 'archived nightly');
const before = calls.length; await fetch('http://localhost:8799/__scheduled?cron=17+3+*+*+*'); await wait(3000);
assert.ok(!calls.slice(before).some((c) => c.p === `/channels/${T2}`), 'not archived twice');
console.log('thread nightly archive ok');
console.log('ALL OK');
process.exit(0);
