// Zustimmung zur Anzeige des Discord-Namens (Häkchen vor der Anmeldung). Mock-Discord auf :8801, Setup wie test/wanted.mjs (.dev.vars, test/reset.sh).
import http from 'node:http';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
const W = 'http://localhost:8799/api';
const USERS = { 555: { username: 'eva_x', global_name: 'Eva', nick: 'Eva vom Server', roles: ['777'] }, 556: { username: 'fritz', global_name: 'Fritz', nick: null, roles: ['777'] } };
let cur = '555';
const srv = http.createServer((req, res) => {
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
    if (req.method === 'POST' && u.pathname.endsWith('/messages')) return out({ id: 'msg' + Date.now() });
    if (req.method === 'POST' && u.pathname.endsWith('/threads')) return out({ id: 'T' + Date.now() });
    if (u.pathname.startsWith('/channels/')) return out({ id: 'x' });
    out({}, 404);
  });
}).listen(8801);
const hex = (k) => Array.from(crypto.getRandomValues(new Uint8Array(k)), (x) => x.toString(16).padStart(2, '0')).join('');
// Anmeldung über den Mock; consent = Häkchen gesetzt (c=1). Gibt die Antwort von /auth/poll zurück.
async function login(id, consent) {
  await fetch('http://localhost:8801/set?as=' + id); const nn = hex(16);
  let r = await fetch(W + '/auth/discord?' + (consent ? 'c=1&' : '') + 'n=' + nn, { redirect: 'manual' }); const cookie = r.headers.get('set-cookie').split(';')[0];
  r = await fetch(r.headers.get('location'), { redirect: 'manual' });
  const page = await (await fetch(r.headers.get('location'), { headers: { cookie } })).text();
  const p = await fetch(W + '/auth/poll?n=' + nn);
  return { status: p.status, body: await p.json(), page };
}
const call = (m, p, tok, b, h = {}) => fetch(W + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { 'x-session': tok } : {}), ...h }, body: b ? JSON.stringify(b) : undefined });
const sql = (q) => execSync(`npx wrangler d1 execute n3-spiele --local --command ${JSON.stringify(q)}`, { stdio: 'pipe' }).toString();
const today = new Date().toISOString().slice(0, 10);

try {
  // 1) Ohne Häkchen: keine Anmeldung, das Popup erklärt warum.
  let r = await login('555', false);
  assert.equal(r.status, 403); assert.equal(r.body.error, 'consent_required'); assert.match(r.page, /Häkchen/);
  // 2) Mit Häkchen: angemeldet, Zustimmung mit Zeitstempel gespeichert.
  r = await login('555', true); assert.ok(r.body.token); const eva = r.body.token;
  let me = await (await call('GET', '/auth/me', eva)).json(); assert.equal(me.nameConsent, true);
  assert.match(sql("SELECT name_consent_at FROM members WHERE discord_id = '555'"), /\d{4}-\d\d-\d\dT/);
  // 3) Spätere Anmeldung ohne Häkchen geht, weil schon zugestimmt (erster Zeitpunkt bleibt).
  const first = sql("SELECT name_consent_at FROM members WHERE discord_id = '555'").match(/\d{4}-[\d:T.Z-]+/)[0];
  r = await login('555', false); assert.ok(r.body.token);
  r = await login('555', true); assert.ok(r.body.token);
  assert.ok(sql("SELECT name_consent_at FROM members WHERE discord_id = '555'").includes(first));
  // 4) Bestehende Anmeldung von vor dem Häkchen: /my sagt nameConsent false, Schreiben wird abgelehnt.
  const fritz = (await login('556', true)).body.token;
  sql("UPDATE members SET name_consent_at = NULL WHERE discord_id = '556'");
  let my = await call('GET', '/my', fritz); assert.equal(my.status, 200); assert.equal((await my.json()).nameConsent, false);
  r = await call('POST', '/plays', fritz, { game: 'Azul', date: today, players: 2 }); assert.equal(r.status, 403); assert.equal((await r.json()).error, 'consent_required');
  //    Mit Häkchen (Header beim Wiederholen) klappt es und wird gespeichert.
  r = await call('POST', '/plays', fritz, { game: 'Azul', date: today, players: 2 }, { 'x-name-consent': '1' }); assert.equal(r.status, 200, await r.clone().text());
  my = await (await call('GET', '/my', fritz)).json(); assert.equal(my.nameConsent, true);
  //    Oder nachträglich über /auth/consent.
  sql("UPDATE members SET name_consent_at = NULL WHERE discord_id = '556'");
  r = await call('POST', '/auth/consent', fritz); assert.equal(r.status, 200); assert.ok((await r.json()).at);
  r = await call('POST', '/plays', fritz, { game: 'Azul', date: today, players: 2 }); assert.equal(r.status, 200);
  // 5) Mitspielen bei offener Runde ohne Zustimmung: nicht still als Gast eintragen, sondern nachfragen.
  r = await call('POST', '/parties', eva, { game: 'Azul', date: today, time: '18:00', seats: 4 }); assert.equal(r.status, 200, await r.clone().text()); const pid = (await r.json()).id;
  sql("UPDATE members SET name_consent_at = NULL WHERE discord_id = '556'");
  r = await call('POST', `/parties/${pid}/join`, fritz, { key: 'k' + hex(8), name: 'Fritz' }); assert.equal(r.status, 403); assert.equal((await r.json()).error, 'consent_required');
  console.log('name-consent: OK');
} finally { srv.close(); }
