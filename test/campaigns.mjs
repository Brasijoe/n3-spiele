// Kampagnen (#kampagnen). Startet selbst einen Mock-Discord auf :8801 (OAuth, Bot-API, Kanal CH1, private Threads TH…).
// Worker per test/reset.sh mit .dev.vars wie in test/wanted.mjs (DISCORD_CHANNEL_ID=CH1, DISCORD_MEMBER_ROLE_ID=777, DISCORD_PUBLIC_KEY=<pub aus DK_FILE>).
// Mock-Nutzer: 555 Eva, 556 Fritz, 557 Gast, 558 Hans, 559 Ida (Mitglieder), 560 Nora (keine Mitgliederrolle).
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const W = 'http://localhost:8799/api';
const USERS = { 555: { username: 'eva_x', global_name: 'Eva', nick: 'Eva vom Server', roles: ['777'] }, 556: { username: 'fritz', global_name: 'Fritz', nick: null, roles: ['777'] }, 557: { username: 'gast', global_name: 'Gast', nick: null, roles: ['777'] }, 560: { username: 'nora', global_name: 'Nora', nick: null, roles: [] }, 558: { username: 'hans', global_name: 'Hans', nick: null, roles: ['777'] }, 559: { username: 'ida', global_name: 'Ida', nick: null, roles: ['777'] } };
const log = []; let cur = '555', n = 0, th = 0;
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
    if (u.pathname === '/channels/CH1' && req.method === 'GET') return out({ id: 'CH1', permission_overwrites: [] });
    const e = { method: req.method, path: u.pathname, body: b ? JSON.parse(b) : null };
    log.push(e);
    if (req.method === 'POST' && u.pathname === '/channels/CH1/threads') return out({ id: 'TH' + (++th) });
    if (req.method === 'POST' && /\/messages$/.test(u.pathname)) return out({ id: 'msg' + (++n) });
    if (req.method === 'POST' && u.pathname === '/users/@me/channels') return out({ id: 'DM' + (++n) });
    if (req.method === 'PUT' || req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    return out({ id: 'x' });
  });
}).listen(8801);

const hex = (k) => Array.from(crypto.getRandomValues(new Uint8Array(k)), (x) => x.toString(16).padStart(2, '0')).join('');
async function login(id) {
  await fetch('http://localhost:8801/set?as=' + id); const nn = hex(16);
  let r = await fetch(W + '/auth/discord?c=1&n=' + nn, { redirect: 'manual' }); const cookie = r.headers.get('set-cookie').split(';')[0];
  r = await fetch(r.headers.get('location'), { redirect: 'manual' }); await fetch(r.headers.get('location'), { headers: { cookie } });
  return (await (await fetch(W + '/auth/poll?n=' + nn)).json()).token;
}
const call = async (m, p, tok, b, h = {}) => { const r = await fetch(W + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { 'x-session': tok } : {}), ...h }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch { /* leer */ } return { status: r.status, d }; };
const { priv } = JSON.parse(fs.readFileSync(process.env.DK_FILE, 'utf8'));
const key = await crypto.subtle.importKey('pkcs8', Buffer.from(priv, 'base64'), 'Ed25519', false, ['sign']);
async function interact(obj) {
  const body = JSON.stringify({ guild_id: 'g1', channel_id: 'CH1', ...obj }), ts = String(Date.now());
  const sig = Buffer.from(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(ts + body))).toString('hex');
  return (await fetch(W + '/discord/interactions', { method: 'POST', headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body })).json();
}
const as = (id) => ({ member: { user: { id, username: USERS[id].username, global_name: USERS[id].global_name }, nick: USERS[id].nick, roles: USERS[id].roles, permissions: '0' } });
const inThread = (t) => ({ channel_id: t, channel: { id: t, parent_id: 'CH1', type: 12 } });
const wait = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const berlinIso = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(d);
const today = berlinIso(new Date());
const plus = (iso, k) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
// nächster Mittwoch ab morgen (kein Stammtisch-Tag nach Standardregel), höchstens 7 Tage weg
let wed = plus(today, 1); while (new Date(wed + 'T12:00:00Z').getUTCDay() !== 3) wed = plus(wed, 1);
const list = async (tok) => (await call('GET', '/campaigns', tok)).d;

