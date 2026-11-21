// Wunschspiele: Angemeldete (Discord) markieren Spiele, die sie beim nächsten Stammtisch spielen möchten.
// Jede Stimme gilt für genau einen Stammtisch-Tag (den nächsten ab heute, laut Verwaltung). Ist der Tag vorbei,
// zählen die Stimmen nicht mehr (nächtlich gelöscht), und für den nächsten Stammtisch wird neu gewählt.
// Spiel-Schlüssel: BGG-ID als Text, ohne BGG-ID „n:“ + Name in Kleinbuchstaben (Sammlung und Mitgliederspiele zusammen).
import { berlinToday } from './discord.js';
import { getBooking, nextStammtische } from './booking.js';

export const VOTE_MAX = 5; // Stimmen pro Person und Stammtisch
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);

let tableOk = false;
export async function ensureVotes(env) {
  if (tableOk) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS votes (day TEXT NOT NULL, game_key TEXT NOT NULL, discord_id TEXT NOT NULL, name TEXT NOT NULL, game TEXT NOT NULL, game_id INTEGER, year INTEGER, mem INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (day, game_key, discord_id))').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS votes_user ON votes(discord_id, day)').run();
  tableOk = true;
}

// Der Stammtisch, für den gerade abgestimmt wird: heute (falls Stammtisch) oder der nächste.
export async function voteDay(env) {
  return nextStammtische(berlinToday(), await getBooking(env), 1)[0] || '';
}
export const keyOf = (gameId, game) => (gameId > 0 ? String(gameId) : 'n:' + game.toLowerCase());

// Stimme setzen (on = true) oder zurücknehmen. Gibt 'vote_limit' zurück, wenn schon VOTE_MAX andere Stimmen vergeben sind.
export async function castVote(env, day, did, name, x, on) {
  const key = keyOf(x.gameId || 0, x.game);
  const locked = await lockedKeys(env, day, did);
  if (locked.includes(key)) return 'in_round';
  if (!on) { await env.DB.prepare('DELETE FROM votes WHERE day = ?1 AND game_key = ?2 AND discord_id = ?3').bind(day, key, did).run(); return 'ok'; }
  const used = (await env.DB.prepare('SELECT game_key FROM votes WHERE day = ?1 AND discord_id = ?2 AND game_key != ?3').bind(day, did, key).all()).results.filter((r) => !locked.includes(r.game_key)).length;
  if (used >= VOTE_MAX) return 'vote_limit';
  await env.DB.prepare('INSERT INTO votes(day, game_key, discord_id, name, game, game_id, year, mem, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(day, game_key, discord_id) DO NOTHING')
    .bind(day, key, did, name, x.game, x.gameId || null, x.year || null, x.mem ? 1 : 0, new Date().toISOString()).run();
  return 'ok';
}

// Rangliste: meiste Stimmen zuerst, bei Gleichstand wer zuerst gewählt wurde.
// Schon geplante Runden am Tag zählen automatisch als Stimmen: Ersteller und Mitspieler (ohne Abgesagte und unbestätigte Reservierungen).
// Map Spiel-Schlüssel -> { game, gameId, year, people: [{ id, name }] }; id = Discord-ID oder 'n:<name>' ohne Discord.
export async function autoVoters(env, day) {
  const out = new Map();
  if (!day) return out;
  const { results } = await env.DB.prepare('SELECT game_id, game, year, host, host_discord, attendees, created_at FROM parties WHERE date = ?1 AND play_id IS NULL ORDER BY created_at').bind(day).all();
  for (const r of results) {
    const key = keyOf(Number(r.game_id) || 0, String(r.game || '').trim());
    let x = out.get(key);
    if (!x) out.set(key, (x = { game: r.game, gameId: Number(r.game_id) || null, year: r.year || null, at: r.created_at, people: [] }));
    const add = (id, name) => { if (name && !x.people.some((p) => p.id === id)) x.people.push({ id, name }); };
    add(r.host_discord || 'n:' + String(r.host || '').toLowerCase(), r.host);
    let att = {}; try { att = JSON.parse(r.attendees || '{}'); } catch { /* leer */ }
    for (const [k, a] of Object.entries(att)) { if (!a || a.out || a.res) continue; add(a.did || (/^d\d+$/.test(k) ? k.slice(1) : 'n:' + String(a.name || '').toLowerCase()), a.name); }
  }
  return out;
}
// Spiele, für die die Person automatisch zählt (Runde am Tag) – dort kann sie nicht selbst abstimmen.
export async function lockedKeys(env, day, did) {
  const auto = await autoVoters(env, day);
  return [...auto].filter(([, x]) => x.people.some((p) => p.id === did)).map(([k]) => k);
}

