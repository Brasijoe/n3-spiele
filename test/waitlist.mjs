// Warteliste für volle Runden (Mock-Discord auf :8801, Setup wie test/threads.mjs: .dev.vars, DK_FILE).
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
const berlinIso = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(d);
const tue = (() => { const d = new Date(Date.now() + 864e5); while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1); return berlinIso(d); })();
const thu = (() => { const d = new Date(Date.now() + 864e5); while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1); return berlinIso(d); })();
const A = { 'x-admin-token': 'test-admin-pw' };
await call('PUT', '/admin/booking', null, { memberRole: '777', weekdays: [2], monthly: [{ nth: 1, wd: 6 }] }, A);
const eva = await login('555'), fritz = await login('556'), gast = await login('557');
const party = async (id) => (await (await call('GET', '/parties')).json()).find((p) => p.id === id);
const dms = (uid) => msgs.filter((q) => q.ch === 'DM' + uid);

// Runde mit 3 Plätzen (Eva + 2): Fritz (web) und Hans (Discord) füllen sie.
let r = await call('POST', '/parties', eva, { game: 'Azul', date: tue, time: '18:00', seats: 3 }); assert.equal(r.status, 200); const p = (await r.json()).id; await wait(1200);
const ann = msgs.find((q) => q.ch === 'CH1' && JSON.stringify(q).includes('Azul')); const T = 'T' + ann.id;
r = await call('POST', `/parties/${p}/join`, fritz, { key: 'kfritz1', name: 'Fritz' }); assert.equal(r.status, 200);
// Noch frei: Warteliste nicht möglich
r = await call('POST', `/parties/${p}/wait`, null, { key: 'kanon1', name: 'Anna' }); assert.equal(r.status, 409); assert.equal((await r.json()).error, 'not_full');
let x = await interact({ type: 3, ...as('558'), data: { custom_id: `join:${p}` } }); await wait(800);
assert.equal((await party(p)).waitlist.length, 0);
// Voll: Web-Join abgelehnt, Warteliste ok (anonym an Stammtisch-Tag), Discord-Knopf setzt Ida auf die Warteliste
r = await call('POST', `/parties/${p}/join`, null, { key: 'kanon1', name: 'Anna' }); assert.equal(r.status, 409);
r = await call('POST', `/parties/${p}/wait`, null, { key: 'kanon1', name: 'Anna' }); assert.equal(r.status, 200); assert.equal((await r.json()).pos, 1);
x = await interact({ type: 3, ...as('559'), data: { custom_id: `join:${p}` } });
assert.match(x.data.content, /Warteliste \(Platz 2\)/); await wait(1000);
x = await interact({ type: 3, ...as('559'), data: { custom_id: `join:${p}` } }); assert.match(x.data.content, /schon auf der Warteliste \(Platz 2\)/);
r = await call('POST', `/parties/${p}/wait`, fritz, { key: 'kfritz2', name: 'Fritz' }); assert.equal((await r.json()).error, 'already_in');
let pp = await party(p); assert.deepEqual(pp.waitlist.map((e) => e.name), ['Anna', 'Ida']);
const post = calls.filter((c) => c.m === 'PATCH' && c.p === `/channels/CH1/messages/${ann.id}`).pop();
assert.ok(JSON.stringify(post.b).includes('Warteliste (2)'), 'post shows waitlist');
assert.ok(JSON.stringify(post.b).includes('Auf die Warteliste'), 'button label');
console.log('waitlist join ok');

// Fritz sagt ab -> Anna rückt nach (ohne Discord: keine DM)
r = await call('POST', `/parties/${p}/leave`, fritz, { key: 'kfritz1' }); assert.equal(r.status, 200); await wait(800);
pp = await party(p); assert.ok(pp.attendees.kanon1 && !pp.attendees.kanon1.out, 'Anna moved up'); assert.deepEqual(pp.waitlist.map((e) => e.name), ['Ida']);
// Hans sagt über Discord ab -> Ida rückt nach, bekommt DM, Thread-Hinweis, wird Thread-Mitglied
x = await interact({ type: 3, ...as('558'), data: { custom_id: `leave:${p}` } }); await wait(1500);
pp = await party(p); assert.ok(pp.attendees.d559 && !pp.attendees.d559.out, 'Ida moved up'); assert.equal(pp.waitlist.length, 0);
assert.ok(dms('559').some((q) => /von der Warteliste nachgerückt/.test(q.content)), 'Ida DM');
assert.ok(msgs.some((q) => q.ch === T && /Warteliste nachgerückt: <@559>/.test(q.content)), 'thread note');
assert.ok(calls.some((c) => c.m === 'PUT' && c.p === `/channels/${T}/thread-members/559`), 'Ida in thread');
console.log('move up ok');

// Wieder voll: Fritz auf Warteliste, dann selbst runter (Absagen); dann Gast auf Warteliste, Eva erhöht Plätze -> Gast rückt nach
r = await call('POST', `/parties/${p}/wait`, fritz, { key: 'kfritz3', name: 'Fritz' }); assert.equal(r.status, 200);
r = await call('POST', `/parties/${p}/leave`, null, { key: 'kfritz3' }); assert.equal((await party(p)).waitlist.length, 0);
x = await interact({ type: 3, ...as('556'), data: { custom_id: `join:${p}` } }); await wait(500);
x = await interact({ type: 3, ...as('556'), data: { custom_id: `leave:${p}` } }); assert.match(x.data.content, /nicht mehr auf der Warteliste/);
r = await call('POST', `/parties/${p}/wait`, gast, { key: 'kgast1', name: 'Gast' }); assert.equal(r.status, 200);
r = await call('PUT', `/parties/${p}`, eva, { game: 'Azul', date: tue, time: '18:00', seats: 4, note: '' }); assert.equal(r.status, 200); await wait(1000);
pp = await party(p); assert.ok(pp.attendees.kgast1 && pp.attendees.kgast1.did === undefined || pp.attendees.kgast1, 'Gast moved up'); assert.equal(pp.waitlist.length, 0);
assert.ok(dms('557').some((q) => /nachgerückt/.test(q.content)), 'Gast DM (signed in)');
console.log('seat increase ok');

// Nicht-Stammtisch-Tag: Warteliste nur für Mitglieder
r = await call('POST', '/parties', eva, { game: 'Cascadia', date: thu, time: '18:00', seats: 2 }); const q = (await r.json()).id;
r = await call('POST', `/parties/${q}/join`, fritz, { key: 'kfritz9', name: 'Fritz' }); assert.equal(r.status, 200);
r = await call('POST', `/parties/${q}/wait`, gast, { key: 'kgast9', name: 'Gast' }); assert.equal((await r.json()).error, 'join_members_only');
r = await call('POST', `/parties/${q}/wait`, null, { key: 'kanon9', name: 'Anon' }); assert.equal((await r.json()).error, 'join_login');
x = await interact({ type: 3, ...as('557'), data: { custom_id: `join:${q}` } }); assert.match(x.data.content, /nur Mitglieder/);
// Absage der Runde: Wartende bekommen eine DM
x = await interact({ type: 3, ...as('559'), data: { custom_id: `join:${q}` } }); assert.match(x.data.content, /Warteliste/); await wait(500);
r = await call('DELETE', `/parties/${q}`, eva); await wait(1500);
assert.ok(dms('559').some((q2) => /Cascadia.*abgesagt/.test(q2.content)), 'waitlisted get cancel DM');
console.log('rules + cancel ok');
console.log('ALL OK');
process.exit(0);
