import { bggSearch, refreshGeeklist } from './bgg.js';
import { syncExtras, listExtras, coverResponse } from './games.js';
import { authRoute, currentUser } from './auth.js';
import { memberGamesRoute, backfillMemberGames } from './membergames.js';
import { getBooking, cleanBooking, isMember, checkBookingDate, nextStammtische, introOk, INTRO_MIN } from './booking.js';
import { handleInteraction, registerCommands, ensureCols, stillMember, normCode, codeHash, discordOn, announceParty, syncParty, cancelPartyMessage, berlinToday } from './discord.js';

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
  // Nur Fehlversuche zählen (20 pro 10 Minuten und IP); sonst bremst schon normales Arbeiten in der Verwaltung.
  const k = 'admfail:' + ip + ':' + Math.floor(Date.now() / 1000 / 600);
  const seen = await env.DB.prepare('SELECT n FROM rate WHERE k = ?1').bind(k).first();
  if (seen && seen.n >= 20) return false;
  if (safeEq(await sha256(t), await sha256(env.ADMIN_TOKEN))) return true;
  await allow(env, 'admfail:' + ip, 20, 600);
  return false;
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

// Angemeldet (Sitzung aus Discord-Login oder /code) oder persönlicher Code. Gibt { member } oder { err } zurück.
const checkMember = (req, env, ip) => currentUser(req, env, allow, ip);
const status = (err) => (err === 'rate_limited' ? 429 : 403);
// Eigene Einträge: Partien mit by_discord, Runden mit host_discord.
async function ownerOrAdmin(req, env, ip, ownerId) {
  if (req.headers.has('x-admin-token')) return (await isAdmin(req, env, ip)) ? { admin: true } : { err: 'forbidden' };
  const u = await checkMember(req, env, ip); if (u.err) return u;
  return ownerId && ownerId === u.member.discord_id ? { member: u.member } : { err: 'forbidden' };
}

// Club-Schlüssel aus dem QR-Code im Club: erlaubt Partien eintragen ohne Discord. Gibt null oder einen Fehlercode zurück.
async function checkLogKey(req, env, ip) {
  const key = String(req.headers.get('x-log-key') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const row = key.length >= 8 && key.length <= 32 ? await env.DB.prepare("SELECT value FROM config WHERE key = 'log_key'").first() : null;
  if (row && safeEq(key, row.value)) return null;
  // Nur Fehlversuche zählen: im Club teilen sich alle dieselbe IP (WLAN), der Schlüssel selbst hat ~60 Bit.
  return (await allow(env, 'keyfail:' + ip, 20, 600)) ? 'bad_key' : 'rate_limited';
}
const KEY_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newLogKey() {
  const r = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(r, (x) => KEY_CHARS[x % KEY_CHARS.length]).join('');
}
// Event-Code: erlaubt Runden ohne persönlichen Code (mit Namen), solange der Code gültig ist, und nur an den Eventtagen.
const normEventCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
const EV_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newEventCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => EV_CHARS[x % EV_CHARS.length]).join('');
const eventOut = (e) => ({ id: e.id, name: e.name, code: e.code, validUntil: e.valid_until, from: e.date_from, to: e.date_to, createdAt: e.created_at });
async function checkEvent(req, env, ip) {
  const code = normEventCode(req.headers.get('x-event-code'));
  await ensureCols(env);
  const e = code.length >= 4 ? await env.DB.prepare('SELECT * FROM events WHERE code = ?1').bind(code).first() : null;
  if (!e) return { err: (await allow(env, 'evfail:' + ip, 20, 600)) ? 'bad_event' : 'rate_limited' };
  if (e.valid_until < berlinToday()) return { err: 'event_expired' };
  return { event: e };
}
let playColsOk = false;
async function ensurePlayCols(env) {
  if (playColsOk) return;
  const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('plays')").all();
  const have = new Set(results.map((r) => r.name));
  if (!have.has('logged_by')) await env.DB.prepare('ALTER TABLE plays ADD COLUMN logged_by TEXT').run();
  if (!have.has('via')) await env.DB.prepare('ALTER TABLE plays ADD COLUMN via TEXT').run();
  if (!have.has('by_discord')) await env.DB.prepare('ALTER TABLE plays ADD COLUMN by_discord TEXT').run();
  playColsOk = true;
}

