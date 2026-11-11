// „Mitglieder besitzen“: Mitglieder tragen eigene Spiele ein (Besitzer = ihr Discord-Server-Name, nur mit Zustimmung).
// Andere Mitglieder können sie bitten, ein Spiel an bis zu 3 Terminen mitzubringen. Die Anfrage landet im Bot-Kanal
// mit Erwähnung des Besitzers; er nimmt einen Termin an (Uhrzeit und Plätze im Fenster) oder lehnt ab.
// Annehmen legt automatisch eine Spielrunde an, in der beide schon stehen.
import { discord, view, headline, channelIds, discordOn, fmtDate, wdName, who, say, reply, berlinToday } from './discord.js';
import { fetchThings } from './games.js';
import { fetchCollection } from './bgg.js';
import { getBooking, isMember } from './booking.js';
import { checkAccess } from './auth.js';

const enc = new TextEncoder();
const sha256 = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))), (x) => x.toString(16).padStart(2, '0')).join('');
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayTxt = (iso) => `${wdName(iso)}, ${fmtDate(iso)}`;
const shortDay = (iso) => `${wdName(iso)} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
const MAX_GAMES = 1000;
const MAX_DATES = 3;
const MAX_OWNERS = 10;

export const memberGameOut = (r) => ({ id: r.id, gameId: r.game_id, game: r.game, year: r.year, note: r.note, owner: r.owner_name || '?', data: r.data ? JSON.parse(r.data) : null, createdAt: r.created_at });

// Öffentliche Liste: nur Spiele von Personen, die noch Mitglied sind (Rolle laut Verwaltung).
export async function listMemberGames(env) {
  const rule = await getBooking(env);
  const { results } = await env.DB.prepare('SELECT g.*, m.name AS owner_name, m.roles AS owner_roles FROM member_games g JOIN members m ON m.discord_id = g.discord_id WHERE m.blocked = 0 ORDER BY g.game COLLATE NOCASE').all();
  return results.filter((r) => isMember(rule, r.owner_roles)).map(memberGameOut);
}

// Spieldaten von BGG für Filter und Karte (Spielerzahl, Dauer, Komplexität …); ohne BGG bleibt es beim Namen.
async function bggData(env, id) {
  if (!id || !env.BGG_TOKEN) return null;
  try {
    const g = (await Promise.race([fetchThings(env, [id], 2), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]))[0];
    if (!g) return null;
    const { thumb, img, ...data } = g; return data;
  } catch { return null; }
}

// Routen /member-games…; gibt null zurück, wenn der Pfad nicht passt. h = Hilfsfunktionen aus index.js.
export async function memberGamesRoute(req, env, ctx, path, m, ip, h) {
  if (!path.startsWith('/member-games')) return null;
  const { json, fail, body, allow, checkMember, isAdmin, checkEvent } = h;
  let g;
  const needMember = async () => {
    const u = await checkMember(req, env, ip);
    if (u.err) return { res: fail(u.err === 'rate_limited' ? 429 : 403, u.err) };
    if (!isMember(await getBooking(env), u.member.roles)) return { res: fail(403, 'members_only') };
    return { member: u.member };
  };

  if (path === '/member-games' && m === 'GET') {
    const r = json(await listMemberGames(env)); r.headers.set('cache-control', 'public, max-age=30'); return r;
  }
  if (path === '/member-games' && m === 'POST') {
    const a = await needMember(); if (a.res) return a.res;
    if (!(await allow(env, 'mg:' + a.member.discord_id, 30, 3600))) return fail(429, 'rate_limited');
    const b = await body(req);
    if (b.consent !== true) return fail(400, 'consent_missing');
    const game = str(b.game, 120), gameId = int(b.gameId);
    if (!game || (gameId != null && !(gameId > 0))) return fail(400, 'invalid');
    const cnt = await env.DB.prepare('SELECT count(*) AS n FROM member_games WHERE discord_id = ?1').bind(a.member.discord_id).first();
    if (cnt.n >= MAX_GAMES) return fail(400, 'too_many');
    const dup = gameId
      ? await env.DB.prepare('SELECT id FROM member_games WHERE discord_id = ?1 AND game_id = ?2').bind(a.member.discord_id, gameId).first()
      : await env.DB.prepare('SELECT id FROM member_games WHERE discord_id = ?1 AND game_id IS NULL AND lower(game) = lower(?2)').bind(a.member.discord_id, game).first();
    if (dup) return fail(409, 'already_added');
    const id = newId(), now = new Date().toISOString();
    const data = await bggData(env, gameId);
    await env.DB.prepare('INSERT INTO member_games(id, discord_id, game_id, game, year, note, data, consent_at, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)')
      .bind(id, a.member.discord_id, gameId, game, int(b.year), str(b.note, 120), data ? JSON.stringify(data) : null, now).run();
    return json({ id });
  }
  // BGG-Sammlung lesen (Vorschau): der Nutzer wählt danach aus, was übernommen wird.
  if (path === '/member-games/bgg' && m === 'GET') {
    const a = await needMember(); if (a.res) return a.res;
    const user = str(new URL(req.url).searchParams.get('user'), 60);
    if (!/^[\w .-]{2,60}$/.test(user)) return fail(400, 'invalid');
    if (!(await allow(env, 'bggcol:' + a.member.discord_id, 10, 3600))) return fail(429, 'rate_limited');
    let items;
    try { items = await fetchCollection(env, user); }
    catch (e) { return fail(e.code === 'bgg_no_user' ? 404 : e.code === 'bgg_busy' ? 503 : 502, e.code || 'bgg_error'); }
    const rows = (await env.DB.prepare('SELECT id, game_id, game, year, src FROM member_games WHERE discord_id = ?1 AND game_id IS NOT NULL').bind(a.member.discord_id).all()).results;
    await env.DB.prepare('UPDATE members SET bgg_user = ?1 WHERE discord_id = ?2').bind(user, a.member.discord_id).run();
    // Abgleich: eingetragene Spiele, die nicht (mehr) in der BGG-Sammlung sind. Importierte sind vorausgewählt, von Hand eingetragene nicht.
    const inCol = new Set(items.map((x) => x.id));
    const gone = rows.filter((r) => !inCol.has(r.game_id)).map((r) => ({ id: r.id, n: r.game, y: r.year, bgg: r.src === 'bgg' }));
    return json({ items: items.slice(0, 1000), have: rows.map((r) => r.game_id), gone });
  }
  // Ausgewählte Spiele aus der BGG-Sammlung übernehmen (mit Zustimmung wie beim Einzeleintrag).
  if (path === '/member-games/import' && m === 'POST') {
    const a = await needMember(); if (a.res) return a.res;
    if (!(await allow(env, 'mgimp:' + a.member.discord_id, 10, 3600))) return fail(429, 'rate_limited');
    const b = await body(req, 400000);
    // Abgleich: nicht mehr vorhandene Spiele entfernen (nur eigene).
    const remove = (Array.isArray(b.remove) ? b.remove : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 1000);
    let removed = 0;
    for (let i = 0; i < remove.length; i += 50) {
      const part = remove.slice(i, i + 50);
      const r = await env.DB.prepare('DELETE FROM member_games WHERE discord_id = ?1 AND id IN (' + part.map((_, j) => '?' + (j + 2)).join(',') + ')').bind(a.member.discord_id, ...part).run();
      removed += (r.meta && r.meta.changes) || 0;
    }
    if (!(Array.isArray(b.items) && b.items.length)) return json({ added: 0, skipped: 0, removed });
    if (b.consent !== true) return fail(400, 'consent_missing');
    const want = (Array.isArray(b.items) ? b.items : []).map((x) => ({ id: int(x && x.id), n: str(x && x.n, 120), y: int(x && x.y) })).filter((x) => x.id > 0 && x.n);
    const have = new Set((await env.DB.prepare('SELECT game_id FROM member_games WHERE discord_id = ?1').bind(a.member.discord_id).all()).results.map((r) => r.game_id));
    const room = MAX_GAMES - have.size;
    const add = [...new Map(want.filter((x) => !have.has(x.id)).map((x) => [x.id, x])).values()].slice(0, Math.max(0, room));
    if (!add.length) return json({ added: 0, skipped: want.length, removed });
    // Spieldaten in Blöcken zu 20 holen (höchstens 5 Blöcke, Rest ohne Daten; BGG antwortet manchmal nicht).
    const data = new Map();
    if (env.BGG_TOKEN) for (let i = 0; i < add.length && i < 100; i += 20) {
      try {
        const got = await Promise.race([fetchThings(env, add.slice(i, i + 20).map((x) => x.id), 2), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
        for (const t of got) { const { thumb, img, ...d } = t; data.set(t.id, d); }
      } catch { break; }
    }
    const now = new Date().toISOString();
    await env.DB.batch(add.map((x) => env.DB.prepare('INSERT INTO member_games(id, discord_id, game_id, game, year, note, data, consent_at, created_at, src) VALUES(?1,?2,?3,?4,?5,\'\',?6,?7,?7,\'bgg\')')
      .bind(newId(), a.member.discord_id, x.id, x.n, x.y, data.has(x.id) ? JSON.stringify(data.get(x.id)) : null, now)));
    return json({ added: add.length, skipped: want.length - add.length, removed });
  }
  if ((g = path.match(/^\/member-games\/([\w-]+)$/)) && m === 'DELETE') {
    const row = await env.DB.prepare('SELECT discord_id FROM member_games WHERE id = ?1').bind(g[1]).first();
    if (!row) return json({ ok: true });
    if (req.headers.has('x-admin-token')) { if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden'); }
    else { const u = await checkMember(req, env, ip); if (u.err) return fail(u.err === 'rate_limited' ? 429 : 403, u.err); if (u.member.discord_id !== row.discord_id) return fail(403, 'forbidden'); }
    await env.DB.prepare('DELETE FROM member_games WHERE id = ?1').bind(g[1]).run();
    return json({ ok: true });
  }
  if ((g = path.match(/^\/member-games\/([\w-]+)\/request$/)) && m === 'POST') {
    // Mitglieder fragen jederzeit an; ohne Mitgliederrolle nur mit gültigem Event-Code und nur für die Eventtage.
    const u = await checkMember(req, env, ip); if (u.err) return fail(u.err === 'rate_limited' ? 429 : 403, u.err);
    const a = { member: u.member }, b = await body(req), today = berlinToday();
    let ev = null;
    if (!isMember(await getBooking(env), u.member.roles)) {
      if (!b.eventCode) return fail(403, 'members_only');
      const e = await checkEvent(req, env, ip, String(b.eventCode)); if (e.err) return fail(e.err === 'rate_limited' ? 429 : 403, e.err);
      ev = e.event;
    }
    if (!discordOn(env)) return fail(503, 'discord_off');
    const mg = await env.DB.prepare('SELECT g.*, m.name AS owner_name FROM member_games g JOIN members m ON m.discord_id = g.discord_id WHERE g.id = ?1').bind(g[1]).first();
    if (!mg) return fail(404, 'not_found');
    // Dasselbe Spiel bei mehreren Mitgliedern: alle Besitzer (außer der anfragenden Person) bekommen die Anfrage.
    const rule = await getBooking(env);
    const sib = (mg.game_id
      ? await env.DB.prepare('SELECT g.id, g.discord_id, m.name, m.roles FROM member_games g JOIN members m ON m.discord_id = g.discord_id WHERE m.blocked = 0 AND g.game_id = ?1 ORDER BY g.created_at').bind(mg.game_id).all()
      : await env.DB.prepare('SELECT g.id, g.discord_id, m.name, m.roles FROM member_games g JOIN members m ON m.discord_id = g.discord_id WHERE m.blocked = 0 AND g.game_id IS NULL AND lower(g.game) = lower(?1) ORDER BY g.created_at').bind(mg.game).all()).results;
    let owners = [...new Map(sib.filter((o) => o.discord_id !== a.member.discord_id && (o.id === mg.id || isMember(rule, o.roles))).map((o) => [o.discord_id, { id: o.discord_id, name: o.name || '?', mg: o.id }])).values()].slice(0, MAX_OWNERS);
    if (!owners.length) return fail(400, mg.discord_id === a.member.discord_id ? 'own_game' : 'not_found');
    const dates = [...new Set((Array.isArray(b.dates) ? b.dates : []).map((d) => str(d, 10)))].sort();
    if (!dates.length || dates.length > MAX_DATES || dates.some((d) => !isDate(d) || d < today || d > addDays(today, 365))) return fail(400, 'bad_dates');
    if (ev && dates.some((d) => d < ev.date_from || d > ev.date_to)) return fail(400, 'event_date');
    const sibIds = sib.map((o) => o.id).slice(0, 90);
    const open = await env.DB.prepare("SELECT id FROM bring_requests WHERE req_discord = ?1 AND status = 'open' AND mgame_id IN (" + sibIds.map((_, j) => '?' + (j + 2)).join(',') + ')').bind(a.member.discord_id, ...sibIds).first();
    if (open) return fail(409, 'already_requested');
    // Spam-Bremse: 5 Anfragen pro Tag und Person, 30 pro Tag insgesamt.
    if (!(await allow(env, 'breq:' + a.member.discord_id, 5, 86400)) || !(await allow(env, 'breq-all', 30, 86400))) return fail(429, 'rate_limited');
    // Ist der Besitzer noch auf dem Server? Sonst verschwinden seine Spiele.
    const gone = [];
    for (const o of owners) {
      try {
        const acc = await checkAccess(env, o.id);
        if (!acc.ok && acc.err === 'not_member') { await dropOwner(env, o.id); gone.push(o.id); }
      } catch { break; /* Discord gerade nicht erreichbar: trotzdem versuchen */ }
    }
    owners = owners.filter((o) => !gone.includes(o.id));
    if (!owners.length) return fail(410, 'owner_gone');
    const d = mg.data ? JSON.parse(mg.data) : null;
    const seats = d && d.p2 ? Math.min(30, Math.max(2, d.p2)) : 4;
    const id = newId();
    const row = { id, mgame_id: owners[0].mg, owner_discord: owners[0].id, owner_name: owners.map((o) => o.name).join(', ').slice(0, 200), owners: JSON.stringify(owners), req_discord: a.member.discord_id, req_name: a.member.name, game: mg.game, game_id: mg.game_id, year: mg.year, seats, dates: JSON.stringify(dates), note: (ev ? `Event „${ev.name}“` + (str(b.note, 300) ? ' · ' : '') : '') + str(b.note, 300), status: 'open', created_at: new Date().toISOString() };
    await env.DB.prepare('INSERT INTO bring_requests(id, mgame_id, owner_discord, owner_name, owners, req_discord, req_name, game, game_id, year, seats, dates, note, status, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)')
      .bind(row.id, row.mgame_id, row.owner_discord, row.owner_name, row.owners, row.req_discord, row.req_name, row.game, row.game_id, row.year, row.seats, row.dates, row.note, row.status, row.created_at).run();
    const ch = channelIds(env)[0];
    try {
      const msg = await discord(env, 'POST', `/channels/${ch}/messages`, requestMessage(row, env));
      await env.DB.prepare('UPDATE bring_requests SET discord_channel = ?1, discord_msg = ?2 WHERE id = ?3').bind(ch, msg.id, id).run();
    } catch (e) {
      console.log('bring request post failed', e && e.message);
      await env.DB.prepare('DELETE FROM bring_requests WHERE id = ?1').bind(id).run();
      return fail(502, 'discord_error');
    }
    return json({ id, owners: owners.length });
  }
  return fail(404, 'not_found');
}

// ---- Discord-Nachricht zur Anfrage ----
function gameEmbed(r, env, extra = {}) {
  const e = { title: '🎲 ' + r.game + (r.year ? ` (${r.year})` : ''), color: 0x7b5cc4, ...extra };
  if (r.game_id) {
    e.url = 'https://boardgamegeek.com/boardgame/' + r.game_id;
    if (env.PUBLIC_URL) e.thumbnail = { url: `${env.PUBLIC_URL.replace(/\/$/, '')}/api/cover/${r.game_id}.jpg` };
  }
  return e;
}
// Besitzer einer Anfrage (ältere Anfragen haben nur einen) und wer davon schon abgelehnt hat.
export const ownersOf = (r) => { try { const o = JSON.parse(r.owners || 'null'); if (Array.isArray(o) && o.length) return o; } catch {} return [{ id: r.owner_discord, name: r.owner_name, mg: r.mgame_id }]; };
const declinedOf = (r) => { try { return JSON.parse(r.declined || '[]'); } catch { return []; } };
const stillAsked = (r) => { const no = declinedOf(r); return ownersOf(r).filter((o) => !no.includes(o.id)); };
export function requestMessage(r, env) {
  const dates = JSON.parse(r.dates), all = ownersOf(r), asked = stillAsked(r), no = all.filter((o) => !asked.includes(o));
  const fields = [{ name: '📅 Vorgeschlagene Termine', value: dates.map(dayTxt).join('\n') }];
  if (r.note) fields.push({ name: '💬 Nachricht', value: r.note.slice(0, 300) });
  if (no.length) fields.push({ name: '🚫 Kann nicht', value: no.map((o) => o.name).join(', ').slice(0, 300) });
  const multi = all.length > 1;
  const content = multi
    ? `${asked.map((o) => `<@${o.id}>`).join(' ')} **${r.req_name}** (<@${r.req_discord}>) fragt, ob jemand von euch **${r.game}** mitbringen kann. Das Spiel haben mehrere Mitglieder (${all.map((o) => o.name).join(', ')}), deshalb geht die Anfrage an alle. Wer zuerst einen Termin annimmt, bringt es mit, danach ist die Anfrage für die anderen geschlossen. Uhrzeit und Plätze legst du nach dem Annehmen fest.`
    : `<@${r.owner_discord}> **${r.req_name}** (<@${r.req_discord}>) fragt, ob du **${r.game}** mitbringen kannst. Magst du einen der Termine annehmen? Uhrzeit und Plätze legst du danach fest.`;
  return {
    content: content.slice(0, 1900),
    embeds: [gameEmbed(r, env, { fields, footer: { text: multi ? 'Nur die Besitzer können annehmen oder ablehnen. Nur eine Person kann annehmen.' : 'Nur der Besitzer kann annehmen oder ablehnen.' } })],
    components: [{ type: 1, components: [
      ...dates.map((d, i) => ({ type: 2, style: 3, label: 'Annehmen: ' + shortDay(d), custom_id: `bringa:${r.id}:${i}` })),
      { type: 2, style: 4, label: 'Ablehnen', custom_id: 'bringd:' + r.id },
      { type: 2, style: 2, label: 'Zurückziehen', custom_id: 'bringx:' + r.id },
    ] }],
    allowed_mentions: { users: asked.map((o) => o.id).slice(0, 100) },
  };
}
const dmLinks = (r) => [{ type: 1, components: [
  ...ownersOf(r).slice(0, 4).map((o) => ({ type: 2, style: 5, label: 'Nachricht an ' + o.name.slice(0, 60), url: 'https://discord.com/users/' + o.id })),
  { type: 2, style: 5, label: 'Nachricht an ' + r.req_name.slice(0, 60), url: 'https://discord.com/users/' + r.req_discord },
] }];
const mentionAll = (r) => ownersOf(r).map((o) => `<@${o.id}>`).join(' ');

const getReq = (env, id) => env.DB.prepare('SELECT * FROM bring_requests WHERE id = ?1').bind(id).first();
const closed = (r) => (r.status === 'accepted' ? `Diese Anfrage wurde schon angenommen (${r.owner_name} bringt das Spiel mit).` : r.status === 'declined' ? 'Diese Anfrage wurde schon abgelehnt.' : r.status === 'cancelled' ? 'Diese Anfrage gilt nicht mehr (Mitglied nicht mehr auf dem Server oder ohne Mitgliederrolle).' : 'Diese Anfrage wurde zurückgezogen.');

export async function bringButton(i, env, ctx) {
  const [act, id, idx] = String(i.data.custom_id).split(':');
  const w = who(i), r = await getReq(env, id);
  if (!r) return say('Diese Anfrage gibt es nicht mehr.');
  if (r.status !== 'open') return say(closed(r));
  if (act === 'bringx') {
    if (w.id !== r.req_discord) return say('Nur wer angefragt hat, kann die Anfrage zurückziehen.');
    const u = await env.DB.prepare("UPDATE bring_requests SET status = 'withdrawn' WHERE id = ?1 AND status = 'open'").bind(id).run();
    if (!u.meta.changes) return say('Die Anfrage ist schon erledigt.');
    return reply({ type: 7, data: { content: `~~${r.req_name} hat gefragt, ob ${r.owner_name} **${r.game}** mitbringt.~~ Zurückgezogen.`, embeds: [], components: [], allowed_mentions: { parse: [] } } });
  }
  if (!ownersOf(r).some((o) => o.id === w.id)) return say(`Nur ${mentionAll(r)} ${ownersOf(r).length > 1 ? 'können' : 'kann'} diese Anfrage annehmen oder ablehnen.`);
  if (declinedOf(r).includes(w.id)) return say('Du hast diese Anfrage schon abgelehnt.');
  if (act === 'bringa') {
    const date = JSON.parse(r.dates)[Number(idx)];
    if (!date) return say('Diesen Termin gibt es nicht.');
    if (date < berlinToday()) return say('Dieser Termin liegt schon in der Vergangenheit.');
    const row = (custom_id, label, value, extra = {}) => ({ type: 1, components: [{ type: 4, custom_id, label, style: 1, value: String(value), required: true, ...extra }] });
    return reply({ type: 9, data: { custom_id: `bringa:${id}:${idx}`, title: ('Runde am ' + shortDay(date)).slice(0, 45), components: [
      row('uhrzeit', 'Uhrzeit (HH:MM)', '18:00', { min_length: 5, max_length: 5 }),
      row('plaetze', 'Plätze inkl. dir (2–30)', r.seats || 4, { max_length: 2 }),
    ] } });
  }
  if (act === 'bringd') {
    return reply({ type: 9, data: { custom_id: 'bringd:' + id, title: 'Anfrage ablehnen', components: [
      { type: 1, components: [{ type: 4, custom_id: 'grund', label: ('Nachricht an ' + r.req_name).slice(0, 45), style: 2, required: false, max_length: 300, placeholder: 'z. B. anderer Terminvorschlag (optional)' }] },
    ] } });
  }
  return say('Unbekannte Aktion.');
}

export async function bringSubmit(i, env, ctx) {
  const [act, id, idx] = String(i.data.custom_id).split(':');
  const w = who(i), r = await getReq(env, id);
  if (!r) return say('Diese Anfrage gibt es nicht mehr.');
  if (!ownersOf(r).some((o) => o.id === w.id)) return say(`Nur ${mentionAll(r)} ${ownersOf(r).length > 1 ? 'können' : 'kann'} diese Anfrage beantworten.`);
  if (r.status !== 'open') return say(closed(r));
  if (declinedOf(r).includes(w.id)) return say('Du hast diese Anfrage schon abgelehnt.');
  const multi = ownersOf(r).length > 1, me = ownersOf(r).find((o) => o.id === w.id);
  const f = {};
  for (const row of i.data.components || []) for (const c of row.components || []) f[c.custom_id] = c.value;

  if (act === 'bringd') {
    const why = str(f.grund, 300);
    const declined = [...declinedOf(r), w.id];
    const left = ownersOf(r).filter((o) => !declined.includes(o.id));
    if (left.length) {
      // Mehrere Besitzer: nur diese Person fällt weg, die anderen können weiter annehmen.
      const u = await env.DB.prepare("UPDATE bring_requests SET declined = ?1 WHERE id = ?2 AND status = 'open' AND coalesce(declined, '') = ?3").bind(JSON.stringify(declined), id, r.declined || '').run();
      if (!u.meta.changes) return say('Die Anfrage hat sich gerade geändert. Bitte noch einmal versuchen.');
      const nr = { ...r, declined: JSON.stringify(declined) };
      if (r.discord_channel && r.discord_msg) ctx.waitUntil(discord(env, 'POST', `/channels/${r.discord_channel}/messages`, {
        content: `<@${r.req_discord}> ${me.name} kann **${r.game}** nicht mitbringen` + (why ? `: „${why}“` : '.') + ` ${left.map((o) => o.name).join(', ')} ${left.length > 1 ? 'können' : 'kann'} die Anfrage noch annehmen.`,
        message_reference: { message_id: r.discord_msg, fail_if_not_exists: false }, allowed_mentions: { users: [r.req_discord] },
      }).catch((e) => console.log('bring decline reply failed', e && e.message)));
      const v = requestMessage(nr, env);
      return reply({ type: 7, data: { ...v, allowed_mentions: { parse: [] } } });
    }
    const u = await env.DB.prepare("UPDATE bring_requests SET status = 'declined', answer = ?1, declined = ?2 WHERE id = ?3 AND status = 'open'").bind(why, JSON.stringify(declined), id).run();
    if (!u.meta.changes) return say('Die Anfrage ist schon erledigt.');
    const text = (multi ? `❌ Keiner der Besitzer (${ownersOf(r).map((o) => o.name).join(', ')}) kann **${r.game}** an den vorgeschlagenen Terminen mitbringen.` : `❌ **${r.owner_name}** kann **${r.game}** an den vorgeschlagenen Terminen leider nicht mitbringen.`) + (why ? `\n💬 „${why}“` : '') + '\nSchreibt euch am besten direkt, um etwas anderes auszumachen.';
    // Bearbeitete Nachrichten benachrichtigen niemanden: deshalb eine kurze Antwort mit Erwähnung der anfragenden Person.
    if (r.discord_channel && r.discord_msg) ctx.waitUntil(discord(env, 'POST', `/channels/${r.discord_channel}/messages`, {
      content: multi ? `<@${r.req_discord}> Leider kann keiner der Besitzer **${r.game}** an deinen Terminen mitbringen` + (why ? ` (${me.name}: „${why}“)` : '.') + ` Schreib ${mentionAll(r)} gern direkt an.`
        : `<@${r.req_discord}> ${r.owner_name} hat deine Anfrage zu **${r.game}** abgelehnt` + (why ? `: „${why}“` : '.') + ` Schreib <@${r.owner_discord}> gern direkt an.`,
      message_reference: { message_id: r.discord_msg, fail_if_not_exists: false }, allowed_mentions: { users: [r.req_discord] },
    }).catch((e) => console.log('bring decline reply failed', e && e.message)));
    return reply({ type: 7, data: { content: text, embeds: [gameEmbed(r, env)], components: dmLinks(r), allowed_mentions: { parse: [] } } });
  }

  if (act === 'bringa') {
    const date = JSON.parse(r.dates)[Number(idx)];
    if (!date) return say('Diesen Termin gibt es nicht.');
    if (date < berlinToday()) return say('Dieser Termin liegt schon in der Vergangenheit.');
    const time = str(f.uhrzeit, 5); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return say('Uhrzeit bitte als HH:MM, z. B. 18:00. Klick noch einmal auf „Annehmen“.');
    const seats = Number(f.plaetze); if (!(seats >= 2 && seats <= 30)) return say('Plätze: 2 bis 30 (inkl. dir). Klick noch einmal auf „Annehmen“.');
    const pid = newId();
    // Nur eine Person kann annehmen: die erste gewinnt, alle anderen sehen danach „schon angenommen“.
    const u = await env.DB.prepare("UPDATE bring_requests SET status = 'accepted', chosen_date = ?1, party_id = ?2, owner_discord = ?3, owner_name = ?4, mgame_id = ?5 WHERE id = ?6 AND status = 'open'").bind(date, pid, w.id, me.name, me.mg || r.mgame_id, id).run();
    if (!u.meta.changes) return say((await getReq(env, id)).status === 'accepted' ? 'Zu spät: jemand anderes hat diese Anfrage schon angenommen.' : 'Die Anfrage ist schon erledigt.');
    const att = { ['d' + r.req_discord]: { name: r.req_name, at: new Date().toISOString() } };
    const note = `${w.name} bringt das Spiel mit (auf Wunsch von ${r.req_name}).`;
    await env.DB.prepare('INSERT INTO parties(id, game_id, game, guest, year, date, time, seats, host, host_key_hash, note, attendees, created_at, host_discord, bring_id) VALUES(?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)')
      .bind(pid, r.game_id, r.game, r.year, date, time, seats, w.name, await sha256('discord:' + w.id), note, JSON.stringify(att), new Date().toISOString(), w.id, r.id).run();
    // Runde als eigene Nachricht im Kanal (wie /party), mit Erwähnung der anfragenden Person.
    const ch = r.discord_channel || i.channel_id || channelIds(env)[0];
    ctx.waitUntil((async () => {
      const party = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(pid).first();
      const v = view(party, env);
      const msg = await discord(env, 'POST', `/channels/${ch}/messages`, { ...v, content: headline(party) + `\n🙌 <@${r.req_discord}>, ${w.name} bringt **${r.game}** mit – du bist schon dabei.`, allowed_mentions: { users: [r.req_discord] } });
      await env.DB.prepare('UPDATE parties SET discord_channel = ?1, discord_msg = ?2 WHERE id = ?3').bind(ch, msg.id, pid).run();
    })().catch((e) => console.log('bring party announce failed', e && e.message)));
    return reply({ type: 7, data: {
      content: `✅ **${w.name}** bringt **${r.game}** am ${dayTxt(date)} um ${time} Uhr mit. Die Runde ist angelegt, ${r.req_name} ist schon dabei. Uhrzeit und Plätze kannst du später über „Verwalten“ an der Runde ändern.` + (multi ? ' Die Anfrage ist damit für die anderen Besitzer geschlossen.' : ''),
      embeds: [gameEmbed(r, env)], components: [], allowed_mentions: { parse: [] },
    } });
  }
  return say('Unbekannte Aktion.');
}

// Nachts: Spieldaten für bis zu 20 Mitgliederspiele ohne Daten nachladen (z. B. nach einem großen BGG-Import).
// Spiele (und offene Anfragen) eines Mitglieds entfernen, das den Server verlassen oder die Mitgliederrolle verloren hat.
export async function dropOwner(env, discordId) {
  const r = await env.DB.prepare('DELETE FROM member_games WHERE discord_id = ?1').bind(discordId).run();
  await env.DB.prepare("UPDATE bring_requests SET status = 'cancelled' WHERE status = 'open' AND req_discord = ?1").bind(discordId).run();
  // Offene Anfragen an diese Person: bei mehreren Besitzern nur sie herausnehmen, sonst gilt die Anfrage nicht mehr.
  const { results } = await env.DB.prepare("SELECT * FROM bring_requests WHERE status = 'open' AND (owner_discord = ?1 OR instr(coalesce(owners, ''), ?2) > 0)").bind(discordId, '"' + discordId + '"').all();
  for (const q of results) {
    const rest = ownersOf(q).filter((o) => o.id !== discordId);
    if (!rest.length || !stillAsked({ ...q, owners: JSON.stringify(rest) }).length) await env.DB.prepare("UPDATE bring_requests SET status = 'cancelled' WHERE id = ?1").bind(q.id).run();
    else await env.DB.prepare('UPDATE bring_requests SET owners = ?1, owner_discord = ?2, owner_name = ?3, mgame_id = ?4 WHERE id = ?5').bind(JSON.stringify(rest), rest[0].id, rest.map((o) => o.name).join(', ').slice(0, 200), rest[0].mg || q.mgame_id, q.id).run();
  }
  return (r.meta && r.meta.changes) || 0;
}

// Nächtlich: Besitzer bei Discord prüfen (älteste Prüfung zuerst, höchstens 30 pro Lauf wegen der Anfragegrenze).
export async function pruneMemberGames(env) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return 0;
  const rule = await getBooking(env);
  const { results } = await env.DB.prepare('SELECT DISTINCT g.discord_id, m.discord_id AS mid, m.roles, m.checked_at FROM member_games g LEFT JOIN members m ON m.discord_id = g.discord_id ORDER BY coalesce(m.checked_at, 0) LIMIT 30').all();
  let n = 0;
  for (const o of results) {
    if (!o.mid) { n += await dropOwner(env, o.discord_id); continue; } // nicht mehr in members: hat den Server verlassen
    let a;
    try { a = await checkAccess(env, o.discord_id); } catch (e) { console.log('prune check failed', e.message); break; } // Discord nicht erreichbar: nächstes Mal
    if (!a.ok || !isMember(rule, a.roles)) { n += await dropOwner(env, o.discord_id); continue; }
    await env.DB.prepare('UPDATE members SET checked_at = ?1, roles = ?2, name = coalesce(nullif(?3, \'\'), name) WHERE discord_id = ?4').bind(Date.now(), JSON.stringify(a.roles || []), (a.name || '').slice(0, 40), o.discord_id).run();
  }
  return n;
}

export async function backfillMemberGames(env) {
  if (!env.BGG_TOKEN) return 0;
  // Bis zu 5 Blöcke à 20 pro Lauf (große BGG-Importe sind so nach wenigen Nächten vollständig).
  let n = 0;
  for (let round = 0; round < 5; round++) {
    const { results } = await env.DB.prepare('SELECT DISTINCT game_id FROM member_games WHERE data IS NULL AND game_id IS NOT NULL LIMIT 20').all();
    if (!results.length) break;
    const got = await fetchThings(env, results.map((r) => r.game_id), 3);
    if (!got.length) break;
    await env.DB.batch(got.map((t) => { const { thumb, img, ...d } = t; return env.DB.prepare('UPDATE member_games SET data = ?1 WHERE game_id = ?2 AND data IS NULL').bind(JSON.stringify(d), t.id); }));
    n += got.length;
  }
  return n;
}
