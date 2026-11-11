// „Mitglieder besitzen“ + „Mitbringen anfragen“. Startet selbst einen Mock-Discord auf :8801 (OAuth, Bot-API, Kanal CH1).
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

const eva = await login('555'), fritz = await login('556'), gast = await login('557');
// Eintragen: nur Mitglieder, nur mit Zustimmung, keine Doppelten
let r = await call('POST', '/member-games', eva, { gameId: 13, game: 'CATAN', year: 1995 }); assert.equal((await r.json()).error, 'consent_missing');
r = await call('POST', '/member-games', gast, { gameId: 13, game: 'CATAN', consent: true }); assert.equal((await r.json()).error, 'members_only');
r = await call('POST', '/member-games', null, { gameId: 13, game: 'CATAN', consent: true }); assert.equal(r.status, 403);
r = await call('POST', '/member-games', eva, { gameId: 13, game: 'CATAN', year: 1995, note: 'mit Seefahrer', consent: true }); assert.equal(r.status, 200); const mg = (await r.json()).id;
r = await call('POST', '/member-games', eva, { gameId: 13, game: 'CATAN', consent: true }); assert.equal((await r.json()).error, 'already_added');
r = await call('POST', '/member-games', fritz, { game: 'Selbstgebautes Spiel', consent: true }); assert.equal(r.status, 200); const mg2 = (await r.json()).id;
let list = await (await fetch(W + '/member-games')).json();
assert.equal(list.length, 2); const cat = list.find((x) => x.id === mg); assert.equal(cat.owner, 'Eva vom Server'); assert.equal(cat.note, 'mit Seefahrer'); assert.equal(cat.discord_id, undefined);
assert.deepEqual((await (await call('GET', '/my', eva)).json()).memberGames, [mg]);
console.log('add member games ok (server name shown, consent required, members only)');

// Import aus der BGG-Sammlung (ausgewählte Einträge): Zustimmung nötig, Doppelte werden übersprungen
r = await call('POST', '/member-games/import', eva, { items: [{ id: 822, n: 'Carcassonne', y: 2000 }] }); assert.equal((await r.json()).error, 'consent_missing');
r = await call('POST', '/member-games/import', gast, { items: [{ id: 822, n: 'Carcassonne' }], consent: true }); assert.equal((await r.json()).error, 'members_only');
r = await call('POST', '/member-games/import', eva, { items: [{ id: 822, n: 'Carcassonne', y: 2000 }, { id: 13, n: 'CATAN' }, { id: 822, n: 'Carcassonne' }, { id: 0, n: 'x' }], consent: true });
assert.deepEqual(await r.json(), { added: 1, skipped: 2, removed: 0 });
assert.equal((await (await call('GET', '/my', eva)).json()).bggSynced, true);
// Abgleich: Entfernen nur eigener Spiele
const carc = (await (await fetch(W + '/member-games')).json()).find((x) => x.gameId === 822 || x.game === 'Carcassonne').id;
r = await call('POST', '/member-games/import', fritz, { items: [], remove: [carc] }); assert.equal((await r.json()).removed, 0);
r = await call('POST', '/member-games/import', eva, { items: [], remove: [carc] }); assert.deepEqual(await r.json(), { added: 0, skipped: 0, removed: 1 });
r = await call('POST', '/member-games/import', eva, { items: [{ id: 822, n: 'Carcassonne', y: 2000 }], consent: true }); assert.equal((await r.json()).added, 1);
assert.equal((await (await fetch(W + '/member-games')).json()).filter((x) => x.owner === 'Eva vom Server').length, 2);
r = await call('GET', '/member-games/bgg?user=x', eva); assert.equal(r.status, 400);
console.log('bgg import ok');
await call('DELETE', '/member-games/' + (await (await fetch(W + '/member-games')).json()).find((x) => x.gameId === 822).id, eva);

// Löschen: nur Besitzer oder Admin
assert.equal((await call('DELETE', '/member-games/' + mg2, eva)).status, 403);
assert.equal((await call('DELETE', '/member-games/' + mg2, fritz)).status, 200);
console.log('delete own only ok');

