// Anmeldung auf der Webseite: „Mit Discord anmelden“ (OAuth2, nur Scope „identify“) oder einmalig mit dem /code-Code.
// Beides ergibt eine Sitzung (Token im Browser, in der Datenbank nur als Hash). Zugang hat nur, wer auf dem Discord-Server ist,
// den Bot-Kanal sehen kann und – falls DISCORD_ROLE_ID gesetzt ist – diese Rolle hat. Das wird alle 10 Minuten neu geprüft.
import { ensureCols, normCode, codeHash, channelIds } from './discord.js';
import { getBooking, isMember } from './booking.js';
import { dropOwner } from './membergames.js';

const enc = new TextEncoder();
const hexOf = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hexOf(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const randHex = (n) => hexOf(crypto.getRandomValues(new Uint8Array(n)));
const api = (env) => env.DISCORD_API_BASE || 'https://discord.com/api/v10';
const SESSION_DAYS = 180;
const RECHECK_MS = 600000;

let tablesOk = false;
export async function ensureAuth(env) {
  await ensureCols(env);
  if (tablesOk) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, discord_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, via TEXT)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS auth_handoff (nonce_hash TEXT PRIMARY KEY, token TEXT, error TEXT, created INTEGER NOT NULL)').run();
  tablesOk = true;
}