export async function voteList(env, day) {
  if (!day) return [];
  const { results } = await env.DB.prepare('SELECT * FROM votes WHERE day = ?1 ORDER BY created_at').bind(day).all();
  const auto = await autoVoters(env, day), by = new Map();
  for (const [key, a] of auto) by.set(key, { key, gameId: a.gameId, game: a.game, year: a.year, mem: false, names: a.people.map((p) => p.name), auto: a.people.length, first: a.at });
  for (const r of results) {
    const a = auto.get(r.game_key);
    if (a && a.people.some((p) => p.id === r.discord_id)) continue; // zählt schon über die Runde
    let x = by.get(r.game_key);
    if (!x) by.set(r.game_key, (x = { key: r.game_key, gameId: r.game_id, game: r.game, year: r.year, mem: !!r.mem, names: [], auto: 0, first: r.created_at }));
    if (x.auto) x.mem = x.mem || !!r.mem;
    x.names.push(r.name);
  }
  return [...by.values()].sort((a, b) => b.names.length - a.names.length || a.first.localeCompare(b.first)).map(({ first, ...x }) => ({ ...x, n: x.names.length }));
}

export async function myVotes(env, discordId) {
  await ensureVotes(env);
  const day = await voteDay(env); if (!day) return [];
  const locked = new Set(await lockedKeys(env, day, discordId));
  const { results } = await env.DB.prepare('SELECT game_key FROM votes WHERE day = ?1 AND discord_id = ?2').bind(day, discordId).all();
  return results.map((r) => r.game_key).filter((k) => !locked.has(k));
}
export async function myLocked(env, discordId) { const day = await voteDay(env); return day ? lockedKeys(env, day, discordId) : []; }

// Nächtlich: Stimmen vergangener Stammtische löschen.
export async function expireVotes(env) {
  await ensureVotes(env);
  const r = await env.DB.prepare('DELETE FROM votes WHERE day < ?1').bind(berlinToday()).run();
  return r.meta.changes || 0;
}

// Routen /votes…; null, wenn der Pfad nicht passt. h = Hilfsfunktionen aus index.js.
export async function votesRoute(req, env, ctx, path, m, ip, h) {
  if (!path.startsWith('/votes')) return null;
  const { json, fail, body, allow, checkMember } = h;
  await ensureVotes(env);
  if (path === '/votes' && m === 'GET') {
    const day = await voteDay(env);
    let post = null; try { post = h.postLink ? await h.postLink() : null; } catch { /* egal */ }
    return json({ day, max: VOTE_MAX, list: await voteList(env, day), post: post && post.day === day ? post.url : '' });
  }
  if (path === '/votes' && m === 'POST') {
    const u = await checkMember(req, env, ip); if (u.err) return fail(u.err === 'rate_limited' ? 429 : 403, u.err);
    if (!(await allow(env, 'vote:' + u.member.discord_id, 60, 600))) return fail(429, 'rate_limited');
    const day = await voteDay(env); if (!day) return fail(409, 'no_stammtisch');
    const b = await body(req);
    const game = str(b.game, 120), gameId = int(b.gameId);
    if (!game || (gameId != null && !(gameId > 0))) return fail(400, 'invalid');
    const did = u.member.discord_id;
    const res = await castVote(env, day, did, u.member.name, { game, gameId, year: int(b.year), mem: !!b.mem }, b.on !== false);
    if (res === 'vote_limit') return json({ error: 'vote_limit', max: VOTE_MAX }, 409);
    if (res === 'in_round') return json({ error: 'in_round' }, 409);
    if (h.onVote) ctx.waitUntil(h.onVote().catch((e) => console.log('vote post refresh failed', e && e.message)));
    return json({ day, max: VOTE_MAX, list: await voteList(env, day), mine: await myVotes(env, did), locked: await myLocked(env, did) });
  }
  return fail(404, 'not_found');
}