const eva = await login('555'), fritz = await login('556'), gast = await login('557'), hans = await login('558'), ida = await login('559'), nora = await login('560');
const base = { game: 'Gloomhaven', gameId: 174430, year: 2017, start: wed, time: '18:30', rule: { t: 'x', wd: [3], every: 1, mo: [], extra: [], skip: [] }, sessions: 5, duration: 240, seats: 4, note: 'Wir starten bei Szenario 1.' };

let r = await call('POST', '/campaigns', null, base); assert.equal(r.status, 403);
r = await call('POST', '/campaigns', nora, base); assert.equal(r.d.error, 'members_only');
r = await call('POST', '/campaigns', eva, { ...base, start: plus(today, -1) }); assert.equal(r.d.error, 'past');
r = await call('POST', '/campaigns', eva, { ...base, rule: { t: 'x' } }); assert.equal(r.d.error, 'invalid');
r = await call('POST', '/campaigns', eva, base); assert.equal(r.status, 200, JSON.stringify(r.d));
const id = r.d.id;
assert.deepEqual(r.d.list.map((s) => s.date), [0, 7, 14, 21, 28].map((k) => plus(wed, k)));
await wait(1500);
// Post im Kanal, privater Thread, Ersteller hinzugefügt, erste Sitzung (<= 7 Tage) gepostet
const post = log.find((x) => x.method === 'POST' && x.path === '/channels/CH1/messages' && /Kampagne/.test(x.body.content));
assert.ok(post, 'campaign post'); assert.deepEqual(post.body.components[0].components.slice(0, 3).map((b) => b.custom_id), [`campj:${id}`, `campl:${id}`, `campi:${id}`]);
const thr = log.find((x) => x.path === '/channels/CH1/threads'); assert.equal(thr.body.type, 12); assert.equal(thr.body.invitable, false);
assert.ok(log.some((x) => x.method === 'PUT' && x.path === '/channels/TH1/thread-members/555'));
const s1post = log.find((x) => x.method === 'POST' && x.path === '/channels/TH1/messages' && /Sitzung 1 von ca\. 5/.test(x.body.content || ''));
assert.ok(s1post, 'session 1 posted'); assert.deepEqual(s1post.body.allowed_mentions.users, ['555']);
assert.equal(log.filter((x) => x.path === '/channels/TH1/messages' && /Sitzung 2 /.test(x.body && x.body.content || '')).length, 0);
let L = await list(eva); assert.equal(L.length, 1); assert.equal(L[0].phase, 'new'); assert.deepEqual(L[0].you, { host: true, in: true, invited: false, res: false }); assert.equal(JSON.stringify(L).includes('555'), false);
console.log('create ok');