// Anfrage: nur Mitglieder, nicht beim eigenen Spiel, 1–3 Termine ab heute
const plus = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10), d1 = plus(30), d2 = plus(32);
const deDay = (iso) => ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(iso + 'T12:00:00Z').getUTCDay()] + ', ' + iso.split('-').reverse().join('.');
r = await call('POST', `/member-games/${mg}/request`, gast, { dates: [d1] }); assert.equal((await r.json()).error, 'members_only');
r = await call('POST', `/member-games/${mg}/request`, eva, { dates: [d1] }); assert.equal((await r.json()).error, 'own_game');
r = await call('POST', `/member-games/${mg}/request`, fritz, { dates: ['2020-01-01'] }); assert.equal((await r.json()).error, 'bad_dates');
r = await call('POST', `/member-games/${mg}/request`, fritz, { dates: [d1, d2, plus(33), plus(34)] }); assert.equal((await r.json()).error, 'bad_dates');
r = await call('POST', `/member-games/${mg}/request`, fritz, { dates: [d2, d1], note: 'Hätte Lust!' }); assert.equal(r.status, 200, await r.clone().text()); const rq = (await r.json()).id;
r = await call('POST', `/member-games/${mg}/request`, fritz, { dates: [d1] }); assert.equal((await r.json()).error, 'already_requested');
let m = msgs.at(-1);
assert.match(m.content, /^<@555> \*\*Fritz\*\* \(<@556>\) fragt, ob du \*\*CATAN\*\* mitbringen kannst/);
assert.deepEqual(m.allowed_mentions, { users: ['555'] });
const btns = m.components[0].components; assert.deepEqual(btns.map((b) => b.custom_id), [`bringa:${rq}:0`, `bringa:${rq}:1`, `bringd:${rq}`, `bringx:${rq}`]);
assert.ok(btns[0].label.includes(d1.slice(8, 10) + '.' + d1.slice(5, 7) + '.'));
console.log('request posted to bot channel ok');

// Ohne Mitgliederrolle: nur mit Event-Code und nur an Eventtagen
r = await call('POST', `/member-games/${mg}/request`, gast, { dates: [d1] }); assert.equal((await r.json()).error, 'members_only');
r = await call('POST', '/admin/events', null, { name: 'Spieletag', from: plus(40), to: plus(41), validUntil: plus(41), code: 'SPIELTAG1' }, { 'x-admin-token': 'test-admin-pw' }); assert.equal(r.status, 200);
r = await call('POST', `/member-games/${mg}/request`, gast, { dates: [plus(40)], eventCode: 'FALSCH99' }); assert.equal((await r.json()).error, 'bad_event');
r = await call('POST', `/member-games/${mg}/request`, gast, { dates: [plus(40), plus(50)], eventCode: 'spieltag1' }); assert.equal((await r.json()).error, 'event_date');
r = await call('POST', `/member-games/${mg}/request`, gast, { dates: [plus(40), plus(41)], eventCode: 'SPIELTAG1', note: 'hi' }); assert.equal(r.status, 200);
assert.match(JSON.stringify(msgs.at(-1).embeds), /Event „Spieletag“ · hi/);
console.log('event code request for non-members ok');

// Nur der Besitzer kann annehmen; Annehmen öffnet ein Fenster für Uhrzeit und Plätze
let x = await interact({ type: 3, ...as('556'), data: { custom_id: `bringa:${rq}:0` } }); assert.match(x.data.content, /Nur <@555>/);
x = await interact({ type: 3, ...as('555'), data: { custom_id: `bringa:${rq}:0` } }); assert.equal(x.type, 9); assert.equal(x.data.components[1].components[0].value, '4');
const submit = (vals, u = '555') => interact({ type: 5, ...as(u), data: { custom_id: `bringa:${rq}:0`, components: Object.entries(vals).map(([k, v]) => ({ type: 1, components: [{ type: 4, custom_id: k, value: v }] })) } });
x = await submit({ uhrzeit: '25:00', plaetze: '5' }); assert.match(x.data.content, /Uhrzeit/);
x = await submit({ uhrzeit: '19:30', plaetze: '5' }); assert.equal(x.type, 7); assert.ok(x.data.content.includes('bringt **CATAN** am ' + deDay(d1) + ' um 19:30'), x.data.content);
await wait();
const parties = await (await fetch(W + '/parties')).json(); const pa = parties.find((p) => p.date === d1);
assert.equal(pa.host, 'Eva vom Server'); assert.equal(pa.time, '19:30'); assert.equal(pa.seats, 5); assert.equal(pa.guest, true); assert.equal(pa.gameId, 13);
assert.deepEqual(Object.values(pa.attendees).map((a) => a.name), ['Fritz']);
m = msgs.at(-1); assert.match(m.content, /<@556>, Eva vom Server bringt \*\*CATAN\*\* mit/); assert.deepEqual(m.allowed_mentions, { users: ['556'] }); assert.match(m.embeds[0].fields[2].value, /Fritz/);
assert.deepEqual((await (await call('GET', '/my', eva)).json()).parties, [pa.id]);
x = await submit({ uhrzeit: '19:30', plaetze: '5' }); assert.match(x.data.content, /schon angenommen/);
// Gastgeber kann die Runde wie üblich verwalten (Plätze/Uhrzeit ändern)
r = await call('PUT', '/parties/' + pa.id, eva, { game: 'CATAN', date: d1, time: '20:00', seats: 6, note: pa.note }); assert.equal(r.status, 200);
console.log('accept creates party with both members ok');