async function body(req) {
  const text = await req.text();
  if (text.length > 16000) throw Object.assign(new Error('too_large'), { status: 413 });
  try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('bad_json'), { status: 400 }); }
}

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
const NOTE_MAX = 500;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

const playOut = (r) => ({ id: r.id, gameId: r.game_id, game: r.game, guest: !!r.guest, year: r.year, date: r.date, players: r.players, winner: r.winner, note: r.note, duration: r.duration, firstPlay: !!r.first_play, loggedBy: r.logged_by || '', via: r.via || '', createdAt: r.created_at });
const partyOut = (r) => ({ id: r.id, gameId: r.game_id, game: r.game, guest: !!r.guest, year: r.year, date: r.date, time: r.time, seats: r.seats, host: r.host, note: r.note, attendees: JSON.parse(r.attendees || '{}'), playId: r.play_id, event: r.event_name || '', createdAt: r.created_at });

// Discord-Aktualisierungen laufen im Hintergrund; Fehler dürfen die Webseite nie stören.
const bg = (ctx, p) => ctx.waitUntil(p.catch((e) => console.log('discord sync failed', e && e.message)));

async function route(req, env, ctx, url) {
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const m = req.method;
  let g;

  const ar = await authRoute(req, env, url, path, m, ip, allow); if (ar) return ar;
  if (path.startsWith('/member-games')) { await ensureCols(env); return memberGamesRoute(req, env, ctx, path, m, ip, { json, fail, body, allow, checkMember, isAdmin }); }
  if (path === '/my' && m === 'GET') {
    // Eigene Partien und Runden (für die Bearbeiten-Knöpfe); ohne Anmeldung leer.
    if (!req.headers.has('x-session')) return json({ plays: [], parties: [] });
    const u = await checkMember(req, env, ip); if (u.err) return fail(u.err === 'rate_limited' ? 429 : 401, u.err);
    await ensurePlayCols(env);
    const p1 = await env.DB.prepare('SELECT id FROM plays WHERE by_discord = ?1 ORDER BY created_at DESC LIMIT 500').bind(u.member.discord_id).all();
    const p2 = await env.DB.prepare('SELECT id FROM parties WHERE host_discord = ?1 ORDER BY date DESC LIMIT 200').bind(u.member.discord_id).all();
    const member = isMember(await getBooking(env), u.member.roles);
    const p3 = await env.DB.prepare('SELECT id FROM member_games WHERE discord_id = ?1').bind(u.member.discord_id).all();
    return json({ name: u.member.name, member, plays: p1.results.map((r) => r.id), parties: p2.results.map((r) => r.id), memberGames: p3.results.map((r) => r.id) });
  }
  if (path === '/plays' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM plays ORDER BY created_at DESC LIMIT 500').all();
    return json(results.map(playOut));
  }
  if (path === '/plays' && m === 'POST') {
    // Zwei Wege: persönlicher Code (Discord) oder Club-Schlüssel aus dem QR-Code (dann ist ein Name Pflicht).
    const viaQr = req.headers.has('x-log-key');
    let by, byId = null;
    if (viaQr) {
      const err = await checkLogKey(req, env, ip); if (err) return fail(err === 'rate_limited' ? 429 : 403, err);
    } else {
      const auth = await checkMember(req, env, ip); if (auth.err) return fail(auth.err === 'rate_limited' ? 429 : 403, auth.err);
      by = auth.member.name; byId = auth.member.discord_id;
    }
    if (!(await allow(env, 'w:' + ip, 40, 600))) return fail(429, 'rate_limited');
    const b = await body(req);
    if (viaQr) {
      by = str(b.by, 40);
      if (!by) return fail(400, 'name_missing');
      // Spam-Bremse für den QR-Weg: 40 Partien pro Stunde und IP (Club-WLAN = eine IP für alle), 150 pro Tag insgesamt.
      if (!(await allow(env, 'qr:' + ip, 40, 3600)) || !(await allow(env, 'qrall', 150, 86400))) return fail(429, 'rate_limited');
    }
    await ensurePlayCols(env);
    const game = str(b.game, 120), date = str(b.date, 10), players = int(b.players), duration = b.duration == null ? null : int(b.duration);
    if (!game || !isDate(date) || !(players >= 1 && players <= 99)) return fail(400, 'invalid');
    if (duration != null && !(duration >= 1 && duration <= 1440)) return fail(400, 'invalid');
    const id = newId();
    await env.DB.prepare('INSERT INTO plays(id, game_id, game, guest, year, date, players, winner, note, duration, first_play, created_at, logged_by, via, by_discord) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)')
      .bind(id, int(b.gameId), game, b.guest ? 1 : 0, int(b.year), date, players, str(b.winner, 80), str(b.note, 200), duration, b.firstPlay ? 1 : 0, new Date().toISOString(), by, viaQr ? 'qr' : 'web', byId).run();
    if (b.partyId) { await env.DB.prepare('UPDATE parties SET play_id = ?1 WHERE id = ?2 AND play_id IS NULL').bind(id, str(b.partyId, 40)).run(); if (discordOn(env)) bg(ctx, ensureCols(env).then(() => syncParty(env, str(b.partyId, 40)))); }
    return json({ id });
  }
  if ((g = path.match(/^\/plays\/([\w-]+)$/)) && m === 'PUT') {
    // Verwaltung oder wer die Partie selbst eingetragen hat: korrigieren (Spiel bleibt, sonst stimmen Cover und Statistik-Zuordnung nicht mehr).
    await ensurePlayCols(env);
    const own = await env.DB.prepare('SELECT by_discord, logged_by FROM plays WHERE id = ?1').bind(g[1]).first();
    if (!own) return fail(404, 'not_found');
    const who = await ownerOrAdmin(req, env, ip, own.by_discord); if (who.err) return fail(status(who.err), who.err);
    const b = await body(req);
    if (!who.admin) b.loggedBy = own.logged_by;
    const date = str(b.date, 10), players = int(b.players), duration = b.duration == null || b.duration === '' ? null : int(b.duration);
    if (!isDate(date) || !(players >= 1 && players <= 99)) return fail(400, 'invalid');
    if (duration != null && !(duration >= 1 && duration <= 1440)) return fail(400, 'invalid');
    const r = await env.DB.prepare('UPDATE plays SET date = ?1, players = ?2, winner = ?3, note = ?4, duration = ?5, first_play = ?6, logged_by = ?7 WHERE id = ?8')
      .bind(date, players, str(b.winner, 80), str(b.note, 200), duration, b.firstPlay ? 1 : 0, str(b.loggedBy, 40) || null, g[1]).run();
    if (!r.meta.changes) return fail(404, 'not_found');
    return json({ ok: true });
  }
  if ((g = path.match(/^\/plays\/([\w-]+)$/)) && m === 'DELETE') {
    await ensurePlayCols(env);
    const own = await env.DB.prepare('SELECT by_discord FROM plays WHERE id = ?1').bind(g[1]).first();
    if (!own) return json({ ok: true });
    const who = await ownerOrAdmin(req, env, ip, own.by_discord); if (who.err) return fail(status(who.err), who.err);
    await env.DB.prepare('DELETE FROM plays WHERE id = ?1').bind(g[1]).run();
    return json({ ok: true });
  }

  if (path === '/parties' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM parties ORDER BY date DESC, time DESC LIMIT 200').all();
    return json(results.map(partyOut));
  }
  if (path === '/parties' && m === 'POST') {
    // Zwei Wege: persönlicher Code (Discord) oder Event-Code (dann ist ein Name Pflicht und nur Eventtage sind erlaubt).
    const viaEvent = req.headers.has('x-event-code');
    const auth = viaEvent ? await checkEvent(req, env, ip) : await checkMember(req, env, ip);
    if (auth.err) return fail(auth.err === 'rate_limited' ? 429 : 403, auth.err);
    if (!(await allow(env, 'w:' + ip, 40, 600))) return fail(429, 'rate_limited');
    const b = await body(req), ev = auth.event;
    const game = str(b.game, 120), date = str(b.date, 10), time = str(b.time, 5), seats = int(b.seats), host = ev ? str(b.host, 40) : auth.member.name, note = str(b.note, NOTE_MAX);
    if (ev && !host) return fail(400, 'name_missing');
    if (!game || !host || !isDate(date) || !(seats >= 2 && seats <= 30) || (time && !/^\d{2}:\d{2}$/.test(time))) return fail(400, 'invalid');
    if (ev && (date < ev.date_from || date > ev.date_to || date < berlinToday())) return fail(400, 'event_date');
    // Ohne Mitgliederrolle (und ohne Event-Code): nur Stammtisch-Tage, und der Hinweis muss eine kurze Vorstellung enthalten.
    if (!ev) {
      const rule = await getBooking(env);
      if (!isMember(rule, auth.member.roles)) {
        if (date < berlinToday()) return fail(400, 'invalid');
        const bad = checkBookingDate(rule, auth.member.roles, date); if (bad) return fail(400, bad);
        if (!introOk(note)) return fail(400, 'intro_missing');
      }
    }
    // Spam-Bremse für Event-Codes (der Code wird weitergegeben): höchstens 60 Runden pro Tag und Event.
    if (ev && !(await allow(env, 'ev:' + ev.id, 60, 86400))) return fail(429, 'rate_limited');
    await ensureCols(env);
    const id = newId(), hostKey = newId() + newId();
    await env.DB.prepare('INSERT INTO parties(id, game_id, game, guest, year, date, time, seats, host, host_key_hash, note, attendees, created_at, host_discord, event_id, event_name) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,\'{}\',?12,?13,?14,?15)')
      .bind(id, int(b.gameId), game, b.guest ? 1 : 0, int(b.year), date, time, seats, host, await sha256(hostKey), note, new Date().toISOString(), ev ? null : auth.member.discord_id, ev ? ev.id : null, ev ? ev.name : null).run();
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
  if ((g = path.match(/^\/parties\/([\w-]+)$/)) && m === 'PUT') {
    // Eigene Runde bearbeiten (wie „Bearbeiten“ in Discord): Spiel, Datum, Uhrzeit, Plätze, Hinweis.
    await ensureCols(env);
    const row = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(g[1]).first();
    if (!row) return fail(404, 'not_found');
    const who = await ownerOrAdmin(req, env, ip, row.host_discord); if (who.err) return fail(status(who.err), who.err);
    if (row.play_id) return fail(409, 'already_logged');
    const b = await body(req);
    const game = str(b.game, 120) || row.game, date = str(b.date, 10), time = str(b.time, 5), seats = int(b.seats);
    const taken = Object.values(JSON.parse(row.attendees || '{}')).filter((a) => !a.out).length + 1;
    if (!isDate(date) || !(seats >= 2 && seats <= 30) || (time && !/^\d{2}:\d{2}$/.test(time))) return fail(400, 'invalid');
    if (seats < taken) return fail(400, 'seats_taken');
    const note = str(b.note, NOTE_MAX);
    // Eigene Runde ohne Mitgliederrolle: ein neues Datum muss ein Stammtisch-Tag sein, die Vorstellung bleibt Pflicht.
    if (who.member && !row.event_id) {
      const rule = await getBooking(env);
      if (!isMember(rule, who.member.roles)) {
        if (date !== row.date) { if (date < berlinToday()) return fail(400, 'invalid'); const bad = checkBookingDate(rule, who.member.roles, date); if (bad) return fail(400, bad); }
        if (!introOk(note)) return fail(400, 'intro_missing');
      }
    }
    const same = game === row.game && (b.gameId == null || int(b.gameId) === row.game_id);
    await env.DB.prepare('UPDATE parties SET game = ?1, game_id = ?2, year = ?3, guest = ?4, date = ?5, time = ?6, seats = ?7, note = ?8 WHERE id = ?9')
      .bind(game, same ? row.game_id : int(b.gameId), same ? row.year : int(b.year), same ? row.guest : (b.guest ? 1 : 0), date, time, seats, note, g[1]).run();
    if (discordOn(env)) bg(ctx, syncParty(env, g[1]));
    return json({ ok: true });
  }
  if ((g = path.match(/^\/parties\/([\w-]+)$/)) && m === 'DELETE') {
    const row = await env.DB.prepare('SELECT host_key_hash FROM parties WHERE id = ?1').bind(g[1]).first();
    if (!row) return json({ ok: true });
    const hk = req.headers.get('x-host-key') || '';
    const okHost = hk && safeEq(await sha256(hk), row.host_key_hash);
    if (!okHost) { await ensureCols(env); const r2 = await env.DB.prepare('SELECT host_discord FROM parties WHERE id = ?1').bind(g[1]).first(); const who = await ownerOrAdmin(req, env, ip, r2 && r2.host_discord); if (who.err) return fail(status(who.err), who.err); }
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
  // Angaben je Spiel aus der Verwaltung: Sprache der Ausgabe, Sprachabhängigkeit (überschreibt BGG), Besitzer, Datum der Aufnahme, Inventarnummer, Zustand (1–6 wie in der Inventurliste).
  // Schlüssel wie in der Seite: BGG-ID, ggf. mit Zusatz wie „ (englisch, KS)“. Lesen öffentlich, Ändern nur Admin.
  if (path === '/config/gamemeta') {
    const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'gamemeta'").first();
    const map = row ? JSON.parse(row.value) : {};
    if (m === 'GET') return json(map);
    if (m === 'PUT') {
      if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
      const b = await body(req);
      const key = str(b.key, 60);
      if (!/^\d{1,9}( \([^()]{1,30}\))?$/.test(key)) return fail(400, 'invalid');
      const e = { l: ['de', 'en', 'fr'].filter((l) => Array.isArray(b.langs) && b.langs.includes(l)) };
      const ld = b.ld === null || b.ld === undefined || b.ld === '' ? null : int(b.ld);
      if (ld !== null && ld >= -1 && ld <= 4) e.ld = ld;
      const owner = str(b.owner, 60); if (owner) e.o = owner;
      const added = str(b.added, 10); if (added && !isDate(added)) return fail(400, 'invalid'); if (added) e.d = added;
      const inv = str(b.inv, 20); if (inv) e.inv = inv;
      const z = int(b.z); if (z !== null && z >= 1 && z <= 6) e.z = z;
      map[key] = e;
      await env.DB.prepare("INSERT INTO config(key, value) VALUES('gamemeta', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(map)).run();
      return json({ ok: true, key, meta: e });
    }
  }
  // Besitzer-Verzeichnis (Kurzname → vollständiger Name), nur für Admins lesbar, damit volle Namen nicht öffentlich sind.
  if (path === '/config/owners') {
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    if (m === 'GET') { const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'owners'").first(); return json(row ? JSON.parse(row.value) : {}); }
    if (m === 'PUT') {
      const b = await body(req), names = {};
      for (const [k, v] of Object.entries((b && b.names) || {}).slice(0, 100)) { const sk = str(k, 60), fv = str(v, 80); if (sk && fv) names[sk] = fv; }
      await env.DB.prepare("INSERT INTO config(key, value) VALUES('owners', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(names)).run();
      return json(names);
    }
  }
  // Runden-Regeln: Stammtisch-Tage (öffentlich, für den Kalender im Dialog) und Mitgliederrolle (nur Admin sieht die ID).
  if (path === '/booking' && m === 'GET') {
    const rule = await getBooking(env), today = berlinToday();
    const r = json({ memberRule: !!rule.memberRole, weekdays: rule.weekdays, monthly: rule.monthly, extra: rule.extra, skip: rule.skip, next: nextStammtische(today, rule, 6), today, introMin: INTRO_MIN, discordUrl: env.DISCORD_URL || '' });
    r.headers.set('cache-control', 'public, max-age=60'); return r;
  }
  if (path === '/admin/booking' && (m === 'GET' || m === 'PUT')) {
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    if (m === 'PUT') {
      const v = cleanBooking(await body(req));
      await env.DB.prepare("INSERT INTO config(key, value) VALUES('booking', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(v)).run();
    }
    const rule = await getBooking(env);
    return json({ ...rule, next: nextStammtische(berlinToday(), rule, 8) });
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

  if (path === '/admin/logkey' && (m === 'GET' || m === 'POST')) {
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    if (m === 'POST') {
      const key = newLogKey();
      await env.DB.prepare("INSERT INTO config(key, value) VALUES('log_key', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key).run();
      return json({ key });
    }
    const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'log_key'").first();
    return json({ key: row ? row.value : null });
  }
  if (path === '/admin/events' && m === 'GET') {
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    await ensureCols(env);
    const { results } = await env.DB.prepare('SELECT * FROM events ORDER BY date_from DESC, created_at DESC').all();
    return json(results.map(eventOut));
  }
  if (path === '/admin/events' && m === 'POST') {
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    const b = await body(req);
    const name = str(b.name, 60), from = str(b.from, 10), to = str(b.to, 10), until = str(b.validUntil, 10);
    let code = normEventCode(b.code);
    if (!name || !isDate(from) || !isDate(to) || !isDate(until) || to < from) return fail(400, 'invalid');
    if (b.code && code.length < 6) return fail(400, 'code_short');
    await ensureCols(env);
    if (!code) code = newEventCode();
    const id = newId();
    try {
      await env.DB.prepare('INSERT INTO events(id, name, code, valid_until, date_from, date_to, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(id, name, code, until, from, to, new Date().toISOString()).run();
    } catch (e) { if (/UNIQUE/i.test(String(e && e.message))) return fail(409, 'code_taken'); throw e; }
    return json(eventOut(await env.DB.prepare('SELECT * FROM events WHERE id = ?1').bind(id).first()));
  }
  if ((g = path.match(/^\/admin\/events\/([\w-]+)$/)) && m === 'DELETE') {
    if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden');
    await ensureCols(env);
    await env.DB.prepare('DELETE FROM events WHERE id = ?1').bind(g[1]).run();
    return json({ ok: true });
  }
  if (path === '/events/check' && m === 'GET') {
    const r = await checkEvent(req, env, ip);
    if (r.err) return fail(r.err === 'rate_limited' ? 429 : 403, r.err);
    const e = r.event; return json({ name: e.name, from: e.date_from, to: e.date_to, validUntil: e.valid_until, today: berlinToday() });
  }
  if (path === '/logkey/check' && m === 'GET') {
    const err = await checkLogKey(req, env, ip);
    return err ? fail(err === 'rate_limited' ? 429 : 403, err) : json({ ok: true });
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
  if ((g = path.match(/^\/cover\/(\d+)(-big)?(?:\.\w+)?$/)) && m === 'GET') {
    if (!(await allow(env, 'cover:' + ip, 120, 60))) return fail(429, 'rate_limited');
    return coverResponse(env, ctx, +g[1], !!g[2]);
  }

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
    catch (e) { if (!e.status) console.log('server_error', req.method, new URL(req.url).pathname, e && (e.stack || e.message)); return fail(e.status || 500, e.status ? e.message : 'server_error'); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await env.DB.prepare('DELETE FROM rate WHERE ts < ?1').bind(Date.now() - 864e5).run();
      try { await refreshGeeklist(env); await syncExtras(env); } catch (e) { console.log('geeklist refresh/sync failed', e.code || e.message); }
      try { await ensureCols(env); await backfillMemberGames(env); } catch (e) { console.log('member games backfill failed', e.code || e.message); }
    })());
  },
};
