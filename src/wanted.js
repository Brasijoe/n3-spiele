// „Hat jemand …?“: Ein Spiel, das weder in der Club-Sammlung noch bei den Mitgliederspielen steht, im Bot-Kanal suchen.
// Wer es hat, antwortet in Discord mit „Hab ich“ (optional gleich mit einer Runde). Andere können „Will auch mitspielen“ drücken.
// Offene Suchen stehen auf der Webseite unter „Mitspieler finden“ und laufen nach 3 Monaten ohne Zusage ab.
import { discord, channelIds, discordOn, fmtDate, wdName, who, say, reply, berlinToday, parseDate, nextStammtischDate, headline, view } from './discord.js';
import { getBooking, isMember, isStammtisch, canJoin, introOk, INTRO_HELP, nextStammtische, ruleText } from './booking.js';
import { listMemberGames } from './membergames.js';
import { inClub } from './games.js';

const enc = new TextEncoder();
const sha256 = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))), (x) => x.toString(16).padStart(2, '0')).join('');
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
const addMonths = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const fmtDay = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
export const WANT_MONTHS = 3;
const MAX_INTEREST = 20;

let tableOk = false;
export async function ensureWanted(env) {
  if (tableOk) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS wanted (id TEXT PRIMARY KEY, req_discord TEXT NOT NULL, req_name TEXT NOT NULL, req_member INTEGER NOT NULL DEFAULT 1, game TEXT NOT NULL, game_id INTEGER, year INTEGER, note TEXT NOT NULL DEFAULT \'\', status TEXT NOT NULL DEFAULT \'open\', interested TEXT NOT NULL DEFAULT \'[]\', finder_discord TEXT, finder_name TEXT, party_id TEXT, discord_channel TEXT, discord_msg TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, closed_at TEXT)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS wanted_status ON wanted(status, expires_at)').run();
  tableOk = true;
}

