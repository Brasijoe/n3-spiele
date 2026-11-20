// Mindestzahl für Runden: Anzeige, Eingabe „3-5“, Erinnerung am Vortag (Fake-DB und Fake-Discord, ohne Worker).
import assert from 'node:assert/strict';
import { minInfo, minText, parseSeats, view, warnMinPlayers, COMMANDS } from '../src/discord.js';

const att = (o) => JSON.stringify(o);
assert.equal(minInfo({ min_players: null, attendees: '{}' }), null);
assert.deepEqual(minInfo({ min_players: 3, attendees: att({ a: { name: 'A' } }) }), { min: 3, have: 2, ok: false, missing: 1 });
// Abgesagte und reservierte zählen nicht.
assert.deepEqual(minInfo({ min_players: 3, attendees: att({ a: { name: 'A' }, b: { name: 'B', out: 1 }, c: { name: 'C', res: 1 } }) }).have, 2);
assert.equal(minInfo({ min_players: 3, attendees: att({ a: { name: 'A' }, b: { name: 'B' } }) }).ok, true);
assert.match(minText({ min: 4, have: 2, ok: false, missing: 2 }), /fehlen noch 2/);
assert.match(minText({ min: 4, have: 3, ok: false, missing: 1 }), /fehlt noch 1/);
assert.deepEqual(parseSeats('5'), { min: null, seats: 5 });
assert.deepEqual(parseSeats(' 3-5 '), { min: 3, seats: 5 });
assert.deepEqual(parseSeats('3–6'), { min: 3, seats: 6 });
assert.equal(parseSeats('drei'), null);
const v = view({ id: 'p', game: 'Azul', date: '2026-12-01', time: '18:00', seats: 4, min_players: 3, host: 'Eva', attendees: '{}' });
assert.match(v.embeds[0].fields[1].value, /Mindestens 3: es fehlen noch 2/);
assert.ok(!/Mindest/.test(JSON.stringify(view({ id: 'p', game: 'Azul', date: '2026-12-01', seats: 4, host: 'Eva', attendees: '{}' }))));
assert.ok(COMMANDS.find((c) => c.name === 'party').options.some((o) => o.name === 'mindestens'));
console.log('min players helpers ok');

// Erinnerung am Vortag: erst ab 12 Uhr (Berlin), nur unvollständige Runden, nur einmal pro Datum.
const rows = [
  { id: 'r1', game: 'Azul', date: '2026-12-02', time: '18:00', seats: 4, min_players: 3, attendees: '{}', host_discord: '555', discord_thread: 'T1', thread_state: '{}', play_id: null, min_warn: null },
  { id: 'r2', game: 'Catan', date: '2026-12-02', time: '18:00', seats: 4, min_players: 2, attendees: att({ a: { name: 'A' } }), host_discord: '556', discord_thread: 'T2', thread_state: '{}', play_id: null, min_warn: null },
];
const db = { prepare(q) { return { bind(...a) { return {
  all: async () => ({ results: rows.filter((r) => r.date === a[0] && r.min_players != null && !r.play_id && (r.min_warn || '') !== r.date) }),
  run: async () => { if (/SET min_warn/.test(q)) rows.find((r) => r.id === a[1]).min_warn = a[0]; return { meta: { changes: 1 } }; },
}; } }; } };
const sent = [];
globalThis.fetch = async (url, o) => { const p = new URL(url).pathname.replace('/api/v10', ''); sent.push({ p, b: JSON.parse(o.body || 'null') }); return new Response(JSON.stringify({ id: p === '/users/@me/channels' ? 'DM' : 'm' }), { status: 200, headers: { 'content-type': 'application/json' } }); };
const env = { DB: db, DISCORD_BOT_TOKEN: 'x' };
assert.equal(await warnMinPlayers(env, new Date('2026-12-01T09:00:00Z')), 0); // 10 Uhr Berlin: noch zu früh
assert.equal(sent.length, 0);
assert.equal(await warnMinPlayers(env, new Date('2026-12-01T12:00:00Z')), 1);
assert.ok(sent.some((s) => s.p === '/channels/T1/messages' && /fehlen noch 2 Personen/.test(s.b.content)), 'thread warned');
assert.ok(sent.some((s) => s.p === '/users/@me/channels' && s.b.recipient_id === '555'), 'host DM');
assert.ok(!sent.some((s) => s.p.includes('T2') || (s.b && s.b.recipient_id === '556')), 'complete round not warned');
assert.equal(rows[0].min_warn, '2026-12-02'); assert.equal(rows[1].min_warn, '2026-12-02');
const n = sent.length; assert.equal(await warnMinPlayers(env, new Date('2026-12-01T14:00:00Z')), 0); assert.equal(sent.length, n, 'only once');
console.log('min players reminder ok');
