import { bggSearch, refreshGeeklist } from './bgg.js';
import { syncExtras, listExtras, coverResponse } from './games.js';
import { handleInteraction, registerCommands, ensureCols, stillMember, normCode, codeHash, discordOn, announceParty, syncParty, cancelPartyMessage } from './discord.js';

const SALT = 'n3-club:';
const enc = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, code) => json({ error: code }, status);
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const KEY_RE = /^[a-z0-9]{6,32}$/;

async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Einfache Begrenzung pro Schlüssel und Zeitfenster (in D1, damit sie über Instanzen hinweg gilt).
async function allow(env, key, max, windowSec) {
  const k = key + ':' + Math.floor(Date.now() / 1000 / windowSec);
  const row = await env.DB.prepare('INSERT INTO rate(k, n, ts) VALUES(?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n').bind(k, Date.now()).first();
  return row.n <= max;
}

async function isAdmin(req, env, ip) {
  const t = req.headers.get('x-admin-token') || '';
  if (!t || !env.ADMIN_TOKEN) return false;
  if (!(await allow(env, 'adm:' + ip, 20, 600))) return false;
  return safeEq(await sha256(t), await sha256(env.ADMIN_TOKEN));
}

// Gibt null zurück, wenn der Vereinscode stimmt, sonst einen Fehlercode.
async function checkClubCode(req, env, ip) {
  const code = (req.headers.get('x-club-code') || '').replace(/\D/g, '');
  if (code.length !== 4) return 'code_format';
  if (!(await allow(env, 'code:' + ip, 15, 600))) return 'rate_limited';
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'club_code_hash'").first();
  if (!row) return 'code_not_set';
  return safeEq(await sha256(SALT + code), row.value) ? null : 'bad_code';
}

// Persönlicher Code (per Discord /code). Gibt { member } oder { err } zurück.
async function checkMember(req, env, ip) {
  const code = normCode(req.headers.get('x-member-code'));
  if (code.length !== 8) return { err: 'code_format' };
  if (!(await allow(env, 'code:' + ip, 15, 600))) return { err: 'rate_limited' };
  await ensureCols(env);
  const m = await env.DB.prepare('SELECT * FROM members WHERE code_hash = ?1').bind(await codeHash(code)).first();
  if (!m) return { err: 'bad_code' };
  if (m.blocked) return { err: 'blocked' };
  if (!(await stillMember(env, m))) return { err: 'bad_code' };
  return { member: m };
}

async function body(req) {
  const text = await req.text();
  if (text.length > 16000) throw Object.assign(new Error('too_large'), { status: 413 });
  try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('bad_json'), { status: 400 }); }
}

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

const playOut = (r) => ({ id: r.id, gameId: r.game_id, game: r.game, guest: !!r.guest, year: r.year, date: r.date, players: r.players, winner: r.winner, note: r.note, duration: r.duration, firstPlay: !!r.first_play, createdAt: r.created_at });
const partyOut = (r) => ({ id: r.id, gameId: r.game_id, game: r.game, guest: !!r.guest, year: r.year, date: r.date, time: r.time, seats: r.seats, host: r.host, note: r.note, attendees: JSON.parse(r.attendees || '{}'), playId: r.play_id, createdAt: r.created_at });

// Discord-Aktualisierungen laufen im Hintergrund; Fehler dürfen die Webseite nie stören.
const bg = (ctx, p) => ctx.waitUntil(p.catch((e) => console.log('discord sync failed', e && e.message)));