const interestOf = (r) => { try { const a = JSON.parse(r.interested || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const msgUrl = (env, r) => (env.DISCORD_GUILD_ID && r.discord_channel && r.discord_msg ? `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${r.discord_channel}/${r.discord_msg}` : '');
const wantedOut = (env, r) => ({ id: r.id, game: r.game, gameId: r.game_id, year: r.year, note: r.note, by: r.req_name, interested: interestOf(r).map((x) => x.name), createdAt: r.created_at, expiresAt: r.expires_at, url: msgUrl(env, r) });

// Spiel schon da? Club-Sammlung (BGG-ID) oder Mitgliederspiele (BGG-ID oder gleicher Name).
async function available(env, gameId, game) {
  if (gameId && (await inClub(env, gameId))) return 'in_club';
  const lc = game.toLowerCase();
  const mg = (await listMemberGames(env)).find((g) => (gameId ? g.gameId === gameId : false) || (!g.gameId && String(g.game).toLowerCase() === lc));
  return mg ? 'in_members' : null;
}
const sameGame = (env, gameId, game) => (gameId
  ? env.DB.prepare("SELECT * FROM wanted WHERE status = 'open' AND game_id = ?1").bind(gameId).first()
  : env.DB.prepare("SELECT * FROM wanted WHERE status = 'open' AND game_id IS NULL AND lower(game) = lower(?1)").bind(game).first());

// Routen /wanted…; gibt null zurück, wenn der Pfad nicht passt. h = Hilfsfunktionen aus index.js.
export async function wantedRoute(req, env, ctx, path, m, ip, h) {
  if (!path.startsWith('/wanted')) return null;
  const { json, fail, body, allow, checkMember, isAdmin } = h;
  await ensureWanted(env);
  let g;
  const login = async () => { const u = await checkMember(req, env, ip); return u.err ? { res: fail(u.err === 'rate_limited' ? 429 : 403, u.err) } : u; };

  if (path === '/wanted' && m === 'GET') {
    const { results } = await env.DB.prepare("SELECT * FROM wanted WHERE status = 'open' AND expires_at >= ?1 ORDER BY created_at DESC LIMIT 200").bind(berlinToday()).all();
    const r = json(results.map((x) => wantedOut(env, x))); r.headers.set('cache-control', 'public, max-age=30'); return r;
  }
  if (path === '/wanted' && m === 'POST') {
    const u = await login(); if (u.res) return u.res;
    if (!discordOn(env)) return fail(503, 'discord_off');
    const b = await body(req);
    const game = str(b.game, 120), gameId = int(b.gameId);
    if (!game || (gameId != null && !(gameId > 0))) return fail(400, 'invalid');
    const av = await available(env, gameId, game); if (av) return fail(409, av);
    const dup = await sameGame(env, gameId, game); if (dup) return json({ error: 'already_wanted', id: dup.id }, 409);
    // Spam-Bremse: 3 Suchen pro Tag und Person, 20 pro Tag insgesamt.
    if (!(await allow(env, 'want:' + u.member.discord_id, 3, 86400)) || !(await allow(env, 'want-all', 20, 86400))) return fail(429, 'rate_limited');
    const today = berlinToday(), rule = await getBooking(env);
    const row = { id: newId(), req_discord: u.member.discord_id, req_name: u.member.name, req_member: isMember(rule, u.member.roles) ? 1 : 0, game, game_id: gameId, year: int(b.year), note: str(b.note, 300), interested: '[]', created_at: new Date().toISOString(), expires_at: addMonths(today, WANT_MONTHS) };
    await env.DB.prepare('INSERT INTO wanted(id, req_discord, req_name, req_member, game, game_id, year, note, interested, created_at, expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)')
      .bind(row.id, row.req_discord, row.req_name, row.req_member, row.game, row.game_id, row.year, row.note, row.interested, row.created_at, row.expires_at).run();
    const ch = channelIds(env)[0];
    try {
      const msg = await discord(env, 'POST', `/channels/${ch}/messages`, wantedMessage(row, env));
      await env.DB.prepare('UPDATE wanted SET discord_channel = ?1, discord_msg = ?2 WHERE id = ?3').bind(ch, msg.id, row.id).run();
      row.discord_channel = ch; row.discord_msg = msg.id;
    } catch (e) {
      console.log('wanted post failed', e && e.message);
      await env.DB.prepare('DELETE FROM wanted WHERE id = ?1').bind(row.id).run();
      return fail(502, 'discord_error');
    }
    return json(wantedOut(env, row));
  }
  if ((g = path.match(/^\/wanted\/([\w-]+)\/interest$/)) && m === 'POST') {
    const u = await login(); if (u.res) return u.res;
    if (!(await allow(env, 'wint:' + u.member.discord_id, 30, 3600))) return fail(429, 'rate_limited');
    const b = await body(req);
    const r = await env.DB.prepare("SELECT * FROM wanted WHERE id = ?1 AND status = 'open'").bind(g[1]).first();
    if (!r) return fail(404, 'not_found');
    if (r.req_discord === u.member.discord_id) return fail(400, 'own_request');
    const res = await setInterest(env, r, u.member.discord_id, u.member.name, isMember(await getBooking(env), u.member.roles), b.on !== false);
    if (res === 'full') return fail(409, 'full');
    if (res === 'changed') return fail(409, 'changed');
    if (r.discord_msg) ctx.waitUntil(refreshMessage(env, g[1]).catch((e) => console.log('wanted sync failed', e && e.message)));
    return json({ ok: true });
  }
  if ((g = path.match(/^\/wanted\/([\w-]+)$/)) && m === 'DELETE') {
    const r = await env.DB.prepare('SELECT * FROM wanted WHERE id = ?1').bind(g[1]).first();
    if (!r || r.status !== 'open') return json({ ok: true });
    if (req.headers.has('x-admin-token')) { if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden'); }
    else { const u = await login(); if (u.res) return u.res; if (u.member.discord_id !== r.req_discord) return fail(403, 'forbidden'); }
    await env.DB.prepare("UPDATE wanted SET status = 'withdrawn', closed_at = ?1 WHERE id = ?2 AND status = 'open'").bind(new Date().toISOString(), r.id).run();
    if (r.discord_msg) ctx.waitUntil(discord(env, 'PATCH', `/channels/${r.discord_channel}/messages/${r.discord_msg}`, closedMessage(r, 'Zurückgezogen.')).catch((e) => console.log('wanted withdraw sync failed', e && e.message)));
    return json({ ok: true });
  }
  return fail(404, 'not_found');
}

// „Will auch mitspielen“ an- oder abschalten. Gibt 'ok', 'full' oder 'changed' zurück (gleichzeitige Änderung).
async function setInterest(env, r, id, name, member, on) {
  const list = interestOf(r).filter((x) => x.id !== id);
  if (on) { if (list.length >= MAX_INTEREST) return 'full'; list.push({ id, name: str(name, 40), m: member ? 1 : 0 }); }
  const u = await env.DB.prepare("UPDATE wanted SET interested = ?1 WHERE id = ?2 AND status = 'open' AND interested = ?3").bind(JSON.stringify(list), r.id, r.interested).run();
  return u.meta.changes ? 'ok' : 'changed';
}

// ---- Discord-Nachricht ----
function gameEmbed(r, env, extra = {}) {
  const e = { title: '🔎 ' + r.game + (r.year ? ` (${r.year})` : ''), color: 0x2f7fb5, ...extra };
  if (r.game_id) {
    e.url = 'https://boardgamegeek.com/boardgame/' + r.game_id;
    if (env.PUBLIC_URL) e.thumbnail = { url: `${env.PUBLIC_URL.replace(/\/$/, '')}/api/cover/${r.game_id}.jpg` };
  }
  return e;
}
export function wantedMessage(r, env) {
  const ints = interestOf(r), fields = [];
  if (r.note) fields.push({ name: '💬 Nachricht', value: r.note.slice(0, 300) });
  if (ints.length) fields.push({ name: `🙋 Wollen auch mitspielen (${ints.length})`, value: ints.map((x) => x.name).join(', ').slice(0, 1000) });
  return {
    content: `**${r.req_name}** (<@${r.req_discord}>) sucht **${r.game}**. Das Spiel ist weder in der Club-Sammlung noch bei den Mitgliederspielen. Hat jemand von euch es und mag es mitbringen und mitspielen?`,
    embeds: [gameEmbed(r, env, { fields, footer: { text: `„Hab ich“: Du kannst gleich eine Runde anlegen, musst aber nicht. Die Suche steht bis ${fmtDate(r.expires_at)} auch auf der Webseite unter „Mitspieler finden“.` } })],
    components: [{ type: 1, components: [
      { type: 2, style: 3, label: 'Hab ich: Runde anlegen', emoji: { name: '🎲' }, custom_id: 'wantr:' + r.id },
      { type: 2, style: 3, label: 'Hab ich (Termin später)', custom_id: 'wanth:' + r.id },
      { type: 2, style: 1, label: 'Will auch mitspielen', emoji: { name: '🙋' }, custom_id: 'wanti:' + r.id },
      { type: 2, style: 2, label: 'Zurückziehen', custom_id: 'wantx:' + r.id },
    ] }],
    allowed_mentions: { parse: [] },
  };
}
const closedMessage = (r, why) => ({ content: `~~${r.req_name} hat gefragt, ob jemand **${r.game}** hat.~~ ${why}`, embeds: [], components: [], allowed_mentions: { parse: [] } });
async function refreshMessage(env, id) {
  const r = await env.DB.prepare('SELECT * FROM wanted WHERE id = ?1').bind(id).first();
  if (r && r.status === 'open' && r.discord_msg) await discord(env, 'PATCH', `/channels/${r.discord_channel}/messages/${r.discord_msg}`, wantedMessage(r, env));
}
const dmLinks = (people) => [{ type: 1, components: people.slice(0, 5).map((p) => ({ type: 2, style: 5, label: ('Nachricht an ' + p.name).slice(0, 80), url: 'https://discord.com/users/' + p.id })) }];
const closedTxt = (r) => (r.status === 'found' ? `${r.finder_name} hat das Spiel schon.` : r.status === 'expired' ? 'Diese Suche ist abgelaufen.' : 'Diese Suche wurde zurückgezogen.');

export async function wantedButton(i, env, ctx) {
  const [act, id] = String(i.data.custom_id).split(':');
  await ensureWanted(env);
  const w = who(i), r = await env.DB.prepare('SELECT * FROM wanted WHERE id = ?1').bind(id).first();
  if (!r) return say('Diese Suche gibt es nicht mehr.');
  if (r.status !== 'open') return say(closedTxt(r));
  if (act === 'wantx') {
    if (w.id !== r.req_discord) return say('Nur wer gesucht hat, kann die Suche zurückziehen.');
    const u = await env.DB.prepare("UPDATE wanted SET status = 'withdrawn', closed_at = ?1 WHERE id = ?2 AND status = 'open'").bind(new Date().toISOString(), id).run();
    if (!u.meta.changes) return say('Die Suche ist schon erledigt.');
    return reply({ type: 7, data: closedMessage(r, 'Zurückgezogen.') });
  }
  if (act === 'wanti') {
    if (w.id === r.req_discord) return say('Das ist deine eigene Suche, du bist sowieso dabei.');
    const on = !interestOf(r).some((x) => x.id === w.id);
    const res = await setInterest(env, r, w.id, w.name, isMember(await getBooking(env), (i.member && i.member.roles) || []), on);
    if (res === 'full') return say('Es haben sich schon genug Leute gemeldet.');
    if (res === 'changed') return say('Die Suche hat sich gerade geändert. Bitte noch einmal klicken.');
    ctx.waitUntil(refreshMessage(env, id).catch((e) => console.log('wanted sync failed', e && e.message)));
    return say(on ? `Notiert: Du willst auch **${r.game}** spielen. Legt jemand eine Runde an, bist du gleich dabei (sofern Platz ist). Nochmal klicken nimmt dich wieder raus.` : 'Du stehst nicht mehr auf der Liste.');
  }
  if (w.id === r.req_discord) return say('Das ist deine eigene Suche. Zurückziehen kannst du sie mit „Zurückziehen“.');
  if (act === 'wanth') {
    const u = await env.DB.prepare("UPDATE wanted SET status = 'found', finder_discord = ?1, finder_name = ?2, closed_at = ?3 WHERE id = ?4 AND status = 'open'").bind(w.id, w.name, new Date().toISOString(), id).run();
    if (!u.meta.changes) return say('Zu spät: die Suche ist schon erledigt.');
    const ints = interestOf(r);
    if (r.discord_msg) ctx.waitUntil(discord(env, 'POST', `/channels/${r.discord_channel}/messages`, {
      content: `<@${r.req_discord}>${ints.length ? ' ' + ints.map((x) => `<@${x.id}>`).join(' ') : ''} ${w.name} hat **${r.game}**! Macht direkt einen Termin aus, eine Runde kann ${w.name} jederzeit mit \`/party\` oder auf der Webseite anlegen.`,
      message_reference: { message_id: r.discord_msg, fail_if_not_exists: false }, allowed_mentions: { users: [r.req_discord, ...ints.map((x) => x.id)].slice(0, 100) },
    }).catch((e) => console.log('wanted found reply failed', e && e.message)));
    return reply({ type: 7, data: {
      content: `✅ **${w.name}** hat **${r.game}** (gesucht von ${r.req_name}). Schreibt euch, um einen Termin auszumachen.` + (ints.length ? ` Auch mitspielen wollen: ${ints.map((x) => x.name).join(', ')}.` : '') + '\nTipp: Trag das Spiel auf der Webseite unter „Mitglieder besitzen“ ein, dann findet man es beim nächsten Mal direkt.',
      embeds: [gameEmbed(r, env)], components: dmLinks([{ id: r.req_discord, name: r.req_name }, ...ints]), allowed_mentions: { parse: [] },
    } });
  }
  if (act === 'wantr') {
    const rule = await getBooking(env), d = nextStammtischDate(rule);
    const row = (custom_id, label, value, extra = {}) => ({ type: 1, components: [{ type: 4, custom_id, label, style: 1, value: String(value), required: true, ...extra }] });
    return reply({ type: 9, data: { custom_id: 'wantr:' + id, title: ('Runde: ' + r.game).slice(0, 45), components: [
      row('datum', 'Datum (z. B. 17.11. oder 2026-11-17)', fmtDate(d), { max_length: 20 }),
      row('uhrzeit', 'Uhrzeit (HH:MM)', '18:00', { min_length: 5, max_length: 5 }),
      row('plaetze', 'Plätze inkl. dir (2–30)', 4, { max_length: 2 }),
      { type: 1, components: [{ type: 4, custom_id: 'hinweis', label: 'Hinweis (optional)', style: 2, required: false, max_length: 500 }] },
    ] } });
  }
  return say('Unbekannte Aktion.');
}

export async function wantedSubmit(i, env, ctx) {
  const [, id] = String(i.data.custom_id).split(':');
  await ensureWanted(env);
  const w = who(i), r = await env.DB.prepare('SELECT * FROM wanted WHERE id = ?1').bind(id).first();
  if (!r) return say('Diese Suche gibt es nicht mehr.');
  if (r.status !== 'open') return say(closedTxt(r));
  if (w.id === r.req_discord) return say('Das ist deine eigene Suche.');
  const f = {};
  for (const row of i.data.components || []) for (const c of row.components || []) f[c.custom_id] = c.value;
  const again = ' Klick noch einmal auf „Hab ich: Runde anlegen“.';
  const date = parseDate(f.datum); if (!date) return say('Datum nicht verstanden. Beispiele: 2026-11-17, 17.11.' + again);
  if (date < berlinToday()) return say('Das Datum liegt in der Vergangenheit.' + again);
  const time = str(f.uhrzeit, 5); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return say('Uhrzeit bitte als HH:MM, z. B. 18:00.' + again);
  const seats = Number(f.plaetze); if (!(seats >= 2 && seats <= 30)) return say('Plätze: 2 bis 30 (inkl. dir).' + again);
  const hint = str(f.hinweis, 500);
  const rule = await getBooking(env), next = nextStammtische(berlinToday(), rule, 4).map(fmtDay).join(', ');
  // Gleiche Regeln wie bei /party: ohne Mitgliederrolle nur Stammtisch-Tage und mit kurzer Vorstellung.
  if (!isMember(rule, (i.member && i.member.roles) || [])) {
    if (!isStammtisch(date, rule)) return say(`Ohne Mitgliederrolle kannst du Runden nur an Stammtisch-Tagen anlegen (${ruleText(rule)}). Nächste Termine: ${next}.` + again);
    if (!introOk(hint)) return say(INTRO_HELP + again);
  }
  // Die suchende Person muss mitspielen dürfen: ohne Mitgliederrolle nur an Stammtisch-Tagen.
  const prow = { date, event_id: null };
  if (!canJoin(rule, prow, r.req_member ? [rule.memberRole] : [])) return say(`${r.req_name} hat keine Mitgliederrolle und kann deshalb nur an Stammtisch-Tagen mitspielen (${ruleText(rule)}). Nächste Termine: ${next}.` + again);
  const pid = newId();
  const u = await env.DB.prepare("UPDATE wanted SET status = 'found', finder_discord = ?1, finder_name = ?2, party_id = ?3, closed_at = ?4 WHERE id = ?5 AND status = 'open'").bind(w.id, w.name, pid, new Date().toISOString(), id).run();
  if (!u.meta.changes) return say('Zu spät: die Suche ist schon erledigt.');
  // Suchende Person plus alle, die „Will auch mitspielen“ gedrückt haben (soweit Platz ist und sie an dem Tag dürfen).
  const ints = interestOf(r).filter((x) => x.id !== w.id), now = new Date().toISOString();
  const att = { ['d' + r.req_discord]: { name: r.req_name, at: now } };
  const inn = [], out = [];
  for (const x of ints) { if (Object.keys(att).length + 1 < seats && canJoin(rule, prow, x.m ? [rule.memberRole] : [])) { att['d' + x.id] = { name: x.name, at: now }; inn.push(x); } else out.push(x); }
  const note = hint || `${w.name} bringt das Spiel mit (gesucht von ${r.req_name}).`;
  await env.DB.prepare('INSERT INTO parties(id, game_id, game, guest, year, date, time, seats, host, host_key_hash, note, attendees, created_at, host_discord) VALUES(?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)')
    .bind(pid, r.game_id, r.game, r.year, date, time, seats, w.name, await sha256('discord:' + w.id), note, JSON.stringify(att), now, w.id).run();
  const ch = r.discord_channel || i.channel_id || channelIds(env)[0];
  const pinged = [r.req_discord, ...inn.map((x) => x.id), ...out.map((x) => x.id)];
  ctx.waitUntil((async () => {
    const party = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(pid).first();
    const v = view(party, env);
    const extra = out.length ? `\n${out.map((x) => `<@${x.id}>`).join(' ')} ihr wolltet auch mitspielen: tragt euch mit „Ich bin dabei“ ein, solange Platz ist.` : '';
    const msg = await discord(env, 'POST', `/channels/${ch}/messages`, { ...v, content: headline(party) + `\n🙌 <@${r.req_discord}>${inn.map((x) => ` <@${x.id}>`).join('')}, ${w.name} hat **${r.game}** und bringt es mit – ihr seid schon dabei.` + extra, allowed_mentions: { users: pinged.slice(0, 100) } });
    await env.DB.prepare('UPDATE parties SET discord_channel = ?1, discord_msg = ?2 WHERE id = ?3').bind(ch, msg.id, pid).run();
  })().catch((e) => console.log('wanted party announce failed', e && e.message)));
  return reply({ type: 7, data: {
    content: `✅ **${w.name}** hat **${r.game}** (gesucht von ${r.req_name}) und bringt es am ${wdName(date)}, ${fmtDate(date)} um ${time} Uhr mit. Die Runde ist angelegt, ${[r.req_name, ...inn.map((x) => x.name)].join(', ')} ${inn.length ? 'sind' : 'ist'} schon dabei.`,
    embeds: [gameEmbed(r, env)], components: [], allowed_mentions: { parse: [] },
  } });
}

// Nächtlich: Suchen ohne Zusage nach 3 Monaten beenden (höchstens 25 pro Lauf, die Nachricht wird durchgestrichen).
export async function expireWanted(env) {
  await ensureWanted(env);
  const { results } = await env.DB.prepare("SELECT * FROM wanted WHERE status = 'open' AND expires_at < ?1 LIMIT 25").bind(berlinToday()).all();
  for (const r of results) {
    await env.DB.prepare("UPDATE wanted SET status = 'expired', closed_at = ?1 WHERE id = ?2 AND status = 'open'").bind(new Date().toISOString(), r.id).run();
    if (r.discord_msg && env.DISCORD_BOT_TOKEN) {
      try { await discord(env, 'PATCH', `/channels/${r.discord_channel}/messages/${r.discord_msg}`, closedMessage(r, `Abgelaufen (${WANT_MONTHS} Monate ohne Zusage).`)); } catch (e) { console.log('wanted expire sync failed', e && e.message); }
    }
  }
  return results.length;
}

// Für /my: eigene Suchen und die, bei denen man „Will auch mitspielen“ gedrückt hat.
export async function myWanted(env, discordId) {
  await ensureWanted(env);
  const { results } = await env.DB.prepare("SELECT id, req_discord, interested FROM wanted WHERE status = 'open' AND (req_discord = ?1 OR instr(interested, ?2) > 0)").bind(discordId, '"' + discordId + '"').all();
  return { mine: results.filter((r) => r.req_discord === discordId).map((r) => r.id), joined: results.filter((r) => r.req_discord !== discordId && interestOf(r).some((x) => x.id === discordId)).map((r) => r.id) };
}