// ---- Zugangsprüfung über den Bot ----
const VIEW = 0x400n, ADMIN = 0x8n;
let cache = { at: 0, roles: null, chan: null };
async function bot(env, path) {
  const res = await fetch(api(env) + path, { headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error('discord ' + res.status), { code: 'discord_' + res.status });
  return res.json();
}
// Kann dieses Mitglied den (ersten) Bot-Kanal sehen? Discord-Rechte: Grundrechte der Rollen, dann Kanal-Überschreibungen.
function canView(env, member, roles, chan) {
  const g = env.DISCORD_GUILD_ID, mine = new Set([g, ...(member.roles || [])]);
  let p = 0n;
  for (const r of roles) if (mine.has(r.id)) p |= BigInt(r.permissions);
  if (p & ADMIN) return true;
  const ow = (chan && chan.permission_overwrites) || [];
  const apply = (o) => { if (o) { p &= ~BigInt(o.deny); p |= BigInt(o.allow); } };
  apply(ow.find((o) => o.id === g));
  let allow = 0n, deny = 0n;
  for (const o of ow) if (o.type === 0 && o.id !== g && mine.has(o.id)) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); }
  p &= ~deny; p |= allow;
  apply(ow.find((o) => o.type === 1 && o.id === (member.user && member.user.id)));
  return (p & VIEW) !== 0n;
}
// Gibt { ok, name, roles } oder { ok: false, err } zurück. err: not_member | no_role | no_channel
export async function checkAccess(env, discordId) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return { ok: true };
  const member = await bot(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${discordId}`);
  if (!member) return { ok: false, err: 'not_member' };
  if (env.DISCORD_ROLE_ID && !(member.roles || []).includes(env.DISCORD_ROLE_ID)) return { ok: false, err: 'no_role' };
  const ch = channelIds(env)[0];
  if (ch) {
    if (!cache.roles || Date.now() - cache.at > RECHECK_MS) cache = { at: Date.now(), roles: await bot(env, `/guilds/${env.DISCORD_GUILD_ID}/roles`), chan: await bot(env, `/channels/${ch}`) };
    if (cache.roles && !canView(env, member, cache.roles, cache.chan)) return { ok: false, err: 'no_channel' };
  }
  const u = member.user || {};
  return { ok: true, name: member.nick || u.global_name || u.username || '', roles: member.roles || [] };
}

// Mitglied (Tabelle members) prüfen, höchstens alle 10 Minuten bei Discord. Wer den Server verlässt, wird gelöscht (Code und Sitzungen weg).
export async function memberOk(env, m) {
  if (m.blocked) return 'blocked';
  // roles == null: Rollen noch nie gelesen (Einträge von vor der Mitgliederregel) -> gleich prüfen.
  if (Date.now() - m.checked_at < RECHECK_MS && m.roles != null) return null;
  let a;
  try { a = await checkAccess(env, m.discord_id); } catch (e) { console.log('access check failed', e.message); return null; } // Discord down: nicht aussperren
  if (!a.ok) {
    if (a.err === 'not_member') {
      await env.DB.prepare('DELETE FROM members WHERE discord_id = ?1').bind(m.discord_id).run(); await env.DB.prepare('DELETE FROM sessions WHERE discord_id = ?1').bind(m.discord_id).run();
      try { await dropOwner(env, m.discord_id); } catch (e) { /* Tabelle evtl. noch nicht angelegt */ }
    }
    return a.err;
  }
  const roles = a.roles ? JSON.stringify(a.roles) : m.roles || null;
  await env.DB.prepare('UPDATE members SET checked_at = ?1, name = coalesce(nullif(?2, \'\'), name), roles = ?3 WHERE discord_id = ?4').bind(Date.now(), (a.name || '').slice(0, 40), roles, m.discord_id).run();
  if (a.name) m.name = a.name.slice(0, 40);
  m.roles = roles;
  return null;
}

async function newSession(env, discordId, via) {
  const token = randHex(32);
  await env.DB.prepare('INSERT INTO sessions(token_hash, discord_id, created_at, expires_at, via) VALUES(?1, ?2, ?3, ?4, ?5)')
    .bind(await sha256('n3-sess:' + token), discordId, new Date().toISOString(), Date.now() + SESSION_DAYS * 864e5, via).run();
  return token;
}

// Wer schreibt? Sitzung (X-Session) oder – wie bisher – persönlicher Code (X-Member-Code). Gibt { member } oder { err } zurück.
export async function currentUser(req, env, allow, ip) {
  await ensureAuth(env);
  const tok = String(req.headers.get('x-session') || '');
  let m = null;
  if (tok) {
    if (!/^[0-9a-f]{64}$/.test(tok)) return { err: 'bad_session' };
    const s = await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ?1').bind(await sha256('n3-sess:' + tok)).first();
    if (!s || s.expires_at < Date.now()) return { err: 'bad_session' };
    m = await env.DB.prepare('SELECT * FROM members WHERE discord_id = ?1').bind(s.discord_id).first();
    if (!m) return { err: 'bad_session' };
  } else {
    const code = normCode(req.headers.get('x-member-code'));
    if (code.length !== 8) return { err: 'login_required' };
    if (!(await allow(env, 'code:' + ip, 15, 600))) return { err: 'rate_limited' };
    m = await env.DB.prepare('SELECT * FROM members WHERE code_hash = ?1').bind(await codeHash(code)).first();
    if (!m) return { err: 'bad_code' };
  }
  const err = await memberOk(env, m);
  return err ? { err } : { member: m };
}

const page = (env, url, msg, ok) => new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anmeldung</title>
<style>body{font:17px/1.5 system-ui,sans-serif;background:#1b1b1b;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center}a{color:#f09b19}</style></head>
<body><div><p>${msg}</p><p><a href="/#partys">Zur Spielesammlung</a></p></div>${ok ? '<script>setTimeout(function(){window.close()},600)</script>' : ''}</body></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

const ERR_TXT = {
  not_member: 'Du bist (noch) nicht auf unserem Discord-Server. Tritt ihm bei und versuche es dann noch einmal.',
  no_role: 'Dir fehlt auf dem Discord-Server die Brettspiel-Rolle. Hol sie dir dort und versuche es dann noch einmal.',
  no_channel: 'Du kannst den Brettspiel-Kanal auf dem Discord-Server nicht sehen. Hol dir die Brettspiel-Rolle und versuche es dann noch einmal.',
  blocked: 'Dein Zugang ist gesperrt.',
  failed: 'Die Anmeldung hat nicht geklappt. Bitte noch einmal versuchen.',
};

// Routen unter /api/auth/…; gibt null zurück, wenn der Pfad nicht passt.
export async function authRoute(req, env, url, path, m, ip, allow) {
  if (!path.startsWith('/auth/')) return null;
  const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  const fail = (s, code) => json({ error: code }, s);
  await ensureAuth(env);
  const base = (env.PUBLIC_URL || url.origin).replace(/\/$/, '');
  const redirect = base + '/api/auth/callback';

  if (path === '/auth/discord' && m === 'GET') {
    if (!env.DISCORD_CLIENT_SECRET || !env.DISCORD_APP_ID) return page(env, url, 'Die Discord-Anmeldung ist noch nicht eingerichtet.', false);
    const nonce = String(url.searchParams.get('n') || '');
    if (!/^[0-9a-f]{32}$/.test(nonce)) return page(env, url, ERR_TXT.failed, false);
    const state = randHex(16);
    const to = new URL(env.DISCORD_OAUTH_URL || 'https://discord.com/oauth2/authorize');
    to.search = new URLSearchParams({ client_id: env.DISCORD_APP_ID, response_type: 'code', scope: 'identify', redirect_uri: redirect, state, prompt: 'none' }).toString();
    return new Response(null, { status: 302, headers: { location: to.toString(), 'set-cookie': `n3auth=${state}.${nonce}; Path=/api/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`, 'cache-control': 'no-store' } });
  }

  if (path === '/auth/callback' && m === 'GET') {
    const ck = /(?:^|;\s*)n3auth=([0-9a-f]{32})\.([0-9a-f]{32})/.exec(req.headers.get('cookie') || '');
    const clear = 'n3auth=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
    const done = async (err, token) => {
      if (ck) await env.DB.prepare('INSERT INTO auth_handoff(nonce_hash, token, error, created) VALUES(?1, ?2, ?3, ?4) ON CONFLICT(nonce_hash) DO UPDATE SET token = excluded.token, error = excluded.error')
        .bind(await sha256(ck[2]), token || null, err || null, Date.now()).run();
      // Nicht auf dem Server: Einladungslink gleich mit anzeigen.
      const inv = err === 'not_member' && /^https:\/\/discord\.(gg|com)\//.test(env.DISCORD_URL || '') ? ` <a href="${env.DISCORD_URL}" target="_blank" rel="noopener">Zum Discord-Server</a>` : '';
      const r = page(env, url, err ? (ERR_TXT[err] || ERR_TXT.failed) + inv : 'Angemeldet ✓ Dieses Fenster schließt sich gleich, sonst bitte schließen.', !err);
      r.headers.set('set-cookie', clear);
      return r;
    };
    if (!ck || url.searchParams.get('state') !== ck[1]) return done('failed');
    if (url.searchParams.get('error') || !url.searchParams.get('code')) return done('failed');
    try {
      const tr = await fetch(api(env) + '/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.DISCORD_APP_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: redirect }) });
      if (!tr.ok) { console.log('oauth token', tr.status, (await tr.text()).slice(0, 200)); return done('failed'); }
      const at = (await tr.json()).access_token;
      const ur = await fetch(api(env) + '/users/@me', { headers: { Authorization: 'Bearer ' + at } });
      if (!ur.ok) return done('failed');
      const u = await ur.json();
      const a = await checkAccess(env, u.id);
      if (!a.ok) return done(a.err);
      const name = String(a.name || u.global_name || u.username || 'Spieler').slice(0, 40);
      const old = await env.DB.prepare('SELECT blocked FROM members WHERE discord_id = ?1').bind(u.id).first();
      if (old && old.blocked) return done('blocked');
      // Ohne /code gibt es keinen Code: Platzhalter-Hash, der zu keinem Code passt.
      await env.DB.prepare("INSERT INTO members(discord_id, name, code_hash, blocked, created_at, checked_at, roles) VALUES(?1, ?2, ?3, 0, ?4, ?5, ?6) ON CONFLICT(discord_id) DO UPDATE SET name = excluded.name, checked_at = excluded.checked_at, roles = excluded.roles")
        .bind(u.id, name, 'none:' + randHex(16), new Date().toISOString(), Date.now(), JSON.stringify(a.roles || [])).run();
      return done(null, await newSession(env, u.id, 'discord'));
    } catch (e) { console.log('oauth failed', e && e.message); return done('failed'); }
  }

  // Die Seite fragt nach, ob die Anmeldung im Popup fertig ist (funktioniert auch im iFrame, ohne Cookies von Drittseiten).
  if (path === '/auth/poll' && m === 'GET') {
    if (!(await allow(env, 'poll:' + ip, 300, 600))) return fail(429, 'rate_limited');
    const nonce = String(url.searchParams.get('n') || '');
    if (!/^[0-9a-f]{32}$/.test(nonce)) return fail(400, 'invalid');
    const h = await sha256(nonce);
    const row = await env.DB.prepare('SELECT * FROM auth_handoff WHERE nonce_hash = ?1 AND created > ?2').bind(h, Date.now() - 600000).first();
    if (!row) return json({ pending: true });
    await env.DB.prepare('DELETE FROM auth_handoff WHERE nonce_hash = ?1').bind(h).run();
    if (row.error) return fail(403, row.error);
    return json({ token: row.token });
  }

  // Einmal mit dem /code-Code anmelden -> Sitzung.
  if (path === '/auth/code' && m === 'POST') {
    const r = await currentUser(req, env, allow, ip);
    if (r.err) return fail(r.err === 'rate_limited' ? 429 : 403, r.err);
    return json({ token: await newSession(env, r.member.discord_id, 'code'), name: r.member.name });
  }

  if (path === '/auth/me' && m === 'GET') {
    const r = await currentUser(req, env, allow, ip);
    if (r.err) return fail(r.err === 'rate_limited' ? 429 : 401, r.err);
    return json({ name: r.member.name, member: isMember(await getBooking(env), r.member.roles) });
  }

  if (path === '/auth/logout' && m === 'POST') {
    const tok = String(req.headers.get('x-session') || '');
    if (/^[0-9a-f]{64}$/.test(tok)) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256('n3-sess:' + tok)).run();
    return json({ ok: true });
  }
  return fail(404, 'not_found');
}