async function route(req, env, ctx, url) {
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const m = req.method;
  let g;

  if (path === '/plays' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM plays ORDER BY created_at DESC LIMIT 500').all();
    return json(results.map(playOut));
  }
  if (path === '/plays' && m === 'POST') {
    const auth = await checkMember(req, env, ip); if (auth.err) return fail(auth.err === 'rate_limited' ? 429 : 403, auth.err);
    if (!(await allow(env, 'w:' + ip, 40, 600))) return fail(429, 'rate_limited');
    const b = await body(req);
    const game = str(b.game, 120), date = str(b.date, 10), players = int(b.players), duration = b.duration == null ? null : int(b.duration);
    if (!game || !isDate(date) || !(players >= 1 && players <= 99)) return fail(400, 'invalid');
    if (duration != null && !(duration >= 1 && duration <= 1440)) return fail(400, 'invalid');
    const id = newId();
    await env.DB.prepare('INSERT INTO plays(id, game_id, game, guest, year, date, players, winner, note, duration, first_play, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)')
      .bind(id, int(b.gameId), game, b.guest ? 1 : 0, int(b.year), date, players, str(b.winner, 80), str(b.note, 200), duration, b.firstPlay ? 1 : 0, new Date().toISOString()).run();
    if (b.partyId) { await env.DB.prepare('UPDATE parties SET play_id = ?1 WHERE id = ?2 AND play_id IS NULL').bind(id, str(b.partyId, 40)).run(); if (discordOn(env)) bg(ctx, ensureCols(env).then(() => syncParty(env, str(b.partyId, 40)))); }
    return json({ id });
  }
  if ((g = path.match(/^\/plays\/([\w-]+)$/)) && m === 'DELETE') {
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    await env.DB.prepare('DELETE FROM plays WHERE id = ?1').bind(g[1]).run();
    return json({ ok: true });
  }

  if (path === '/parties' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM parties ORDER BY date DESC, time DESC LIMIT 200').all();
    return json(results.map(partyOut));
  }
  if (path === '/parties' && m === 'POST') {
    const auth = await checkMember(req, env, ip); if (auth.err) return fail(auth.err === 'rate_limited' ? 429 : 403, auth.err);
    if (!(await allow(env, 'w:' + ip, 40, 600))) return fail(429, 'rate_limited');
    const b = await body(req);
    const game = str(b.game, 120), date = str(b.date, 10), time = str(b.time, 5), seats = int(b.seats), host = auth.member.name;
    if (!game || !host || !isDate(date) || !(seats >= 2 && seats <= 30) || (time && !/^\d{2}:\d{2}$/.test(time))) return fail(400, 'invalid');
    const id = newId(), hostKey = newId() + newId();
    await env.DB.prepare('INSERT INTO parties(id, game_id, game, guest, year, date, time, seats, host, host_key_hash, note, attendees, created_at, host_discord) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,\'{}\',?12,?13)')
      .bind(id, int(b.gameId), game, b.guest ? 1 : 0, int(b.year), date, time, seats, host, await sha256(hostKey), str(b.note, 200), new Date().toISOString(), auth.member.discord_id).run();
    if (discordOn(env)) bg(ctx, ensureCols(env).then(() => announceParty(env, id, null, true)));
    return json({ id, hostKey });
  }
  if ((g = path.match(/^\/parties\/([\w-]+)\/join$/)) && m === 'POST') {
    if (!(await allow(env, 'join:' + ip, 30, 600))) return fail(429, 'rate_limited');
    const b = await body(req), key = str(b.key, 32), name = str(b.name, 40);
    if (!KEY_RE.test(key) || !name) return fail(400, 'invalid');
    // Atomar: nur eintragen, wenn noch ein Platz frei ist (Gastgeber belegt einen Platz).
    const r = await env.DB.prepare(`UPDATE parties SET attendees = json_set(attendees, '$.' || ?1, json(?2))
      WHERE id = ?3 AND date >= ?4 AND (SELECT count(*) FROM json_each(parties.attendees) WHERE coalesce(json_extract(value, '$.out'), 0) = 0) + 1 < seats`)
      .bind(key, JSON.stringify({ name, at: new Date().toISOString() }), g[1], new Date(Date.now() - 864e5).toISOString().slice(0, 10)).run();
    if (!r.meta.changes) return fail(409, 'full_or_gone');
    if (discordOn(env)) bg(ctx, ensureCols(env).then(() => syncParty(env, g[1])));
    return json({ ok: true });
  }
  if ((g = path.match(/^\/parties\/([\w-]+)\/leave$/)) && m === 'POST') {
    const b = await body(req), key = str(b.key, 32);
    if (!KEY_RE.test(key)) return fail(400, 'invalid');
    await env.DB.prepare("UPDATE parties SET attendees = json_set(attendees, '$.' || ?1 || '.out', 1) WHERE id = ?2 AND json_type(attendees, '$.' || ?1) IS NOT NULL").bind(key, g[1]).run();
    if (discordOn(env)) bg(ctx, ensureCols(env).then(() => syncParty(env, g[1])));
    return json({ ok: true });
  }
  if ((g = path.match(/^\/parties\/([\w-]+)$/)) && m === 'DELETE') {
    const row = await env.DB.prepare('SELECT host_key_hash FROM parties WHERE id = ?1').bind(g[1]).first();
    if (!row) return json({ ok: true });
    const hk = req.headers.get('x-host-key') || '';
    const okHost = hk && safeEq(await sha256(hk), row.host_key_hash);
    if (!okHost && !(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    let old = null; if (discordOn(env)) { await ensureCols(env); old = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(g[1]).first(); }
    await env.DB.prepare('DELETE FROM parties WHERE id = ?1').bind(g[1]).run();
    if (old) bg(ctx, cancelPartyMessage(env, old));
    return json({ ok: true });
  }

  if (path === '/config/highlights') {
    if (m === 'GET') {
      const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'highlights'").first();
      return json(row ? JSON.parse(row.value) : null);
    }
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    if (m === 'DELETE') { await env.DB.prepare("DELETE FROM config WHERE key = 'highlights'").run(); return json({ ok: true }); }
    if (m === 'PUT') {
      const b = await body(req);
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(int).filter((x) => x > 0).slice(0, 30);
      const desc = {};
      for (const id of ids) { const d = (b.desc && b.desc[id]) || []; desc[id] = [str(d[0], 400), str(d[1], 400)]; }
      const value = JSON.stringify({ ids, desc, updatedAt: new Date().toISOString() });
      await env.DB.prepare("INSERT INTO config(key, value) VALUES('highlights', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(value).run();
      return json({ ok: true });
    }
  }
  if (path === '/config/club' && m === 'PUT') {
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    const code = String((await body(req)).code || '').replace(/\D/g, '');
    if (code.length !== 4) return fail(400, 'invalid');
    await env.DB.prepare("INSERT INTO config(key, value) VALUES('club_code_hash', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(await sha256(SALT + code)).run();
    return json({ ok: true });
  }

  if (path === '/discord/interactions' && m === 'POST') return handleInteraction(req, env, ctx);
  if (path === '/admin/discord/register' && m === 'POST') {
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    try { return json({ ok: true, count: await registerCommands(env) }); } catch (e) { return fail(502, e.code || 'discord_error'); }
  }

  if (path === '/admin/check' && m === 'GET') return (await isAdmin(req, env, ip)) ? json({ ok: true }) : fail(403, 'forbidden');
  if (path === '/admin/geeklist' && m === 'GET') {
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'geeklist'").first();
    return json(row ? JSON.parse(row.value) : null);
  }
  if (path === '/admin/geeklist/refresh' && m === 'POST') {
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    try {
      const count = await refreshGeeklist(env);
      let added = 0, syncErr = null;
      try { added = await syncExtras(env); } catch (e) { syncErr = e.code || 'sync_error'; console.log('extras sync failed', e && e.message); }
      return json({ ok: true, count, added, syncErr });
    } catch (e) { return fail(502, e.code || 'bgg_error'); }
  }

  if (path === '/config/public' && m === 'GET') { const r = json({ discordUrl: env.DISCORD_URL || '' }); r.headers.set('cache-control', 'public, max-age=300'); return r; }
  if (path === '/games/extra' && m === 'GET') {
    const r = json({ games: await listExtras(env) }); r.headers.set('cache-control', 'public, max-age=300'); return r;
  }
  if ((g = path.match(/^\/cover\/(\d+)$/)) && m === 'GET') return coverResponse(env, ctx, +g[1]);

  if (path === '/bgg/search' && m === 'GET') {
    if (!(await allow(env, 'bgg:' + ip, 60, 60))) return fail(429, 'rate_limited');
    try { return json(await bggSearch(env, ctx, url.searchParams.get('q') || '')); }
    catch (e) { return fail(e.code === 'bgg_busy' ? 503 : 502, e.code || 'bgg_error'); }
  }
  return fail(404, 'not_found');
}

export default {
  async fetch(req, env, ctx) {
    try { return await route(req, env, ctx, new URL(req.url)); }
    catch (e) { return fail(e.status || 500, e.status ? e.message : 'server_error'); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await env.DB.prepare('DELETE FROM rate WHERE ts < ?1').bind(Date.now() - 864e5).run();
      try { await refreshGeeklist(env); await syncExtras(env); } catch (e) { console.log('geeklist refresh/sync failed', e.code || e.message); }
    })());
  },
};