// Ablehnen: Fenster mit optionaler Nachricht, danach Kontakt-Buttons und Erwähnung der anfragenden Person
r = await call('POST', `/member-games/${mg}/request`, fritz, { dates: [d2] }); assert.equal(r.status, 200); const rq2 = (await r.json()).id;
x = await interact({ type: 3, ...as('555'), data: { custom_id: 'bringd:' + rq2 } }); assert.equal(x.type, 9);
x = await interact({ type: 5, ...as('555'), data: { custom_id: 'bringd:' + rq2, components: [{ type: 1, components: [{ type: 4, custom_id: 'grund', value: 'Geht erst im Februar' }] }] } });
assert.equal(x.type, 7); assert.match(x.data.content, /nicht mitbringen/); assert.deepEqual(x.data.components[0].components.map((b) => b.url), ['https://discord.com/users/555', 'https://discord.com/users/556']);
await wait();
m = msgs.at(-1); assert.match(m.content, /^<@556> .*Februar/); assert.deepEqual(m.allowed_mentions, { users: ['556'] });
console.log('decline with direct contact ok');

// Zurückziehen nur durch die anfragende Person
r = await call('POST', `/member-games/${mg}/request`, fritz, { dates: [d2] }); const rq3 = (await r.json()).id;
x = await interact({ type: 3, ...as('555'), data: { custom_id: 'bringx:' + rq3 } }); assert.match(x.data.content, /Nur wer angefragt/);
x = await interact({ type: 3, ...as('556'), data: { custom_id: 'bringx:' + rq3 } }); assert.equal(x.type, 7); assert.match(x.data.content, /Zurückgezogen/);
console.log('withdraw ok');

// Mehrere Besitzer: Anfrage geht an alle, wer zuerst annimmt, bringt es mit; Ablehnen nimmt nur die eine Person heraus
const hans = await login('558');
r = await call('POST', '/member-games', hans, { gameId: 13, game: 'CATAN', consent: true }); assert.equal(r.status, 200); const mgH = (await r.json()).id;
r = await call('POST', `/member-games/${mgH}/request`, fritz, { dates: [d2, plus(35)] }); assert.equal(r.status, 200); let j = await r.json(); const rq5 = j.id; assert.equal(j.owners, 2);
r = await call('POST', `/member-games/${mg}/request`, fritz, { dates: [d2] }); assert.equal((await r.json()).error, 'already_requested');
m = msgs.at(-1);
assert.match(m.content, /^<@555> <@558> \*\*Fritz\*\* \(<@556>\) fragt, ob jemand von euch \*\*CATAN\*\* mitbringen kann/); assert.match(m.content, /Wer zuerst einen Termin annimmt/);
assert.deepEqual(m.allowed_mentions, { users: ['555', '558'] });
x = await interact({ type: 3, ...as('556'), data: { custom_id: `bringa:${rq5}:0` } }); assert.match(x.data.content, /Nur <@555> <@558> können/);
// Hans lehnt ab: Anfrage bleibt für Eva offen
x = await interact({ type: 5, ...as('558'), data: { custom_id: 'bringd:' + rq5, components: [{ type: 1, components: [{ type: 4, custom_id: 'grund', value: 'Bin verreist' }] }] } });
assert.equal(x.type, 7); assert.equal(x.data.components[0].components.length, 4); assert.doesNotMatch(x.data.content, /<@558>/); assert.match(JSON.stringify(x.data.embeds), /Kann nicht.*Hans/);
await wait(); m = msgs.at(-1); assert.match(m.content, /^<@556> Hans kann .*verreist.*Eva vom Server kann die Anfrage noch annehmen/);
x = await interact({ type: 3, ...as('558'), data: { custom_id: `bringa:${rq5}:0` } }); assert.match(x.data.content, /schon abgelehnt/);
// Eva nimmt an; danach ist die Anfrage geschlossen
const sub5 = (u) => interact({ type: 5, ...as(u), data: { custom_id: `bringa:${rq5}:1`, components: [{ type: 1, components: [{ type: 4, custom_id: 'uhrzeit', value: '18:00' }] }, { type: 1, components: [{ type: 4, custom_id: 'plaetze', value: '4' }] }] } });
x = await sub5('555'); assert.equal(x.type, 7); assert.deepEqual(x.data.components, []); assert.match(x.data.content, /für die anderen Besitzer geschlossen/);
await wait(); assert.ok((await (await fetch(W + '/parties')).json()).some((p) => p.date === plus(35) && p.host === 'Eva vom Server'));
console.log('multi owner: request to all, decline one, accept closes ok');
// Wettlauf: beide öffnen das Annehmen-Fenster, nur die erste Person gewinnt
r = await call('POST', `/member-games/${mg}/request`, fritz, { dates: [plus(36)] }); const rq6 = (await r.json()).id;
const sub6 = (u) => interact({ type: 5, ...as(u), data: { custom_id: `bringa:${rq6}:0`, components: [{ type: 1, components: [{ type: 4, custom_id: 'uhrzeit', value: '18:00' }] }, { type: 1, components: [{ type: 4, custom_id: 'plaetze', value: '4' }] }] } });
assert.equal((await interact({ type: 3, ...as('555'), data: { custom_id: `bringa:${rq6}:0` } })).type, 9);
assert.equal((await interact({ type: 3, ...as('558'), data: { custom_id: `bringa:${rq6}:0` } })).type, 9);
x = await sub6('558'); assert.equal(x.type, 7); assert.match(x.data.content, /Hans/);
x = await sub6('555'); assert.match(x.data.content, /Hans bringt das Spiel mit/);
await wait(); assert.equal((await (await fetch(W + '/parties')).json()).filter((p) => p.date === plus(36)).length, 1);
// Alle lehnen ab -> Anfrage abgelehnt (Ida fragt, Fritz hat sein Tageslimit von 5 Anfragen erreicht)
const ida = await login('559');
r = await call('POST', `/member-games/${mg}/request`, ida, { dates: [plus(37)] }); const rq7 = (await r.json()).id;
const dec = (u) => interact({ type: 5, ...as(u), data: { custom_id: 'bringd:' + rq7, components: [{ type: 1, components: [{ type: 4, custom_id: 'grund', value: '' }] }] } });
x = await dec('555'); assert.equal(x.data.components[0].components.length, 3);
x = await dec('558'); assert.match(x.data.content, /Keiner der Besitzer/); assert.equal(x.data.components[0].components.length, 3);
await wait(); assert.match(msgs.at(-1).content, /^<@559> Leider kann keiner/);
// Hans entfernt sein Exemplar: Doppel-Anfragen werden weiter erkannt, Zurückziehen geht
r = await call('POST', `/member-games/${mg}/request`, ida, { dates: [plus(38)] }); const rq8 = (await r.json()).id;
assert.equal((await call('DELETE', '/member-games/' + mgH, hans)).status, 200);
r = await call('POST', `/member-games/${mg}/request`, ida, { dates: [plus(38)] }); assert.equal((await r.json()).error, 'already_requested');
x = await interact({ type: 3, ...as('559'), data: { custom_id: 'bringx:' + rq8 } }); assert.equal(x.type, 7);
console.log('multi owner race + all decline ok');