// Mitmachen: Fritz (Mitglied) ja, Nora (ohne Mitgliederrolle) nein; Kampagnen sind nur für Mitglieder
r = await call('POST', `/campaigns/${id}/join`, fritz); assert.equal(r.status, 200);
r = await call('POST', `/campaigns/${id}/join`, nora); assert.equal(r.d.error, 'members_only');
// Einladen über Discord: Eva wählt Gast aus (privat per Direktnachricht, Platz reserviert)
const asDm = (id) => ({ guild_id: undefined, channel_id: 'DMC', channel: { id: 'DMC', type: 1 }, user: { id, username: USERS[id].username, global_name: USERS[id].global_name } });
const ch1Before = log.filter((y) => y.method === 'POST' && y.path === '/channels/CH1/messages').length;
let x = await interact({ type: 3, ...as('555'), data: { custom_id: `campi:${id}` } });
assert.equal(x.data.flags, 64); assert.equal(x.data.components[0].components[0].type, 5); assert.equal(x.data.components[0].components[0].custom_id, `campu:${id}:1`);
x = await interact({ type: 3, ...as('555'), data: { custom_id: `campt:${id}:0` } }); assert.equal(x.type, 7); assert.equal(x.data.flags, undefined, 'no flags on update'); assert.equal(x.data.components[0].components[0].custom_id, `campu:${id}:0`);
const mem = (u) => ({ user: { id: u, global_name: USERS[u].global_name }, nick: USERS[u].nick, roles: USERS[u].roles });
const invite = async (who, res = 1) => interact({ type: 3, ...as('555'), data: { custom_id: `campu:${id}:${res}`, component_type: 5, values: [who, '556'], resolved: { users: { [who]: { id: who, global_name: USERS[who].global_name }, 556: { id: '556' } }, members: { [who]: mem(who), 556: mem('556') } } } });
// Nora (kein Mitglied) kann nicht eingeladen werden
x = await invite('560'); assert.equal(x.type, 7); assert.match(x.data.content, /Nora ist kein Mitglied/); assert.equal(log.some((y) => y.path === '/users/@me/channels' && y.body.recipient_id === '560'), false);
x = await invite('557'); assert.match(x.data.content, /Eingeladen ✓ Gast/); await wait();
assert.ok(log.some((y) => y.method === 'POST' && y.path === '/users/@me/channels' && y.body.recipient_id === '557'), 'dm opened');
let dmMsg = log.filter((y) => y.method === 'POST' && /^\/channels\/DM\d+\/messages$/.test(y.path)).at(-1);
assert.match(dmMsg.body.content, /lädt dich zur Kampagne/); assert.match(dmMsg.body.content, /Platz ist für dich reserviert/);
assert.deepEqual(dmMsg.body.components[0].components.slice(0, 2).map((b) => b.custom_id), [`campj:${id}`, `campd:${id}`]);
assert.equal(log.filter((y) => y.method === 'POST' && y.path === '/channels/CH1/messages').length, ch1Before, 'no public invite');
assert.ok(log.some((y) => y.method === 'POST' && y.path === '/channels/TH1/messages' && /hat \*\*Gast\*\* eingeladen \(Platz reserviert/.test(y.body.content || '')), 'thread note invite');
const postPatch = log.filter((y) => y.method === 'PATCH' && /^\/channels\/CH1\/messages\//.test(y.path)).at(-1);
const dabei = postPatch.body.embeds[0].fields.find((f) => /Dabei/.test(f.name)).value; assert.match(dabei, /🟨 <@557> · eingeladen, Platz reserviert/);
assert.match(postPatch.body.embeds[0].fields.find((f) => /Plätze/.test(f.name)).value, /🟩🟩🟨⬜ .*1 reserviert/);
L = await list(eva); assert.equal(L[0].reserved, 1); assert.equal(L[0].invited.length, 1); assert.equal(L[0].invited[0].name, 'Gast'); assert.ok(L[0].invited[0].k);
let G = await list(gast); assert.deepEqual(G[0].you, { host: false, in: false, invited: true, res: true }); assert.deepEqual(G[0].invited, []);
L = await list(fritz); assert.equal(L[0].invited[0].k, undefined, 'only host sees keys');
// Platz bleibt reserviert: Hans kommt noch rein, danach ist voll (Eva, Fritz, Hans + Gast reserviert)
x = await interact({ type: 3, ...as('558'), message: { id: 'msgX' }, data: { custom_id: `campj:${id}` } }); assert.match(x.data.content, /Du bist dabei/);
r = await call('POST', `/campaigns/${id}/join`, ida); assert.equal(r.d.error, 'full');
x = await invite('559'); assert.match(x.data.content, /Nur noch 0/);
// Gast lehnt in der Direktnachricht ab -> Platz frei, Hinweis im Thread
x = await interact({ type: 3, ...asDm('557'), message: { id: dmMsg.body ? 'dm1' : 'dm1' }, data: { custom_id: `campd:${id}` } }); assert.equal(x.type, 7); assert.match(x.data.content, /abgelehnt/); await wait();
assert.ok(log.some((y) => y.path === '/channels/TH1/messages' && /Gast\*\* hat die Einladung abgelehnt/.test(y.body && y.body.content || '')), 'thread note decline');
L = await list(eva); assert.equal(L[0].reserved, 0); assert.equal(L[0].invited.length, 0);
// Wieder einladen, Eva nimmt zurück (Discord-Menü), dann noch einmal einladen und per Web zurücknehmen
x = await invite('557'); await wait();
x = await interact({ type: 3, ...as('555'), data: { custom_id: `campi:${id}` } }); const kSel = x.data.components[2].components[0]; assert.equal(kSel.type, 3); assert.equal(kSel.options[0].label, 'Gast');
x = await interact({ type: 3, ...as('556'), data: { custom_id: `campk:${id}`, component_type: 3, values: [kSel.options[0].value] } }); assert.match(x.data.content, /Nur Eva|nur Eva/);
x = await interact({ type: 3, ...as('555'), data: { custom_id: `campk:${id}`, component_type: 3, values: [kSel.options[0].value] } }); assert.match(x.data.content, /Zurückgenommen ✓ \(1\)/); await wait();
assert.ok(log.some((y) => y.method === 'PATCH' && /^\/channels\/DM\d+\/messages\/msg\d+$/.test(y.path) && /zurückgenommen/.test(y.body.content)), 'dm closed');
x = await invite('557'); await wait();
L = await list(eva); r = await call('DELETE', `/campaigns/${id}/invited/${L[0].invited[0].k}`, fritz); assert.equal(r.status, 403);
r = await call('DELETE', `/campaigns/${id}/invited/${L[0].invited[0].k}`, eva); assert.equal(r.status, 200); L = await list(eva); assert.equal(L[0].invited.length, 0);
// Letzte Einladung: Gast nimmt per Direktnachricht an (Rollen werden beim Server nachgefragt; voll außer seinem Platz)
x = await invite('557'); await wait();
x = await interact({ type: 3, ...asDm('557'), message: { id: 'dm2' }, data: { custom_id: `campj:${id}` } }); assert.equal(x.type, 7, JSON.stringify(x)); assert.match(x.data.content, /dabei ✓/); await wait();
assert.ok(log.some((y) => y.path === '/channels/TH1/messages' && /Gast\*\* hat die Einladung angenommen/.test(y.body && y.body.content || '')), 'thread note accept');
r = await call('POST', `/campaigns/${id}/join`, ida); assert.equal(r.d.error, 'full');
for (const u of ['556', '557', '558']) assert.ok(log.some((y) => y.method === 'PUT' && y.path === '/channels/TH1/thread-members/' + u), 'thread member ' + u);
L = await list(fritz); assert.deepEqual(L[0].players, ['Fritz', 'Gast', 'Hans']); assert.deepEqual(L[0].you, { host: false, in: true, invited: false, res: false }); assert.equal(L[0].reserved, 0);
console.log('join + invite ok');

// Verschieben: Fritz schlägt Sitzung 1 einen Tag später vor; alle stimmen zu -> verschoben
const s1 = L[0].list[0].id, s2 = L[0].list[1].id;
r = await call('POST', `/campaigns/s/${s1}/propose`, ida, { date: plus(wed, 1), time: '19:00' }); assert.equal(r.d.error, 'not_in');
r = await call('POST', `/campaigns/s/${s1}/propose`, fritz, { date: plus(wed, 1), time: '19:00' }); assert.equal(r.d.applied, false);
await wait();
const pm = log.filter((y) => y.method === 'POST' && y.path === '/channels/TH1/messages').at(-1); assert.match(pm.body.content, /Fritz\*\* schlägt für \*\*Sitzung 1/);
assert.deepEqual(pm.body.components[0].components.map((b) => b.custom_id.split(':')[0]), ['campy', 'campn', 'campa', 'campx']);
L = await list(eva); assert.deepEqual(L[0].list[0].prop.open, ['Eva vom Server', 'Gast', 'Hans']);
x = await interact({ type: 3, ...as('555'), ...inThread('TH1'), data: { custom_id: `campy:${s1}` } }); assert.match(JSON.stringify(x.data.embeds), /Passt \(2\)/);
x = await interact({ type: 3, ...as('557'), ...inThread('TH1'), data: { custom_id: `campn:${s1}` } }); assert.equal(x.type, 7);
r = await call('POST', `/campaigns/s/${s1}/vote`, hans, { yes: true }); assert.equal(r.d.applied, false);
r = await call('POST', `/campaigns/s/${s1}/vote`, gast, { yes: true }); assert.equal(r.d.applied, true);
await wait();
L = await list(eva); assert.equal(L[0].list[0].date, plus(wed, 1)); assert.equal(L[0].list[0].time, '19:00'); assert.equal(L[0].list[0].moved, true); assert.equal(L[0].list[0].prop, null);
assert.ok(log.some((y) => y.method === 'POST' && y.path === '/channels/TH1/messages' && /Verschoben: Sitzung 1/.test(y.body.content || '')));
console.log('reschedule vote ok');

// Absage: Hans schlägt über Discord vor, Sitzung 2 ausfallen zu lassen; Eva (Ersteller) übernimmt auf der Webseite
x = await interact({ type: 3, ...as('558'), ...inThread('TH1'), data: { custom_id: `campc:${s2}` } }); assert.match(x.data.content, /Absage vorgeschlagen/);
await wait();
L = await list(eva); assert.equal(L[0].list[1].prop.cancel, true);
r = await call('POST', `/campaigns/s/${s2}/accept`, fritz); assert.equal(r.d.error, 'forbidden');
r = await call('POST', `/campaigns/s/${s2}/accept`, eva); assert.equal(r.d.applied, true);
await wait();
L = await list(eva); assert.equal(L[0].sessions, 4); assert.equal(L[0].list.some((s) => s.id === s2), false);
assert.ok(log.some((y) => y.method === 'POST' && y.path === '/channels/TH1/messages' && /Sitzung 2 am .* fällt aus/.test(y.body.content || '')));
console.log('cancel vote ok');

// Kann diesmal nicht (Discord) und Ersteller-Verschiebung direkt
x = await interact({ type: 3, ...as('557'), ...inThread('TH1'), data: { custom_id: `camps:${s1}` } }); assert.match(JSON.stringify(x.data.embeds), /Kann diesmal nicht \(1\)/);
L = await list(gast); assert.equal(L[0].list[0].you.absent, true); assert.deepEqual(L[0].list[0].absent, ['Gast']);
r = await call('POST', `/campaigns/s/${s1}/propose`, eva, { date: plus(wed, 2), time: '18:00', apply: true }); assert.equal(r.d.applied, true);
L = await list(eva); assert.equal(L[0].list[0].date, plus(wed, 2)); assert.deepEqual(L[0].list[0].absent, []);
console.log('absent + direct apply ok');

// Bearbeiten: mehr Sitzungen (nur hinten anhängen), dann neuer Rhythmus (alle 2 Wochen)
r = await call('PUT', `/campaigns/${id}`, fritz, { ...base, sessions: 6 }); assert.equal(r.d.error, 'forbidden');
r = await call('PUT', `/campaigns/${id}`, eva, { ...base, seats: 3 }); assert.equal(r.d.error, 'seats_taken');
r = await call('PUT', `/campaigns/${id}`, eva, { ...base, sessions: 6 }); assert.equal(r.status, 200, JSON.stringify(r.d));
L = await list(eva); assert.equal(L[0].sessions, 6); assert.equal(L[0].list[0].date, plus(wed, 2)); assert.equal(L[0].list.at(-1).date, plus(wed, 42));
r = await call('PUT', `/campaigns/${id}`, eva, { ...base, sessions: 6, rule: { t: 'w', n: 2 } }); assert.equal(r.status, 200);
L = await list(eva); assert.deepEqual(L[0].list.map((s) => s.date), [0, 14, 28, 42, 56, 70].map((k) => plus(wed, k)));
r = await call('PUT', `/campaigns/${id}`, null, { ...base, sessions: 6, rule: { t: 'm', nth: 1, wd: 6 }, open: false }, { 'x-admin-token': 'test-admin-pw' }); assert.equal(r.status, 200);
L = await list(eva); assert.equal(L[0].open, false); assert.ok(L[0].list.every((s) => new Date(s.date + 'T12:00:00Z').getUTCDay() === 6 && +s.date.slice(8) <= 7));
console.log('edit ok');

// Termin noch offen: anlegen ohne Start/Rhythmus, später festlegen
r = await call('POST', '/campaigns', fritz, { game: 'Pandemic Legacy', tbd: true, sessions: 12, seats: 4 }); assert.equal(r.status, 200, JSON.stringify(r.d));
const id2 = r.d.id; assert.equal(r.d.tbd, true); assert.equal(r.d.list.length, 0); assert.equal(r.d.phase, 'new');
r = await call('POST', `/campaigns/${id2}/join`, nora); assert.equal(r.d.error, 'members_only');
r = await call('POST', `/campaigns/${id2}/join`, ida); assert.equal(r.status, 200);
r = await call('PUT', `/campaigns/${id2}`, fritz, { game: 'Pandemic Legacy', start: plus(today, 30), time: '18:00', rule: { t: 'd', n: 10 }, sessions: 12, seats: 4 }); assert.equal(r.status, 200, JSON.stringify(r.d));
L = await list(fritz); const c2 = L.find((c) => c.id === id2); assert.equal(c2.tbd, false); assert.equal(c2.list.length, 12); assert.equal(c2.list[1].date, plus(today, 40));
console.log('tbd ok');

// Aussteigen, beenden
r = await call('POST', `/campaigns/${id}/leave`, eva); assert.equal(r.d.error, 'host');
r = await call('POST', `/campaigns/${id}/leave`, hans); assert.equal(r.status, 200);
r = await call('DELETE', `/campaigns/${id}`, fritz); assert.equal(r.d.error, 'forbidden');
r = await call('DELETE', `/campaigns/${id}?outcome=aborted`, eva); assert.equal(r.status, 200);
await wait();
L = await list(eva); const ended = L.find((c) => c.id === id); assert.equal(ended.ended, true); assert.equal(ended.outcome, 'aborted'); assert.equal(ended.stats.played, 0); assert.equal(ended.list.length, 0, 'future sessions dropped');
assert.ok(log.some((y) => y.method === 'DELETE' && y.path === '/channels/TH1'), 'thread deleted (nothing played yet)');
assert.ok(log.some((y) => y.method === 'POST' && y.path === '/users/@me/channels'), 'players informed by DM');
r = await call('DELETE', `/campaigns/${id}?purge=1`, eva); assert.equal(r.status, 200);
L = await list(eva); assert.equal(L.some((c) => c.id === id), false);
console.log('leave + end ok');

// Partie zu einer Sitzung eintragen (Sitzung in die Vergangenheit legen), Statistik nach „zu Ende gespielt“
import { execSync } from 'node:child_process';
const sql = (q) => execSync(`npx wrangler d1 execute n3-spiele --local --command ${JSON.stringify(q)}`, { stdio: 'pipe' });
sql(`UPDATE campaign_sessions SET date = date(date, '-50 days'), planned = date(planned, '-50 days') WHERE campaign_id = '${id2}'`);
L = await list(fritz); let c3 = L.find((c) => c.id === id2); const past = c3.list.filter((s) => s.date < today);
assert.ok(past.length >= 2); assert.equal(c3.phase, 'running');
r = await call('POST', '/plays', fritz, { game: 'Pandemic Legacy', date: past[0].date, players: 2, winner: 'Alle', duration: 90, sessionId: past[0].id }); assert.equal(r.status, 200);
r = await call('POST', '/plays', ida, { game: 'pandemic legacy', date: past[1].date, players: 2, winner: 'Alle', duration: 120 }); assert.equal(r.status, 200);
await wait(1500);
L = await list(fritz); c3 = L.find((c) => c.id === id2); assert.ok(c3.list[0].playId); assert.ok(c3.list[1].playId, 'auto-linked by game + date');
r = await call('DELETE', `/campaigns/${id2}?outcome=done`, null, null, { 'x-admin-token': 'test-admin-pw' }); assert.equal(r.status, 200);
L = await list(fritz); c3 = L.find((c) => c.id === id2); assert.equal(c3.outcome, 'done'); assert.equal(c3.stats.logged, 2); assert.equal(c3.stats.minutes, 210); assert.deepEqual(c3.stats.winners, [{ name: 'Alle', n: 2 }]);
assert.equal(c3.stats.played, past.length); assert.ok(c3.list.every((s) => s.date <= today));
console.log('logging + stats ok');

// Cron: Sitzungen werden eine Woche vorher gepostet
await fetch('http://localhost:8799/__scheduled?cron=*/20+*+*+*+*'); await wait(1500);
console.log('all campaign tests passed');
process.exit(0);
