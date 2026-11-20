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
const keyOf = (gameId, game) => (gameId > 0 ? String(gameId) : 'n:' + game.toLowerCase());

// Rangliste: meiste Stimmen zuerst, bei Gleichstand wer zuerst gewählt wurde.
export async function voteList(env, day) {
  if (!day) return [];
  const { results } = await env.DB.prepare('SELECT * FROM votes WHERE day = ?1 ORDER BY created_at').bind(day).all();
  const by = new Map();
  for (const r of results) {
    let x = by.get(r.game_key);
    if (!x) by.set(r.game_key, (x = { key: r.game_key, gameId: r.game_id, game: r.game, year: r.year, mem: !!r.mem, names: [], first: r.created_at }));
    x.names.push(r.name);
  }
  return [...by.values()].sort((a, b) => b.names.length - a.names.length || a.first.localeCompare(b.first)).map(({ first, ...x }) => ({ ...x, n: x.names.length }));
}

export async function myVotes(env, discordId) {
  await ensureVotes(env);
  const day = await voteDay(env); if (!day) return [];
  const { results } = await env.DB.prepare('SELECT game_key FROM votes WHERE day = ?1 AND discord_id = ?2').bind(day, discordId).all();
  return results.map((r) => r.game_key);
}

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
    return json({ day, max: VOTE_MAX, list: await voteList(env, day) });
  }
  if (path === '/votes' && m === 'POST') {
    const u = await checkMember(req, env, ip); if (u.err) return fail(u.err === 'rate_limited' ? 429 : 403, u.err);
    if (!(await allow(env, 'vote:' + u.member.discord_id, 60, 600))) return fail(429, 'rate_limited');
    const day = await voteDay(env); if (!day) return fail(409, 'no_stammtisch');
    const b = await body(req);
    const game = str(b.game, 120), gameId = int(b.gameId);
    if (!game || (gameId != null && !(gameId > 0))) return fail(400, 'invalid');
    const key = keyOf(gameId || 0, game), did = u.member.discord_id;
    if (b.on === false) {
      await env.DB.prepare('DELETE FROM votes WHERE day = ?1 AND game_key = ?2 AND discord_id = ?3').bind(day, key, did).run();
    } else {
      const used = (await env.DB.prepare('SELECT COUNT(*) AS n FROM votes WHERE day = ?1 AND discord_id = ?2 AND game_key != ?3').bind(day, did, key).first()).n;
      if (used >= VOTE_MAX) return json({ error: 'vote_limit', max: VOTE_MAX }, 409);
      await env.DB.prepare('INSERT INTO votes(day, game_key, discord_id, name, game, game_id, year, mem, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(day, game_key, discord_id) DO NOTHING')
        .bind(day, key, did, u.member.name, game, gameId || null, int(b.year), b.mem ? 1 : 0, new Date().toISOString()).run();
    }
    return json({ day, max: VOTE_MAX, list: await voteList(env, day), mine: await myVotes(env, did) });
  }
  return fail(404, 'not_found');
}