// Wer die Mitgliederrolle verliert, verschwindet aus der Liste; Admin kann löschen
USERS[555].roles = []; await call('PUT', '/admin/booking', null, { memberRole: '778', weekdays: [2] }, { 'x-admin-token': 'test-admin-pw' });
assert.equal((await (await fetch(W + '/member-games')).json()).length, 0);
await call('PUT', '/admin/booking', null, { memberRole: '', weekdays: [2] }, { 'x-admin-token': 'test-admin-pw' });
assert.equal((await (await fetch(W + '/member-games')).json()).length, 1);
assert.equal((await call('DELETE', '/member-games/' + mg, null, null, { 'x-admin-token': 'test-admin-pw' })).status, 200);
assert.equal((await (await fetch(W + '/member-games')).json()).length, 0);
console.log('membership filter + admin delete ok');

// Nächtliche Prüfung: Rolle verloren oder Server verlassen -> Spiele weg, offene Anfragen ungültig
await call('PUT', '/admin/booking', null, { memberRole: '777', weekdays: [2] }, { 'x-admin-token': 'test-admin-pw' }); USERS[555].roles = ['777'];
r = await call('POST', '/member-games', eva, { gameId: 30549, game: 'Pandemic', consent: true }); const mgE = (await r.json()).id;
r = await call('POST', '/member-games', ida, { gameId: 822, game: 'Carcassonne', consent: true }); assert.equal(r.status, 200);
r = await call('POST', `/member-games/${mgE}/request`, ida, { dates: [d2] }); const rq4 = (await r.json()).id; assert.ok(rq4);
const cron = () => fetch(W.replace(/\/api$/, '') + '/__scheduled?cron=17+3+*+*+*').then((x) => x.text()).then(() => new Promise((res) => setTimeout(res, 1500)));
USERS[559].roles = []; await cron();
list = await (await fetch(W + '/member-games')).json(); assert.deepEqual(list.map((x) => x.game), ['Pandemic']);
x = await interact({ type: 3, ...as('555'), data: { custom_id: 'bringa:' + rq4 + ':0' } }); assert.match(x.data.content, /gilt nicht mehr/);
delete USERS[555]; await cron();
assert.equal((await (await fetch(W + '/member-games')).json()).length, 0);
console.log('nightly prune (role lost / left server) ok');
process.exit(0);
