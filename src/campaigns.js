// Kampagnen: Mitspielende für eine längere Kampagne (viele Sitzungen im festen Rhythmus) finden.
// - Wer eine Kampagne anlegt (nur Mitglieder), wählt Spiel, Start, Rhythmus (alle N Tage, alle N Wochen, n-ter Wochentag im Monat),
//   Uhrzeit, Dauer pro Sitzung, ungefähre Anzahl Sitzungen und Plätze. Ersteller und Verwaltung können alles später ändern.
// - Der Bot postet die Kampagne im Kampagnen-Kanal (DISCORD_CAMPAIGN_CHANNEL_ID, leer = erster DISCORD_CHANNEL_ID) und öffnet daran
//   einen Thread. Alle Mitspielenden werden hinzugefügt. Eine Woche vor jeder Sitzung kommt der Termin in den Thread (mit Erwähnung aller).
// - Jede Person in der Kampagne kann für eine Sitzung einen anderen Termin vorschlagen. Stimmen alle zu (oder übernimmt der Ersteller),
//   wird die Sitzung verschoben. Die übrigen Sitzungen bleiben, wo sie sind.
// - Mitmachen: Mitglieder immer; ohne Mitgliederrolle nur, wenn alle kommenden Sitzungen an Stammtisch-Tagen liegen (wie bei Runden).
import { discord, campaignChannel, fmtDate, wdName, who, say, reply, berlinToday, parseDate } from './discord.js';
import { getBooking, isMember, isStammtisch, guestsPaused, pauseText, ruleText as stmText, addDays } from './booking.js';

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
export const MAX_SESSIONS = 60;
export const POST_DAYS = 7; // Sitzungen so viele Tage vorher im Thread posten
const DONE_DAYS = 14; // nach der letzten Sitzung noch so lange anzeigen, dann Thread schließen

let tableOk = false;
export async function ensureCampaigns(env) {
  if (tableOk) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, game TEXT NOT NULL, game_id INTEGER, year INTEGER,
    host_discord TEXT NOT NULL, host_name TEXT NOT NULL, start_date TEXT NOT NULL, time TEXT NOT NULL, rule TEXT NOT NULL, sessions INTEGER NOT NULL,
    duration INTEGER, seats INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', open INTEGER NOT NULL DEFAULT 1, players TEXT NOT NULL DEFAULT '{}',
    invited TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', discord_channel TEXT, discord_msg TEXT, discord_thread TEXT, thread_state TEXT, created_at TEXT NOT NULL, ended_at TEXT, outcome TEXT)`).run();
  // planned = Termin nach dem Rhythmus, date/time = tatsächlicher Termin (nach Verschieben). posted: 0 = noch nicht im Thread, 1 = gepostet, 2 = vorbei (Knöpfe entfernt).
  // prop = offener Vorschlag {kind: 'm' (verschieben) | 'x' (absagen), date, time, by, name, yes:[ids], no:[ids], msg, at}; cancelled = 1: Sitzung fällt aus (abgestimmt).; absent = IDs, die bei dieser Sitzung nicht können.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS campaign_sessions (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, planned TEXT NOT NULL, date TEXT NOT NULL,
    time TEXT NOT NULL, absent TEXT NOT NULL DEFAULT '[]', prop TEXT, discord_msg TEXT, posted INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0, play_id TEXT)`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS campaign_sessions_c ON campaign_sessions(campaign_id, date)').run();
  tableOk = true;
}

// ---------- Rhythmus ----------
// rule: {t:'d', n} alle n Tage
//   · {t:'x', wd:[0–6], every: 1–8, mo:[{nth: 1–4|-1, wd}], extra:[ISO], skip:[ISO]} frei wie die Stammtisch-Tage:
//     Wochentage (alle `every` Wochen, gezählt ab der Woche des Starts) + n-te Wochentage im Monat + Zusatztermine, ohne Ausfalltage.
//   · alt (bestehende Kampagnen): {t:'w', n} alle n Wochen am Wochentag des Starts · {t:'m', nth, wd} n-ter Wochentag im Monat
const isoList = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter(isDate))].sort().slice(0, 100);
export function cleanRule(r) {
  r = r || {};
  if (r.t === 'd') { const n = int(r.n); return n >= 1 && n <= 90 ? { t: 'd', n } : null; }
  if (r.t === 'w') { const n = int(r.n); return n >= 1 && n <= 12 ? { t: 'w', n } : null; }
  if (r.t === 'm') { const nth = int(r.nth), wd = int(r.wd); return [1, 2, 3, 4, -1].includes(nth) && wd >= 0 && wd <= 6 ? { t: 'm', nth, wd } : null; }
  if (r.t === 'x') {
    const okWd = (x) => Number.isInteger(x) && x >= 0 && x <= 6;
    const wd = [...new Set((Array.isArray(r.wd) ? r.wd : []).map(Number).filter(okWd))].sort();
    const seen = new Set(), mo = (Array.isArray(r.mo) ? r.mo : []).map((x) => ({ nth: Number(x && x.nth), wd: Number(x && x.wd) }))
      .filter((x) => [1, 2, 3, 4, -1].includes(x.nth) && okWd(x.wd) && !seen.has(x.nth + '/' + x.wd) && seen.add(x.nth + '/' + x.wd)).slice(0, 35);
    const every = Math.min(8, Math.max(1, int(r.every) || 1)), extra = isoList(r.extra), skip = isoList(r.skip);
    return wd.length || mo.length || extra.length ? { t: 'x', wd, every, mo, extra, skip } : null;
  }
  return null;
}
const iso = (d) => d.toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
function nthWeekday(y, m, nth, wd) {
  if (nth === -1) { const d = new Date(Date.UTC(y, m + 1, 0, 12)); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - wd + 7) % 7)); return iso(d); }
  const d = new Date(Date.UTC(y, m, 1, 12)); d.setUTCDate(1 + ((wd - d.getUTCDay() + 7) % 7) + 7 * (nth - 1)); return iso(d);
}
const dm = (d) => d.slice(8, 10) + '.' + d.slice(5, 7) + '.';
// Passt der Tag zur freien Regel? mon = Montag der Startwoche (für „alle n Wochen“).
function xMatch(rule, d, mon) {
  if (rule.skip.includes(d)) return false;
  if (rule.extra.includes(d)) return true;
  const dt = new Date(d + 'T12:00:00Z'), w = dt.getUTCDay(), day = dt.getUTCDate();
  if (rule.wd.includes(w) && Math.floor(dayDiff(mon, d) / 7) % rule.every === 0) return true;
  const len = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  return rule.mo.some((x) => x.wd === w && (x.nth === -1 ? day + 7 > len : Math.ceil(day / 7) === x.nth));
}
// Termine nach dem Rhythmus ab start (einschließlich), die nach `after` liegen; höchstens count.
export function ruleDates(rule, start, count, after = '') {
  const out = [];
  if (!rule || !isDate(start) || count <= 0) return out;
  if (rule.t === 'x') {
    const mon = addDays(start, -((new Date(start + 'T12:00:00Z').getUTCDay() + 6) % 7));
    let d = after && after >= start ? addDays(after, 1) : start;
    for (let i = 0; out.length < count && i < 3 * 366; i++, d = addDays(d, 1)) if (xMatch(rule, d, mon)) out.push(d);
    return out;
  }
  if (rule.t === 'm') {
    let y = +start.slice(0, 4), m = +start.slice(5, 7) - 1;
    for (let i = 0; out.length < count && i < 1200; i++) {
      const d = nthWeekday(y, m, rule.nth, rule.wd);
      if (d >= start && d > after) out.push(d);
      if (++m > 11) { m = 0; y++; }
    }
    return out;
  }
  const step = rule.t === 'd' ? rule.n : rule.n * 7;
  let d = start;
  if (after && after > start) d = addDays(start, Math.floor(dayDiff(start, after) / step) * step);
  for (let i = 0; out.length < count && i < 5000; i++, d = addDays(d, step)) if (d >= start && d > after) out.push(d);
  return out;
}
const WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const NTH = { 1: 'ersten', 2: 'zweiten', 3: 'dritten', 4: 'vierten', '-1': 'letzten' };
export function rhythmText(rule, start) {
  if (!rule || !start) return 'Termin und Rhythmus stehen noch nicht fest';
  if (rule.t === 'x') {
    const ev = rule.every > 1 ? `alle ${rule.every} Wochen am ` : 'jeden ';
    const parts = rule.wd.map((w) => ev + WD[w]).concat(rule.mo.map((x) => `am ${NTH[x.nth]} ${WD[x.wd]} im Monat`));
    if (rule.extra.length) parts.push(`zusätzlich ${rule.extra.map(dm).join(', ')}`);
    if (rule.skip.length) parts.push(`nicht ${rule.skip.map(dm).join(', ')}`);
    return parts.join(', ');
  }
  if (rule.t === 'd') return rule.n === 1 ? 'täglich' : `alle ${rule.n} Tage`;
  const wd = WD[new Date(start + 'T12:00:00Z').getUTCDay()];
  if (rule.t === 'w') return rule.n === 1 ? `jeden ${wd}` : `alle ${rule.n} Wochen am ${wd}`;
  return `jeden ${NTH[rule.nth]} ${WD[rule.wd]} im Monat`;
}
const durText = (min) => (min ? 'ca. ' + (min % 60 ? String(Math.round(min / 6) / 10).replace('.', ',') : min / 60) + ' Std.' : '');

// ---------- Laden / Hilfen ----------
const getCamp = (env, id) => env.DB.prepare('SELECT * FROM campaigns WHERE id = ?1').bind(id).first();
async function getSessions(env, cid) {
  const { results } = await env.DB.prepare('SELECT * FROM campaign_sessions WHERE campaign_id = ?1 AND cancelled = 0 ORDER BY date, time, planned').bind(cid).all();
  return results;
}
const getSession = (env, sid) => env.DB.prepare('SELECT * FROM campaign_sessions WHERE id = ?1').bind(sid).first();
export const playersOf = (c) => J(c.players, {});
// Alle in der Kampagne (Ersteller zuerst), als [{id, name}].
export const people = (c) => [{ id: c.host_discord, name: c.host_name }, ...Object.entries(playersOf(c)).map(([id, p]) => ({ id, name: p.name }))];
const isIn = (c, uid) => !!uid && (uid === c.host_discord || !!playersOf(c)[uid]);
// Einladungen: [{id, name, k (Schlüssel fürs Web), res (1 = Platz reserviert), by, at, dm, msg (Direktnachricht)}]; alte Einträge sind nur IDs.
// Ein reservierter Platz bleibt belegt, bis die Person mitmacht, ablehnt oder der Ersteller die Einladung zurücknimmt.
export const invOf = (c) => J(c.invited, []).map((x) => (typeof x === 'string' ? { id: x, name: '', k: 'i' + x.slice(-8), res: 0 } : x)).filter((x) => x && x.id);
const reservedOf = (c) => invOf(c).filter((x) => x.res && !isIn(c, x.id));
const free = (c) => Math.max(0, c.seats - 1 - Object.keys(playersOf(c)).length - reservedOf(c).length);
async function saveInv(env, c, list) {
  c.invited = JSON.stringify(list.slice(-200));
  await env.DB.prepare('UPDATE campaigns SET invited = ?1 WHERE id = ?2').bind(c.invited, c.id).run();
}
const numberOf = (rows, sid) => rows.findIndex((r) => r.id === sid) + 1;
const tbd = (c) => !c.start_date;
const phase = (rows, today = berlinToday()) => { const done = rows.filter((r) => r.date < today).length; return !rows.length || done === rows.length ? 'done' : done ? 'running' : 'new'; };
const tLink = (env, c) => (c.discord_thread && env.DISCORD_GUILD_ID ? `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${c.discord_thread}` : '');
const when = (date, time) => `${wdName(date)}, ${fmtDate(date)}${time ? ` · ${time} Uhr` : ''}`;

// Darf diese Person mitmachen? Gibt null oder einen Fehlercode zurück.
// Eingeladene (von jemandem aus der Kampagne) dürfen auch, wenn die Kampagne niemanden mehr sucht oder sie keine Mitgliederrolle haben.
async function joinCheck(env, c, rows, roles, uid) {
  if (c.status !== 'active') return 'ended';
  const today = berlinToday(), fut = rows.filter((r) => r.date >= today);
  if (!fut.length && !tbd(c)) return 'ended';
  const inv = uid ? invOf(c).find((x) => x.id === uid) : null;
  if (inv && inv.res) return null; // eigener reservierter Platz
  if (!free(c)) return 'full';
  if (inv) return null;
  if (!c.open) return 'closed';
  const rule = await getBooking(env);
  if (isMember(rule, roles)) return null;
  if (guestsPaused(rule, today)) return 'guests_paused';
  // Ohne Mitgliederrolle: nur wenn alle kommenden Sitzungen an Stammtisch-Tagen liegen (Termin noch offen = nur mit Einladung).
  return !tbd(c) && fut.every((r) => isStammtisch(r.date, rule)) ? null : 'members_only';
}
async function addPlayer(env, c, uid, name, member) {
  const pl = playersOf(c);
  if (uid === c.host_discord || pl[uid]) return 'already';
  pl[uid] = { name: str(name, 40), at: new Date().toISOString(), m: member ? 1 : 0 };
  const u = await env.DB.prepare('UPDATE campaigns SET players = ?1 WHERE id = ?2 AND players = ?3').bind(JSON.stringify(pl), c.id, c.players).run();
  if (!u.meta.changes) return 'changed';
  // War die Person eingeladen: Einladung ist erledigt (reservierter Platz wird zum normalen Platz).
  const fresh = await getCamp(env, c.id), inv = invOf(fresh), mine = inv.find((x) => x.id === uid);
  if (mine) { await saveInv(env, fresh, inv.filter((x) => x.id !== uid)); c._accepted = mine; }
  return null;
}
// Hinweis im privaten Thread (ohne Erwähnungen).
async function threadNote(env, c, content) {
  if (!c.discord_thread || !env.DISCORD_BOT_TOKEN || thState(c).a) return;
  await toThread(env, c, { content, allowed_mentions: { parse: [] } }).catch((e) => console.log('campaign note failed', e && e.message));
}
// Direktnachricht einer Einladung ändern (Knöpfe weg).
async function closeInviteDm(env, x, text) {
  if (!x.dm || !x.msg || !env.DISCORD_BOT_TOKEN) return;
  await discord(env, 'PATCH', `/channels/${x.dm}/messages/${x.msg}`, { content: text, embeds: [], components: [] }).catch(() => {});
}
// Einladung zurücknehmen (Ersteller/Verwaltung) oder ablehnen (eingeladene Person). Gibt den Eintrag zurück oder null.
async function dropInvite(env, c, match, by) {
  const inv = invOf(c), x = inv.find(match); if (!x) return null;
  await saveInv(env, c, inv.filter((y) => y !== x));
  const nm = x.name || 'Eine eingeladene Person';
  if (env.DISCORD_BOT_TOKEN) {
    await closeInviteDm(env, x, by ? `${ICON} Die Einladung zur Kampagne **${c.game}** wurde zurückgenommen.` : `${ICON} Du hast die Einladung zur Kampagne **${c.game}** abgelehnt.`);
    await threadNote(env, c, by ? `🗑️ ${by} hat die Einladung für **${nm}** zurückgenommen.${x.res ? ' Der reservierte Platz ist wieder frei.' : ''}` : `❌ **${nm}** hat die Einladung abgelehnt.${x.res ? ' Der reservierte Platz ist wieder frei.' : ''}`);
    await syncCampaign(env, c.id);
  }
  return x;
}
// Einladungen verschicken (Direktnachricht, privat) und im Thread vermerken.
async function sendInvites(env, c, list, byName) {
  const fails = [], post = c.discord_msg && env.DISCORD_GUILD_ID ? `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${c.discord_channel}/${c.discord_msg}` : '';
  const what = tbd(c) ? 'Termine noch offen' : `${rhythmText(J(c.rule, null), c.start_date)}, ${c.time} Uhr`;
  for (const x of list) {
    try {
      const dm = await discord(env, 'POST', '/users/@me/channels', { recipient_id: x.id });
      const btns = [{ type: 2, style: 3, label: 'Mitmachen', emoji: { name: '✋' }, custom_id: 'campj:' + c.id }, { type: 2, style: 4, label: 'Ablehnen', custom_id: 'campd:' + c.id }];
      if (post) btns.push({ type: 2, style: 5, label: 'Zur Kampagne', url: post });
      const msg = await discord(env, 'POST', `/channels/${dm.id}/messages`, {
        content: `✉️ **${byName}** lädt dich zur Kampagne **${c.game}** ein (${what}, ca. ${c.sessions} Sitzungen).${x.res ? ' Ein Platz ist für dich reserviert, bis du zusagst oder ablehnst.' : ''}${c.note ? `
> ${c.note.slice(0, 300)}` : ''}`,
        components: [{ type: 1, components: btns }], allowed_mentions: { parse: [] },
      });
      const fresh = await getCamp(env, c.id), inv = invOf(fresh), e = inv.find((y) => y.id === x.id);
      if (e) { e.dm = dm.id; e.msg = msg.id; await saveInv(env, fresh, inv); }
    } catch (e) { fails.push(x.name || 'jemand'); }
  }
  const names = list.map((x) => `**${x.name || 'jemand'}**`).join(', ');
  await threadNote(env, await getCamp(env, c.id), `✉️ ${byName} hat ${names} eingeladen${list.some((x) => x.res) ? ' (Platz reserviert, bis zugesagt, abgelehnt oder zurückgenommen)' : ''}.` +
    (fails.length ? ` ⚠️ ${fails.join(', ')} ${fails.length === 1 ? 'kann' : 'können'} keine Direktnachrichten vom Bot empfangen. Bitte direkt Bescheid geben: Mitmachen geht auch am Post der Kampagne.` : ''));
  await syncCampaign(env, c.id);
  return fails;
}
async function removePlayer(env, c, uid) {
  const pl = playersOf(c);
  if (!pl[uid]) return null;
  delete pl[uid];
  const u = await env.DB.prepare('UPDATE campaigns SET players = ?1 WHERE id = ?2 AND players = ?3').bind(JSON.stringify(pl), c.id, c.players).run();
  if (!u.meta.changes) return 'changed';
  // Offene Abstimmungen ohne diese Person neu bewerten.
  for (const s of await getSessions(env, c.id)) {
    const p = J(s.prop, null); if (!p) continue;
    if (p.by === uid) { await env.DB.prepare('UPDATE campaign_sessions SET prop = NULL WHERE id = ?1').bind(s.id).run(); continue; }
    p.yes = p.yes.filter((x) => x !== uid); p.no = p.no.filter((x) => x !== uid);
    await env.DB.prepare('UPDATE campaign_sessions SET prop = ?1 WHERE id = ?2').bind(JSON.stringify(p), s.id).run();
  }
  return null;
}

// ---------- Vorschläge (anderer Termin für eine Sitzung) ----------
// Gibt { err } oder { prop } zurück. Ein neuer Vorschlag ersetzt einen offenen.
// cancel = true: Vorschlag, die Sitzung ausfallen zu lassen (Absage); sonst neuer Termin.
async function propose(env, c, s, user, date, time, cancel = false) {
  if (c.status !== 'active' || s.cancelled) return { err: 'ended' };
  if (!isIn(c, user.id)) return { err: 'not_in' };
  const today = berlinToday();
  if (s.date < today) return { err: 'past_session' };
  if (cancel) { date = s.date; time = s.time; }
  else {
    if (!isDate(date) || date < today) return { err: 'bad_date' };
    if (!isTime(time)) return { err: 'bad_time' };
    if (date === s.date && time === s.time) return { err: 'same' };
  }
  const old = J(s.prop, null);
  const prop = { kind: cancel ? 'x' : 'm', date, time, by: user.id, name: str(user.name, 40), yes: [user.id], no: [], at: new Date().toISOString(), msg: null, old: old && old.msg ? old.msg : null };
  await env.DB.prepare('UPDATE campaign_sessions SET prop = ?1 WHERE id = ?2').bind(JSON.stringify(prop), s.id).run();
  return { prop };
}
// Abstimmen. Gibt { err } oder { applied: bool } zurück. Stimmen alle in der Kampagne zu, wird verschoben.
async function vote(env, c, s, uid, yes) {
  const p = J(s.prop, null);
  if (!p) return { err: 'no_prop' };
  if (!isIn(c, uid)) return { err: 'not_in' };
  p.yes = p.yes.filter((x) => x !== uid); p.no = p.no.filter((x) => x !== uid);
  (yes ? p.yes : p.no).push(uid);
  const u = await env.DB.prepare('UPDATE campaign_sessions SET prop = ?1 WHERE id = ?2 AND prop = ?3').bind(JSON.stringify(p), s.id, s.prop).run();
  if (!u.meta.changes) return { err: 'changed' };
  const all = people(c).every((x) => p.yes.includes(x.id));
  if (all) { const cur = { ...s, prop: JSON.stringify(p) }; const ok = await applyProp(env, c, cur); return { applied: ok, prop: p, ap: cur._applied }; }
  return { applied: false, prop: p };
}
// Vorschlag übernehmen: Sitzung verschieben. Gepostete Sitzungen, die jetzt weiter als eine Woche weg sind, werden später neu gepostet.
async function applyProp(env, c, s) {
  const p = J(s.prop, null); if (!p) return false;
  const n = numberOf(await getSessions(env, c.id), s.id);
  if (p.kind === 'x') {
    const u = await env.DB.prepare('UPDATE campaign_sessions SET cancelled = 1, prop = NULL WHERE id = ?1 AND prop = ?2').bind(s.id, s.prop).run();
    if (!u.meta.changes) return false;
    s._applied = { ...p, n, from: { date: s.date, time: s.time }, far: false, oldMsg: s.discord_msg };
    return true;
  }
  const far = p.date > addDays(berlinToday(), POST_DAYS);
  const u = await env.DB.prepare(`UPDATE campaign_sessions SET date = ?1, time = ?2, prop = NULL, absent = '[]', posted = CASE WHEN ?3 THEN 0 ELSE posted END, discord_msg = CASE WHEN ?3 THEN NULL ELSE discord_msg END WHERE id = ?4 AND prop = ?5`)
    .bind(p.date, p.time, far ? 1 : 0, s.id, s.prop).run();
  if (!u.meta.changes) return false;
  s._applied = { ...p, n, from: { date: s.date, time: s.time }, far, oldMsg: s.discord_msg };
  return true;
}

// ---------- Discord ----------
const ICON = '🗺️';
function gameEmbed(c, env, extra) {
  const e = { title: ICON + ' ' + c.game + (c.year ? ` (${c.year})` : ''), color: 0x2e8b7a, ...extra };
  if (c.game_id) {
    e.url = 'https://boardgamegeek.com/boardgame/' + c.game_id;
    if (env.PUBLIC_URL) e.thumbnail = { url: `${env.PUBLIC_URL.replace(/\/$/, '')}/api/cover/${c.game_id}.jpg` };
  }
  return e;
}
export function campaignMessage(c, rows, env) {
  const today = berlinToday(), next = rows.find((r) => r.date >= today), done = rows.filter((r) => r.date < today).length;
  const ppl = people(c), taken = ppl.length, fr = free(c), rs = reservedOf(c).length;
  const bar = '🟩'.repeat(Math.min(taken, c.seats)) + '🟨'.repeat(Math.max(0, Math.min(rs, c.seats - taken))) + '⬜'.repeat(Math.max(0, c.seats - taken - rs));
  const fields = [
    { name: done ? '📅 Nächste Sitzung' : '📅 Start', value: next ? when(next.date, next.time) : tbd(c) ? 'noch offen' : 'keine weitere Sitzung geplant' },
    { name: '🔁 Rhythmus', value: tbd(c) ? `noch offen${c.duration ? ` · ${durText(c.duration)} pro Sitzung` : ''}` : `${rhythmText(J(c.rule, null), c.start_date)}, ${c.time} Uhr${c.duration ? ` · ${durText(c.duration)}` : ''}` },
    { name: '🎯 Sitzungen', value: tbd(c) ? `ca. ${c.sessions}` : `ca. ${rows.length}${done ? `, davon ${done} gespielt` : ''}${rows.length ? ` · bis etwa ${fmtDate(rows[rows.length - 1].date)}` : ''}` },
    { name: `🪑 ${c.seats} Plätze`, value: `${bar}  ${!c.open ? '🔒 sucht niemanden mehr' : fr ? `noch ${fr} frei` : '🔒 voll'}${rs ? ` · ${rs} reserviert` : ''}` },
    { name: '👥 Dabei', value: ppl.map((x, i) => (i ? '🙋 ' : '👑 ') + `<@${x.id}>`).join('\n').slice(0, 1000) },
  ];
  if (c.note) fields.push({ name: '💬 Hinweis', value: c.note.slice(0, 500) });
  const web = env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/$/, '') + '/#kampagnen' : '';
  const btns = [
    { type: 2, style: 3, label: 'Mitmachen', emoji: { name: '✋' }, custom_id: 'campj:' + c.id, disabled: !fr || (!next && !tbd(c)) },
    { type: 2, style: 2, label: 'Aussteigen', custom_id: 'campl:' + c.id },
    { type: 2, style: 1, label: 'Einladen', emoji: { name: '✉️' }, custom_id: 'campi:' + c.id },
  ];
  if (web) btns.push({ type: 2, style: 5, label: 'Bearbeiten / alle Termine', url: web });
  return {
    content: `**${c.host_name}** sucht Mitspielende für eine Kampagne!`,
    embeds: [gameEmbed(c, env, { fields, footer: { text: 'Wer mitmacht, kommt in den privaten Thread zur Kampagne (nur Mitspielende sehen ihn). Eine Woche vor jeder Sitzung steht der Termin dort. Mit „Einladen“ holen Mitspielende andere dazu.' } })],
    components: [{ type: 1, components: btns }],
    allowed_mentions: { parse: [] },
  };
}
export function sessionMessage(c, s, rows) {
  const n = numberOf(rows, s.id), absent = J(s.absent, []), ppl = people(c);
  const yes = ppl.filter((x) => !absent.includes(x.id)), no = ppl.filter((x) => absent.includes(x.id));
  const past = s.date < berlinToday();
  const fields = [
    { name: '📅 Wann', value: when(s.date, s.time) + (c.duration ? ` · ${durText(c.duration)}` : '') + (s.date !== s.planned || s.time !== c.time ? '\n(verschoben)' : '') },
    { name: `✅ Dabei (${yes.length})`, value: yes.map((x) => `<@${x.id}>`).join(' ').slice(0, 1000) || '–' },
  ];
  if (no.length) fields.push({ name: `❌ Kann diesmal nicht (${no.length})`, value: no.map((x) => `<@${x.id}>`).join(' ').slice(0, 1000) });
  const p = J(s.prop, null);
  if (p) fields.push({ name: p.kind === 'x' ? '❌ Absage vorgeschlagen' : '🔁 Vorschlag offen', value: `${p.name}: ${p.kind === 'x' ? 'Sitzung ausfallen lassen' : when(p.date, p.time)} (${p.yes.length}/${ppl.length} einverstanden)` });
  return {
    content: `📅 **Sitzung ${n} von ca. ${rows.length}**: ${c.game}\n${ppl.map((x) => `<@${x.id}>`).join(' ')}`.slice(0, 1900),
    embeds: [{ color: 0x2e8b7a, fields, footer: { text: past ? 'Diese Sitzung ist vorbei.' : 'Ihr seid alle eingeplant. Wer nicht kann, drückt „Kann diesmal nicht“. Passt der Termin nicht, schlagt einen anderen vor.' } }],
    components: past ? [] : [{ type: 1, components: [
      { type: 2, style: 2, label: 'Kann diesmal nicht / doch dabei', custom_id: 'camps:' + s.id },
      { type: 2, style: 1, label: 'Anderen Termin vorschlagen', emoji: { name: '🔁' }, custom_id: 'campp:' + s.id },
      { type: 2, style: 4, label: 'Absage vorschlagen', custom_id: 'campc:' + s.id },
    ] }],
    allowed_mentions: { parse: [] },
  };
}
function propMessage(c, s, rows, p, state) {
  const n = (state && state.n) || numberOf(rows, s.id) || '?', ppl = people(c);
  const yes = ppl.filter((x) => p.yes.includes(x.id)), no = ppl.filter((x) => p.no.includes(x.id)), open = ppl.filter((x) => !p.yes.includes(x.id) && !p.no.includes(x.id));
  const from = state && state.from ? state.from : { date: s.date, time: s.time };
  const head = p.kind === 'x'
    ? `❌ **${p.name}** schlägt vor, **Sitzung ${n}** (${c.game}) am **${when(from.date, from.time)}** ausfallen zu lassen.`
    : `🔁 **${p.name}** schlägt für **Sitzung ${n}** (${c.game}) einen anderen Termin vor: ~~${when(from.date, from.time)}~~ → **${when(p.date, p.time)}**`;
  if (state && state.done) return { content: head + `\n${state.done}`, embeds: [], components: [], allowed_mentions: { parse: [] } };
  const fields = [{ name: `👍 Passt (${yes.length})`, value: yes.map((x) => x.name).join(', ').slice(0, 1000) || '–' }];
  if (no.length) fields.push({ name: `👎 Passt nicht (${no.length})`, value: no.map((x) => x.name).join(', ').slice(0, 1000) });
  if (open.length) fields.push({ name: `⏳ Noch offen (${open.length})`, value: open.map((x) => x.name).join(', ').slice(0, 1000) });
  return {
    content: head + (state && state.ping ? '\n' + open.map((x) => `<@${x.id}>`).join(' ') + ' bitte abstimmen.' : ''),
    embeds: [{ color: 0x2e8b7a, fields, footer: { text: `Stimmen alle zu, ${p.kind === 'x' ? 'fällt die Sitzung aus' : 'wird die Sitzung verschoben'}. ${c.host_name} (Ersteller) kann den Vorschlag auch direkt übernehmen.` } }],
    components: [{ type: 1, components: [
      { type: 2, style: 3, label: 'Passt mir', custom_id: 'campy:' + s.id },
      { type: 2, style: 4, label: 'Passt mir nicht', custom_id: 'campn:' + s.id },
      { type: 2, style: 1, label: 'Übernehmen (Ersteller)', custom_id: 'campa:' + s.id },
      { type: 2, style: 2, label: 'Zurückziehen', custom_id: 'campx:' + s.id },
    ] }],
    allowed_mentions: { users: state && state.ping ? open.map((x) => x.id).slice(0, 100) : [] },
  };
}

const dcOn = (env) => !!(env.DISCORD_BOT_TOKEN && campaignChannel(env));
const thState = (c) => J(c.thread_state, {}) || {};
// Thread-Mitglieder an die Kampagne angleichen.
async function syncThread(env, c) {
  if (!c.discord_thread || !env.DISCORD_BOT_TOKEN) return;
  const st = thState(c); if (st.a) return;
  const want = people(c).map((x) => x.id), have = new Set(st.m || []);
  try {
    for (const id of want.filter((x) => !have.has(x)).slice(0, 30)) { await discord(env, 'PUT', `/channels/${c.discord_thread}/thread-members/${id}`); have.add(id); }
    for (const id of [...have].filter((x) => !want.includes(x)).slice(0, 30)) { await discord(env, 'DELETE', `/channels/${c.discord_thread}/thread-members/${id}`); have.delete(id); }
  } catch (e) { console.log('campaign thread sync failed', e && e.message); }
  st.m = [...have];
  await env.DB.prepare('UPDATE campaigns SET thread_state = ?1 WHERE id = ?2').bind(JSON.stringify(st), c.id).run();
}
// Archivierte Threads (nach 7 Tagen ohne Nachricht) vor dem Posten wieder öffnen.
const toThread = async (env, c, body) => {
  try { await discord(env, 'PATCH', `/channels/${c.discord_thread}`, { archived: false }); } catch { /* war offen */ }
  return discord(env, 'POST', `/channels/${c.discord_thread}/messages`, body);
};
export async function announceCampaign(env, id) {
  if (!dcOn(env)) return;
  const c = await getCamp(env, id); if (!c) return;
  const rows = await getSessions(env, id), ch = campaignChannel(env);
  const msg = await discord(env, 'POST', `/channels/${ch}/messages`, campaignMessage(c, rows, env));
  await env.DB.prepare('UPDATE campaigns SET discord_channel = ?1, discord_msg = ?2 WHERE id = ?3').bind(ch, msg.id, id).run();
  try {
    // Privater Thread: nur hinzugefügte Mitspielende (und Moderierende) sehen und schreiben dort; hinzufügen kann nur der Bot (invitable: false).
    const th = await discord(env, 'POST', `/channels/${ch}/threads`, { name: `Kampagne: ${c.game}`.slice(0, 100), type: 12, invitable: false, auto_archive_duration: 10080 });
    await env.DB.prepare('UPDATE campaigns SET discord_thread = ?1, thread_state = ?2 WHERE id = ?3').bind(th.id, JSON.stringify({ m: [] }), id).run();
    await discord(env, 'POST', `/channels/${th.id}/messages`, { content: `Hier plant ihr die Kampagne **${c.game}**. Eine Woche vor jeder Sitzung postet der Bot hier den Termin und erwähnt alle, die dabei sind. Wer bei einer Sitzung nicht kann, sagt es dort mit einem Klick. Passt ein Termin nicht, schlag mit „Anderen Termin vorschlagen“ einen neuen vor (oder „Absage vorschlagen“): stimmen alle zu oder übernimmt ${c.host_name} ihn, wird die Sitzung verschoben bzw. fällt aus. Diesen Thread sehen nur die Mitspielenden. Andere holst du mit „Einladen“ dazu: die Einladung kommt privat per Direktnachricht, auf Wunsch mit reserviertem Platz.`, components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Einladen', emoji: { name: '✉️' }, custom_id: 'campi:' + c.id }] }], allowed_mentions: { parse: [] } });
    await syncThread(env, { ...c, discord_thread: th.id, thread_state: JSON.stringify({ m: [] }) });
  } catch (e) { console.log('campaign thread failed', e && e.message); }
  await postDueSessions(env, id);
}
// Post der Kampagne und Thread-Mitglieder aktualisieren.
export async function syncCampaign(env, id) {
  if (!env.DISCORD_BOT_TOKEN) return;
  const c = await getCamp(env, id); if (!c || c.status !== 'active') return;
  const rows = await getSessions(env, id);
  if (c.discord_msg) await discord(env, 'PATCH', `/channels/${c.discord_channel}/messages/${c.discord_msg}`, campaignMessage(c, rows, env)).catch((e) => console.log('campaign msg sync failed', e && e.message));
  await syncThread(env, c);
  for (const s of rows) if (s.posted === 1 && s.discord_msg) await discord(env, 'PATCH', `/channels/${c.discord_thread}/messages/${s.discord_msg}`, sessionMessage(c, s, rows)).catch((e) => console.log('session msg sync failed', e && e.message));
}
async function syncSession(env, c, sid) {
  const rows = await getSessions(env, c.id), s = rows.find((r) => r.id === sid);
  if (s && s.posted === 1 && s.discord_msg && c.discord_thread) await discord(env, 'PATCH', `/channels/${c.discord_thread}/messages/${s.discord_msg}`, sessionMessage(c, s, rows)).catch((e) => console.log('session msg sync failed', e && e.message));
}
// Sitzungen, die in höchstens einer Woche stattfinden, im Thread posten (alle 20 Minuten und direkt nach Änderungen).
export async function postDueSessions(env, onlyId = null) {
  if (!env.DISCORD_BOT_TOKEN) return 0;
  await ensureCampaigns(env);
  const today = berlinToday();
  const { results } = await env.DB.prepare(`SELECT s.id FROM campaign_sessions s JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.posted = 0 AND s.cancelled = 0 AND s.date >= ?1 AND s.date <= ?2 AND c.status = 'active' AND c.discord_thread IS NOT NULL ${onlyId ? 'AND c.id = ?3' : ''} ORDER BY s.date LIMIT 10`)
    .bind(...[today, addDays(today, POST_DAYS), ...(onlyId ? [onlyId] : [])]).all();
  let n = 0;
  for (const { id } of results) {
    const s = await getSession(env, id); const c = s && (await getCamp(env, s.campaign_id)); if (!c) continue;
    // Erst als gepostet markieren (gegen doppelte Posts bei gleichzeitigen Läufen), dann posten.
    const u = await env.DB.prepare('UPDATE campaign_sessions SET posted = 1 WHERE id = ?1 AND posted = 0').bind(id).run();
    if (!u.meta.changes) continue;
    const rows = await getSessions(env, c.id), cur = rows.find((r) => r.id === id);
    const body = sessionMessage(c, cur, rows);
    try {
      const msg = await toThread(env, c, { ...body, allowed_mentions: { users: people(c).map((x) => x.id).slice(0, 100) } });
      await env.DB.prepare('UPDATE campaign_sessions SET discord_msg = ?1 WHERE id = ?2').bind(msg.id, id).run(); n++;
    } catch (e) { console.log('session post failed', e && e.message); await env.DB.prepare('UPDATE campaign_sessions SET posted = 0 WHERE id = ?1').bind(id).run(); }
  }
  return n;
}
// Nach dem Übernehmen eines Vorschlags: Abstimmungs-Nachricht abschließen, Sitzungspost anpassen oder neu posten, alle informieren.
async function announceApplied(env, c, s) {
  const a = s._applied; if (!a || !c.discord_thread || !env.DISCORD_BOT_TOKEN) return;
  const rows = await getSessions(env, c.id), cur = rows.find((r) => r.id === s.id) || s;
  const doneTxt = appliedText(a);
  if (a.msg) await discord(env, 'PATCH', `/channels/${c.discord_thread}/messages/${a.msg}`, propMessage(c, cur, rows, a, { from: a.from, n: a.n, done: doneTxt })).catch(() => {});
  if (a.kind === 'x') { if (a.oldMsg) await discord(env, 'PATCH', `/channels/${c.discord_thread}/messages/${a.oldMsg}`, { content: `~~Sitzung ${a.n}: ${c.game}, ${when(a.from.date, a.from.time)}~~ – fällt aus.`, embeds: [], components: [], allowed_mentions: { parse: [] } }).catch(() => {}); }
  else if (a.far && a.oldMsg) await discord(env, 'DELETE', `/channels/${c.discord_thread}/messages/${a.oldMsg}`).catch(() => {});
  else if (cur.discord_msg) await discord(env, 'PATCH', `/channels/${c.discord_thread}/messages/${cur.discord_msg}`, sessionMessage(c, cur, rows)).catch(() => {});
  const ids = people(c).map((x) => x.id);
  await toThread(env, c, { content: `${ids.map((x) => `<@${x}>`).join(' ')} ${doneTxt}${a.kind === 'x' ? '' : ` (vorher ${when(a.from.date, a.from.time)})`}`, allowed_mentions: { users: ids.slice(0, 100) } }).catch((e) => console.log('applied post failed', e && e.message));
  await postDueSessions(env, c.id);
  await syncCampaign(env, c.id);
}
const appliedText = (a) => (a.kind === 'x' ? `❌ Sitzung ${a.n} am **${when(a.from.date, a.from.time)}** fällt aus.` : `✅ Verschoben: Sitzung ${a.n} ist jetzt am **${when(a.date, a.time)}**.`);
// Neuen Vorschlag im Thread posten (ein ersetzter Vorschlag wird durchgestrichen).
async function announceProp(env, c, sid) {
  if (!c.discord_thread || !env.DISCORD_BOT_TOKEN) return;
  const rows = await getSessions(env, c.id), s = rows.find((r) => r.id === sid); if (!s) return;
  const p = J(s.prop, null); if (!p) return;
  if (p.old) await discord(env, 'PATCH', `/channels/${c.discord_thread}/messages/${p.old}`, { content: '~~Älterer Vorschlag~~ – durch einen neuen ersetzt.', embeds: [], components: [] }).catch(() => {});
  const msg = await toThread(env, c, propMessage(c, s, rows, p, { ping: true }));
  p.msg = msg.id; delete p.old;
  await env.DB.prepare('UPDATE campaign_sessions SET prop = ?1 WHERE id = ?2 AND prop = ?3').bind(JSON.stringify(p), sid, s.prop).run();
  await syncSession(env, c, sid);
}
async function refreshProp(env, c, sid, done) {
  if (!c.discord_thread || !env.DISCORD_BOT_TOKEN) return;
  const rows = await getSessions(env, c.id), s = rows.find((r) => r.id === sid); if (!s) return;
  const p = done ? done.prop : J(s.prop, null); if (!p || !p.msg) return;
  await discord(env, 'PATCH', `/channels/${c.discord_thread}/messages/${p.msg}`, propMessage(c, s, rows, p, done ? { done: done.text } : null)).catch((e) => console.log('prop sync failed', e && e.message));
  await syncSession(env, c, sid);
}
// Kampagne beenden: Post entfernen; Thread mit Abschlussnachricht schließen (oder löschen, wenn noch nichts gespielt wurde).
async function closeCampaignDiscord(env, c, rows, text, removePost) {
  if (!env.DISCORD_BOT_TOKEN) return;
  const played = rows.some((r) => r.date < berlinToday());
  if (c.discord_msg) {
    if (removePost) await discord(env, 'DELETE', `/channels/${c.discord_channel}/messages/${c.discord_msg}`).catch((e) => console.log('campaign msg delete failed', e && e.message));
    else await discord(env, 'PATCH', `/channels/${c.discord_channel}/messages/${c.discord_msg}`, { content: `${ICON} Kampagne **${c.game}** von **${c.host_name}**: ${text}`, embeds: [], components: [], allowed_mentions: { parse: [] } }).catch(() => {});
  }
  if (!c.discord_thread) return;
  const ids = people(c).map((x) => x.id);
  if (!played && removePost) {
    await discord(env, 'DELETE', `/channels/${c.discord_thread}`).catch((e) => console.log('campaign thread delete failed', e && e.message));
    for (const id of ids.filter((x) => x !== c.host_discord).slice(0, 30)) {
      try { const dm = await discord(env, 'POST', '/users/@me/channels', { recipient_id: id }); await discord(env, 'POST', `/channels/${dm.id}/messages`, { content: `${ICON} Die Kampagne **${c.game}** von **${c.host_name}** wurde abgesagt.`, allowed_mentions: { parse: [] } }); }
      catch (e) { console.log('campaign dm failed', e && e.message); }
    }
  } else {
    await toThread(env, c, { content: `${ids.map((x) => `<@${x}>`).join(' ')} ${text}`, allowed_mentions: { users: ids.slice(0, 100) } }).catch(() => {});
    await discord(env, 'PATCH', `/channels/${c.discord_thread}`, { archived: true, locked: true }).catch((e) => console.log('campaign thread close failed', e && e.message));
  }
  await env.DB.prepare('UPDATE campaigns SET thread_state = ?1 WHERE id = ?2').bind(JSON.stringify({ ...thState(c), a: 1 }), c.id).run();
}

// Nächtlich: vorbeigegangene Sitzungen abschließen (Knöpfe weg, Vorschläge verfallen), fertige Kampagnen schließen.
export async function tidyCampaigns(env) {
  await ensureCampaigns(env);
  const today = berlinToday();
  const { results } = await env.DB.prepare(`SELECT s.*, c.discord_thread AS th FROM campaign_sessions s JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.date < ?1 AND (s.posted = 1 OR s.prop IS NOT NULL) LIMIT 40`).bind(today).all();
  for (const s of results) {
    const p = J(s.prop, null);
    await env.DB.prepare('UPDATE campaign_sessions SET posted = CASE WHEN posted = 1 THEN 2 ELSE posted END, prop = NULL WHERE id = ?1').bind(s.id).run();
    if (!env.DISCORD_BOT_TOKEN || !s.th) continue;
    const c = await getCamp(env, s.campaign_id); if (!c) continue;
    const rows = await getSessions(env, c.id), cur = rows.find((r) => r.id === s.id);
    if (s.posted === 1 && s.discord_msg) await discord(env, 'PATCH', `/channels/${s.th}/messages/${s.discord_msg}`, sessionMessage(c, cur, rows)).catch(() => {});
    if (p && p.msg) await discord(env, 'PATCH', `/channels/${s.th}/messages/${p.msg}`, propMessage(c, cur, rows, p, { done: 'Abgelaufen: Die Sitzung ist vorbei.' })).catch(() => {});
  }
  // Fertig: letzte Sitzung liegt mehr als DONE_DAYS Tage zurück.
  const { results: fin } = await env.DB.prepare(`SELECT c.* FROM campaigns c WHERE c.status = 'active'
    AND c.start_date != '' AND NOT EXISTS (SELECT 1 FROM campaign_sessions s WHERE s.campaign_id = c.id AND s.cancelled = 0 AND s.date >= ?1) LIMIT 20`).bind(addDays(today, -DONE_DAYS)).all();
  for (const c of fin) {
    await env.DB.prepare("UPDATE campaigns SET status = 'ended', ended_at = ?1, outcome = 'done' WHERE id = ?2 AND status = 'active'").bind(new Date().toISOString(), c.id).run();
    const rows = await getSessions(env, c.id);
    await closeCampaignDiscord(env, c, rows, 'Die Kampagne ist abgeschlossen. Danke fürs Mitspielen! 🎉\n' + statsText(await campStats(env, c, rows)), false);
  }
  return results.length + fin.length;
}

// Für die Übersicht im Runden-Kanal: Kampagnen mit freien Plätzen.
export async function openCampaignCount(env) {
  await ensureCampaigns(env);
  const { results } = await env.DB.prepare(`SELECT c.* FROM campaigns c WHERE c.status = 'active' AND c.open = 1
    AND (c.start_date = '' OR EXISTS (SELECT 1 FROM campaign_sessions s WHERE s.campaign_id = c.id AND s.cancelled = 0 AND s.date >= ?1))`).bind(berlinToday()).all();
  return results.filter((c) => free(c) > 0).length;
}

// ---------- Termine anlegen / nach Änderungen neu berechnen ----------
async function insertSessions(env, cid, dates, time) {
  for (const d of dates) await env.DB.prepare('INSERT INTO campaign_sessions(id, campaign_id, planned, date, time) VALUES(?1,?2,?3,?3,?4)').bind(newId(), cid, d, time).run();
}
// Gibt eine Liste geänderter Discord-Nachrichten zurück, die gelöscht werden sollen.
async function reschedule(env, c, next) {
  const today = berlinToday(), rows = (await getSessions(env, c.id)).sort((a, b) => a.planned.localeCompare(b.planned));
  const past = rows.filter((r) => r.date < today), fut = rows.filter((r) => r.date >= today), drop = [];
  const lastPast = past.reduce((m, r) => (r.planned > m ? r.planned : m), addDays(today, -1));
  const ruleChanged = next.start !== c.start_date || JSON.stringify(next.rule) !== c.rule;
  if (ruleChanged) {
    const dates = !next.rule ? [] : ruleDates(next.rule, next.start, Math.max(0, next.count - past.length), lastPast);
    for (let i = 0; i < fut.length; i++) {
      const r = fut[i];
      if (i >= dates.length) { await env.DB.prepare('DELETE FROM campaign_sessions WHERE id = ?1').bind(r.id).run(); if (r.discord_msg) drop.push(r.discord_msg); continue; }
      const same = r.date === dates[i] && r.time === next.time;
      if (same) { await env.DB.prepare('UPDATE campaign_sessions SET planned = ?1 WHERE id = ?2').bind(dates[i], r.id).run(); continue; }
      await env.DB.prepare("UPDATE campaign_sessions SET planned = ?1, date = ?1, time = ?2, prop = NULL, absent = '[]', posted = 0, discord_msg = NULL WHERE id = ?3").bind(dates[i], next.time, r.id).run();
      if (r.discord_msg) drop.push(r.discord_msg);
      const p = J(r.prop, null); if (p && p.msg) drop.push(p.msg);
    }
    await insertSessions(env, c.id, dates.slice(fut.length), next.time);
  } else {
    if (next.time !== c.time) {
      // Neue Uhrzeit für alle kommenden Sitzungen, die nicht einzeln verschoben wurden.
      await env.DB.prepare('UPDATE campaign_sessions SET time = ?1 WHERE campaign_id = ?2 AND date >= ?3 AND time = ?4 AND date = planned').bind(next.time, c.id, today, c.time).run();
    }
    const total = rows.length;
    if (!next.rule) { /* Termin noch offen: keine Sitzungen */ }
    else if (next.count > total) {
      const last = rows.length ? rows[rows.length - 1].planned : '';
      await insertSessions(env, c.id, ruleDates(next.rule, next.start, next.count - total, last), next.time);
    } else if (next.count < total) {
      const del = fut.slice(Math.max(0, fut.length - (total - Math.max(next.count, past.length))));
      for (const r of del) { await env.DB.prepare('DELETE FROM campaign_sessions WHERE id = ?1').bind(r.id).run(); if (r.discord_msg) drop.push(r.discord_msg); const p = J(r.prop, null); if (p && p.msg) drop.push(p.msg); }
    }
  }
  return drop;
}

// Eingaben für Anlegen/Bearbeiten prüfen. Gibt { err } oder die Werte zurück.
function readInput(b, old) {
  const game = str(b.game, 120) || (old && old.game);
  // tbd: Start und Rhythmus stehen noch nicht fest (später beim Bearbeiten festlegen).
  const later = !!b.tbd;
  const start = later ? '' : str(b.start, 10), time = str(b.time, 5) || '18:00', rule = later ? null : cleanRule(b.rule), count = int(b.sessions), seats = int(b.seats);
  const duration = b.duration == null || b.duration === '' ? null : int(b.duration);
  if (!game || !isTime(time) || (!later && (!isDate(start) || !rule))) return { err: 'invalid' };
  if (!(count >= 1 && count <= MAX_SESSIONS)) return { err: 'invalid' };
  if (!(seats >= 2 && seats <= 20)) return { err: 'invalid' };
  if (duration != null && !(duration >= 30 && duration <= 720)) return { err: 'invalid' };
  if (!later && !ruleDates(rule, start, 1).length) return { err: 'invalid' };
  return { game, gameId: b.gameId === undefined && old ? old.game_id : int(b.gameId), year: b.year === undefined && old ? old.year : int(b.year), start, time, rule, count, seats, duration, note: str(b.note, 500), open: b.open === undefined ? 1 : b.open ? 1 : 0 };
}

// ---------- Partien zu Sitzungen ----------
// Eine eingetragene Partie gehört zur Sitzung (Eintragen aus der Sitzung heraus, wie bei Runden).
export async function linkSessionPlay(env, sid, pid) {
  await ensureCampaigns(env);
  const r = await env.DB.prepare('UPDATE campaign_sessions SET play_id = ?1 WHERE id = ?2 AND play_id IS NULL').bind(pid, sid).run();
  return !!r.meta.changes;
}
// Ohne Bezug eingetragen (z. B. per QR-Code): Partie desselben Spiels am Sitzungstag oder am Tag danach gilt für die Sitzung.
export async function linkCampaignPlays(env) {
  await ensureCampaigns(env);
  const today = berlinToday();
  const { results } = await env.DB.prepare(`SELECT s.id AS sid, (
      SELECT pl.id FROM plays pl WHERE pl.date >= s.date AND pl.date <= date(s.date, '+1 day')
        AND ((pl.game_id IS NOT NULL AND pl.game_id = c.game_id) OR lower(trim(pl.game)) = lower(trim(c.game)))
        AND NOT EXISTS (SELECT 1 FROM parties o WHERE o.play_id = pl.id) AND NOT EXISTS (SELECT 1 FROM campaign_sessions o WHERE o.play_id = pl.id)
      ORDER BY pl.date, pl.created_at LIMIT 1) AS play
    FROM campaign_sessions s JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.play_id IS NULL AND s.cancelled = 0 AND s.date >= ?1 AND s.date <= ?2 ORDER BY s.date LIMIT 60`).bind(addDays(today, -30), today).all();
  let n = 0; const used = new Set();
  for (const r of results) { if (!r.play || used.has(r.play)) continue; if (await linkSessionPlay(env, r.sid, r.play)) { used.add(r.play); n++; } }
  return n;
}
// Statistik einer (beendeten) Kampagne.
export async function campStats(env, c, rows) {
  const today = berlinToday(), played = rows.filter((r) => r.date < today || r.play_id);
  const cancelled = (await env.DB.prepare('SELECT COUNT(*) AS n FROM campaign_sessions WHERE campaign_id = ?1 AND cancelled = 1').bind(c.id).first()).n;
  const ids = played.map((r) => r.play_id).filter(Boolean);
  let plays = [];
  if (ids.length) plays = (await env.DB.prepare(`SELECT id, duration, winner, players FROM plays WHERE id IN (${ids.map((_, i) => '?' + (i + 1)).join(',')})`).bind(...ids).all()).results;
  const minutes = plays.reduce((a, p) => a + (Number(p.duration) || 0), 0), timed = plays.filter((p) => p.duration).length;
  const wins = {};
  for (const p of plays) for (const w of String(p.winner || '').split(/[,;&]| und /).map((x) => x.trim()).filter(Boolean)) wins[w] = (wins[w] || 0) + 1;
  const att = people(c).map((x) => ({ name: x.name, n: played.filter((r) => !J(r.absent, []).includes(x.id)).length }));
  return { played: played.length, logged: plays.length, cancelled, first: played.length ? played[0].date : null, last: played.length ? played[played.length - 1].date : null,
    minutes, avgMinutes: timed ? Math.round(minutes / timed) : null, winners: Object.entries(wins).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, n })), attendance: att };
}
const statsText = (st) => `📊 ${st.played} Sitzung${st.played === 1 ? '' : 'en'} gespielt${st.cancelled ? `, ${st.cancelled} ausgefallen` : ''}${st.first ? ` (${fmtDate(st.first)} bis ${fmtDate(st.last)})` : ''}${st.minutes ? `, zusammen ca. ${Math.round(st.minutes / 60)} Std.` : ''}.${st.winners.length ? ' Meiste Siege: ' + st.winners.slice(0, 3).map((w) => `${w.name} (${w.n})`).join(', ') + '.' : ''}`;

function campOut(env, c, rows, uid, today = berlinToday(), adm = false) {
  const pl = playersOf(c), name = (id) => (id === c.host_discord ? c.host_name : (pl[id] && pl[id].name) || '?');
  const ppl = people(c);
  return {
    id: c.id, game: c.game, gameId: c.game_id, year: c.year, host: c.host_name, start: c.start_date, time: c.time, rule: c.rule ? J(c.rule, null) : null,
    sessions: rows.length, duration: c.duration, seats: c.seats, note: c.note, open: !!c.open, players: ppl.slice(1).map((x) => x.name),
    phase: tbd(c) ? 'new' : phase(rows, today), tbd: tbd(c), plannedSessions: c.sessions, done: rows.filter((r) => r.date < today).length, createdAt: c.created_at, url: tLink(env, c),
    list: rows.map((s) => {
      const p = J(s.prop, null), ab = J(s.absent, []);
      return { id: s.id, date: s.date, time: s.time, playId: s.play_id || null, moved: s.date !== s.planned || s.time !== c.time, absent: ab.map(name),
        prop: p ? { cancel: p.kind === 'x', date: p.date, time: p.time, by: p.name, yes: p.yes.map(name), no: p.no.map(name), open: ppl.filter((x) => !p.yes.includes(x.id) && !p.no.includes(x.id)).map((x) => x.name) } : null,
        you: uid ? { absent: ab.includes(uid), vote: p ? (p.yes.includes(uid) ? 'y' : p.no.includes(uid) ? 'n' : '') : '', mine: !!(p && p.by === uid) } : null };
    }),
    reserved: reservedOf(c).length,
    // Eingeladene: Namen nur für Mitspielende, Schlüssel zum Zurücknehmen nur für Ersteller/Verwaltung.
    invited: adm || isIn(c, uid) ? invOf(c).filter((x) => !isIn(c, x.id)).map((x) => ({ name: x.name || '?', res: !!x.res, ...(adm || uid === c.host_discord ? { k: x.k } : {}) })) : [],
    you: uid ? { host: uid === c.host_discord, in: isIn(c, uid), invited: !isIn(c, uid) && invOf(c).some((x) => x.id === uid), res: !isIn(c, uid) && invOf(c).some((x) => x.id === uid && x.res) } : null,
    ended: c.status !== 'active', endedAt: c.ended_at || null, outcome: c.outcome || null,
  };
}

// ---------- Web-API: /campaigns… ----------
export async function campaignRoute(req, env, ctx, path, m, ip, h) {
  if (!path.startsWith('/campaigns')) return null;
  const { json, fail, body, allow, checkMember, isAdmin } = h;
  await ensureCampaigns(env);
  const bg = (p) => ctx.waitUntil(p.catch((e) => console.log('campaign discord failed', e && e.message)));
  const login = async () => { const u = await checkMember(req, env, ip); return u.err ? { res: fail(u.err === 'rate_limited' ? 429 : 403, u.err) } : u; };
  // Ersteller oder Verwaltung.
  const ownerOrAdmin = async (c) => {
    if (req.headers.has('x-admin-token')) return (await isAdmin(req, env, ip)) ? { admin: true } : { res: fail(403, 'forbidden') };
    const u = await login(); if (u.res) return u;
    return u.member.discord_id === c.host_discord ? u : { res: fail(403, 'forbidden') };
  };
  let g;

  if (path === '/campaigns' && m === 'GET') {
    // Mit Anmeldung: pro Kampagne/Sitzung, ob man selbst dabei ist, abgestimmt hat usw. (ohne Discord-IDs in der Antwort).
    let uid = null;
    if (req.headers.get('x-session')) { const u = await checkMember(req, env, ip); if (!u.err) uid = u.member.discord_id; }
    const adm = req.headers.has('x-admin-token') && (await isAdmin(req, env, ip));
    const today = berlinToday();
    // Aktive Kampagnen und die beendeten des letzten Jahres (mit Statistik).
    const { results } = await env.DB.prepare("SELECT * FROM campaigns WHERE status = 'active' OR (status != 'active' AND ended_at >= ?1) ORDER BY start_date LIMIT 150").bind(addDays(today, -365)).all();
    const out = [];
    for (const c of results) {
      const rows = await getSessions(env, c.id), o = campOut(env, c, rows, uid, today, adm);
      if (o.ended) o.stats = await campStats(env, c, rows);
      out.push(o);
    }
    return json(out);
  }
  if (path === '/campaigns' && m === 'POST') {
    const u = await login(); if (u.res) return u.res;
    // Kampagnen anlegen dürfen nur Mitglieder (wie „Spiele gesucht“). Mitmachen können alle nach den üblichen Regeln.
    if (!isMember(await getBooking(env), u.member.roles)) return fail(403, 'members_only');
    const b = await body(req), v = readInput(b, null); if (v.err) return fail(400, v.err);
    if (v.start && v.start < berlinToday()) return fail(400, 'past');
    const used = (await env.DB.prepare('SELECT COUNT(*) AS n FROM campaigns WHERE host_discord = ?1 AND created_at > ?2').bind(u.member.discord_id, new Date(Date.now() - 864e5).toISOString()).first()).n;
    if (used >= 3 || !(await allow(env, 'camp-all', 20, 86400))) return fail(429, 'rate_limited');
    const id = newId();
    await env.DB.prepare('INSERT INTO campaigns(id, game, game_id, year, host_discord, host_name, start_date, time, rule, sessions, duration, seats, note, open, players, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,\'{}\',?15)')
      .bind(id, v.game, v.gameId, v.year, u.member.discord_id, u.member.name, v.start, v.time, v.rule ? JSON.stringify(v.rule) : '', v.count, v.duration, v.seats, v.note, v.open, new Date().toISOString()).run();
    if (v.rule) await insertSessions(env, id, ruleDates(v.rule, v.start, v.count), v.time);
    if (dcOn(env)) bg(announceCampaign(env, id));
    return json(campOut(env, await getCamp(env, id), await getSessions(env, id), u.member.discord_id));
  }
  if ((g = path.match(/^\/campaigns\/([\w-]+)$/)) && m === 'PUT') {
    const c = await getCamp(env, g[1]); if (!c || c.status !== 'active') return fail(404, 'not_found');
    const who = await ownerOrAdmin(c); if (who.res) return who.res;
    const b = await body(req), v = readInput(b, c); if (v.err) return fail(400, v.err);
    if (v.seats < people(c).length + reservedOf(c).length) return fail(400, 'seats_taken');
    const hadPast = (await getSessions(env, c.id)).some((r) => r.date < berlinToday());
    if (!v.rule && hadPast) return fail(400, 'started');
    if (v.start && v.start !== c.start_date && v.start < berlinToday() && !(await getSessions(env, c.id)).some((r) => r.date < berlinToday())) return fail(400, 'past');
    const drop = await reschedule(env, c, v);
    const same = v.game === c.game;
    await env.DB.prepare('UPDATE campaigns SET game = ?1, game_id = ?2, year = ?3, start_date = ?4, time = ?5, rule = ?6, sessions = ?7, duration = ?8, seats = ?9, note = ?10, open = ?11 WHERE id = ?12')
      .bind(v.game, same && b.gameId === undefined ? c.game_id : v.gameId, same && b.year === undefined ? c.year : v.year, v.start, v.time, v.rule ? JSON.stringify(v.rule) : '', v.count, v.duration, v.seats, v.note, v.open, c.id).run();
    if (env.DISCORD_BOT_TOKEN) bg((async () => {
      for (const mid of drop) if (c.discord_thread) await discord(env, 'DELETE', `/channels/${c.discord_thread}/messages/${mid}`).catch(() => {});
      const fresh = await getCamp(env, c.id);
      if (fresh.discord_thread && (drop.length || v.start !== c.start_date || v.time !== c.time || v.count !== c.sessions)) {
        const rows = await getSessions(env, c.id), nx = rows.find((r) => r.date >= berlinToday()), ids = people(fresh).map((x) => x.id);
        await toThread(env, fresh, { content: `${ids.map((x) => `<@${x}>`).join(' ')} 📝 Der Plan wurde geändert: ${rhythmText(v.rule, v.start)}${v.rule ? `, ${v.time} Uhr, ca. ${rows.length} Sitzungen` : ''}.${nx ? ` Nächste Sitzung: ${when(nx.date, nx.time)}.` : ''}`, allowed_mentions: { users: ids.slice(0, 100) } }).catch(() => {});
      }
      await postDueSessions(env, c.id);
      await syncCampaign(env, c.id);
    })());
    return json({ ok: true });
  }
  // Beenden (Standard): bleibt mit Statistik unter „Beendete Kampagnen“. Mit ?purge=1 ganz löschen (Partien bleiben in der Statistik).
  if ((g = path.match(/^\/campaigns\/([\w-]+)$/)) && m === 'DELETE') {
    const c = await getCamp(env, g[1]); if (!c) return json({ ok: true });
    const who = await ownerOrAdmin(c); if (who.res) return who.res;
    // outcome: 'done' = zu Ende gespielt, 'aborted' = abgebrochen (Abfrage beim Beenden).
    const qs = new URL(req.url).searchParams, purge = qs.get('purge') === '1', today = berlinToday(), outcome = qs.get('outcome') === 'done' ? 'done' : 'aborted';
    if (c.status === 'active') {
      // Künftige Sitzungen fallen weg; heute und früher bleiben (für Eintragen und Statistik).
      await env.DB.prepare('DELETE FROM campaign_sessions WHERE campaign_id = ?1 AND date > ?2 AND play_id IS NULL').bind(c.id, today).run();
      await env.DB.prepare("UPDATE campaigns SET status = 'ended', ended_at = ?1, outcome = ?2 WHERE id = ?3").bind(new Date().toISOString(), outcome, c.id).run();
      const rows = await getSessions(env, c.id), by = who.admin ? 'der Verwaltung' : c.host_name;
      const txt = purge ? `Die Kampagne wurde von ${by} gelöscht.` : outcome === 'done' ? `🎉 Zu Ende gespielt! ${by} hat die Kampagne abgeschlossen. Danke fürs Mitspielen!` : `Die Kampagne wurde von ${by} abgebrochen.`;
      const full = txt + (rows.some((r) => r.date < today) ? '\n' + statsText(await campStats(env, c, rows)) : '');
      if (env.DISCORD_BOT_TOKEN) bg(closeCampaignDiscord(env, c, rows, full, true));
    }
    if (purge) {
      await env.DB.prepare('DELETE FROM campaign_sessions WHERE campaign_id = ?1').bind(c.id).run();
      await env.DB.prepare('DELETE FROM campaigns WHERE id = ?1').bind(c.id).run();
    }
    return json({ ok: true });
  }
  if ((g = path.match(/^\/campaigns\/([\w-]+)\/(join|leave)$/)) && m === 'POST') {
    const u = await login(); if (u.res) return u.res;
    if (!(await allow(env, 'camp:' + u.member.discord_id, 60, 3600))) return fail(429, 'rate_limited');
    const c = await getCamp(env, g[1]); if (!c) return fail(404, 'not_found');
    const uid = u.member.discord_id;
    if (g[2] === 'join') {
      const err = await joinCheck(env, c, await getSessions(env, c.id), u.member.roles, uid); if (err) return fail(err === 'members_only' || err === 'guests_paused' ? 403 : 409, err);
      const e2 = await addPlayer(env, c, uid, u.member.name, isMember(await getBooking(env), u.member.roles));
      if (e2 === 'changed') return fail(409, 'changed');
      if (c._accepted && env.DISCORD_BOT_TOKEN) { const x = c._accepted; bg((async () => { await closeInviteDm(env, x, `${ICON} Du bist bei der Kampagne **${c.game}** dabei ✓`); await threadNote(env, await getCamp(env, c.id), `✅ **${u.member.name}** hat die Einladung angenommen.`); })()); }
    } else {
      if (uid === c.host_discord) return fail(400, 'host');
      const e2 = await removePlayer(env, c, uid); if (e2) return fail(409, e2);
    }
    if (env.DISCORD_BOT_TOKEN) bg(syncCampaign(env, c.id));
    return json({ ok: true });
  }
  // Einladung ablehnen (eingeladene Person) bzw. zurücknehmen (Ersteller/Verwaltung, per Schlüssel k).
  if ((g = path.match(/^\/campaigns\/([\w-]+)\/decline$/)) && m === 'POST') {
    const u = await login(); if (u.res) return u.res;
    const c = await getCamp(env, g[1]); if (!c) return fail(404, 'not_found');
    await dropInvite(env, c, (x) => x.id === u.member.discord_id, null);
    return json({ ok: true });
  }
  if ((g = path.match(/^\/campaigns\/([\w-]+)\/invited\/([\w-]+)$/)) && m === 'DELETE') {
    const c = await getCamp(env, g[1]); if (!c) return fail(404, 'not_found');
    const who = await ownerOrAdmin(c); if (who.res) return who.res;
    await dropInvite(env, c, (x) => x.k === g[2], who.admin ? 'Die Verwaltung' : c.host_name);
    return json({ ok: true });
  }
  // Sitzungen: /campaigns/s/:sid/(absent|propose|vote|accept)
  if ((g = path.match(/^\/campaigns\/s\/([\w-]+)\/(absent|propose|vote|accept)$/)) && (m === 'POST' || (m === 'DELETE' && g[2] === 'propose'))) {
    const s = await getSession(env, g[1]); if (!s) return fail(404, 'not_found');
    const c = await getCamp(env, s.campaign_id); if (!c || c.status !== 'active') return fail(404, 'not_found');
    const act = g[2];
    let adm = false;
    if (req.headers.has('x-admin-token')) { if (!(await isAdmin(req, env, ip))) return fail(403, 'forbidden'); adm = true; }
    let u = null;
    if (!adm) { u = await login(); if (u.res) return u.res; if (!(await allow(env, 'camp:' + u.member.discord_id, 60, 3600))) return fail(429, 'rate_limited'); }
    const uid = u ? u.member.discord_id : null, host = adm || uid === c.host_discord;
    if (!adm && !isIn(c, uid)) return fail(403, 'not_in');
    const b = m === 'POST' ? await body(req) : {};
    if (act === 'absent') {
      if (adm) return fail(400, 'invalid');
      if (s.date < berlinToday()) return fail(400, 'past_session');
      const ab = J(s.absent, []).filter((x) => x !== uid); if (b.on !== false) ab.push(uid);
      await env.DB.prepare('UPDATE campaign_sessions SET absent = ?1 WHERE id = ?2').bind(JSON.stringify(ab), s.id).run();
      if (env.DISCORD_BOT_TOKEN) bg(syncSession(env, c, s.id));
      return json({ ok: true });
    }
    if (act === 'propose' && m === 'DELETE') {
      const p = J(s.prop, null); if (!p) return json({ ok: true });
      if (!host && p.by !== uid) return fail(403, 'forbidden');
      await env.DB.prepare('UPDATE campaign_sessions SET prop = NULL WHERE id = ?1').bind(s.id).run();
      if (env.DISCORD_BOT_TOKEN) bg(refreshProp(env, c, s.id, { prop: p, text: p.by === uid ? 'Zurückgezogen.' : `Abgelehnt von ${adm ? 'der Verwaltung' : c.host_name}.` }));
      return json({ ok: true });
    }
    if (act === 'propose') {
      const user = adm ? { id: c.host_discord, name: c.host_name } : { id: uid, name: u.member.name };
      const r = await propose(env, c, s, user, str(b.date, 10), str(b.time, 5), !!b.cancel); if (r.err) return fail(400, r.err);
      // Ersteller/Verwaltung kann direkt übernehmen.
      if (host && b.apply) {
        const cur = await getSession(env, s.id);
        if (await applyProp(env, c, cur)) { if (env.DISCORD_BOT_TOKEN) bg(announceApplied(env, c, cur)); return json({ ok: true, applied: true }); }
        return fail(409, 'changed');
      }
      // Allein in der Kampagne: gleich übernehmen.
      if (people(c).length === 1) { const cur = await getSession(env, s.id); if (await applyProp(env, c, cur)) { if (env.DISCORD_BOT_TOKEN) bg(announceApplied(env, c, cur)); return json({ ok: true, applied: true }); } }
      if (env.DISCORD_BOT_TOKEN) bg(announceProp(env, c, s.id));
      return json({ ok: true, applied: false });
    }
    if (act === 'vote') {
      if (adm) return fail(400, 'invalid');
      const r = await vote(env, c, s, uid, b.yes !== false); if (r.err) return fail(409, r.err);
      if (env.DISCORD_BOT_TOKEN) bg(r.applied ? announceApplied(env, c, { ...s, _applied: r.ap }) : refreshProp(env, c, s.id));
      return json({ ok: true, applied: r.applied });
    }
    if (act === 'accept') {
      if (!host) return fail(403, 'forbidden');
      if (!J(s.prop, null)) return fail(409, 'no_prop');
      if (!(await applyProp(env, c, s))) return fail(409, 'changed');
      if (env.DISCORD_BOT_TOKEN) bg(announceApplied(env, c, s));
      return json({ ok: true, applied: true });
    }
  }
  return fail(404, 'not_found');
}
// ---------- Discord-Knöpfe ----------
const ERR = {
  ended: 'Diese Kampagne ist schon vorbei.', closed: 'Die Kampagne sucht gerade niemanden mehr.', full: 'Leider sind schon alle Plätze belegt.',
  not_in: 'Das geht nur für Leute, die bei der Kampagne mitmachen.', past_session: 'Diese Sitzung ist schon vorbei.', bad_date: 'Datum nicht verstanden oder in der Vergangenheit. Beispiele: 2026-11-17, 17.11.',
  bad_time: 'Uhrzeit bitte als HH:MM, z. B. 18:00.', same: 'Das ist schon der aktuelle Termin.', no_prop: 'Es gibt keinen offenen Vorschlag mehr.', changed: 'Gerade hat sich etwas geändert. Bitte noch einmal klicken.',
};
export async function campaignButton(i, env, ctx) {
  await ensureCampaigns(env);
  const [act, id, arg] = String(i.data.custom_id).split(':'), w = who(i), roles = (i.member && i.member.roles) || [];
  const inDm = !i.guild_id; // Knöpfe in der Einladung per Direktnachricht
  const perms = BigInt((i.member && i.member.permissions) || '0'), mod = (perms & 0x20n) !== 0n || (perms & 0x8n) !== 0n;
  const later = (p) => ctx.waitUntil(p.catch((e) => console.log('campaign discord failed', e && e.message)));
  if (act === 'campj' || act === 'campl') {
    const c = await getCamp(env, id); if (!c || c.status !== 'active') return say('Diese Kampagne gibt es nicht mehr.');
    if (act === 'campj') {
      if (isIn(c, w.id)) return say('Du bist schon dabei.');
      const rule = await getBooking(env), err = await joinCheck(env, c, await getSessions(env, c.id), roles, w.id);
      if (err === 'members_only') return say(`${tbd(c) ? 'Die Termine dieser Kampagne stehen noch nicht fest.' : `Nicht alle Sitzungen dieser Kampagne liegen an Stammtisch-Tagen (${stmText(rule)}).`} Mitmachen können dann nur Mitglieder (mit der Mitgliederrolle) oder wer eingeladen wurde.`);
      if (err === 'guests_paused') return say(pauseText(rule));
      if (err) return say(ERR[err]);
      const e2 = await addPlayer(env, c, w.id, w.name, isMember(rule, roles)); if (e2) return say(e2 === 'already' ? 'Du bist schon dabei.' : ERR.changed);
    } else {
      if (w.id === c.host_discord) return say('Als Ersteller kannst du nicht aussteigen. Beenden kannst du die Kampagne auf der Webseite.');
      if (!isIn(c, w.id)) return say('Du bist nicht dabei.');
      const e2 = await removePlayer(env, c, w.id); if (e2) return say(ERR.changed);
    }
    const fresh = await getCamp(env, id), rows = await getSessions(env, id);
    if (act === 'campj' && c._accepted) { const x = c._accepted; later((async () => { if (!inDm) await closeInviteDm(env, x, `${ICON} Du bist bei der Kampagne **${c.game}** dabei ✓`); await threadNote(env, await getCamp(env, c.id), `✅ **${w.name}** hat die Einladung angenommen.`); })()); }
    // Einladung per Direktnachricht: die Nachricht selbst ändern (Knöpfe weg).
    if (inDm) {
      later(syncCampaign(env, id));
      return reply({ type: 7, data: { content: `${ICON} Du bist bei der Kampagne **${c.game}** dabei ✓ Du wurdest zum privaten Thread der Kampagne hinzugefügt.`, components: [] } });
    }
    // Knopf an einer Einladung (nicht am Post der Kampagne): Post im Hintergrund aktualisieren, nur kurz antworten.
    if (i.message && i.message.id !== c.discord_msg) {
      later(syncCampaign(env, id));
      return say(act === 'campj' ? `Du bist dabei ✓ Du wurdest zum privaten Thread der Kampagne **${c.game}** hinzugefügt.` : 'Du bist ausgestiegen.');
    }
    later((async () => { await syncThread(env, fresh); for (const s of rows) if (s.posted === 1) await syncSession(env, fresh, s.id); })());
    return reply({ type: 7, data: campaignMessage(fresh, rows, env) });
  }
  if (act === 'campd') {
    const c = await getCamp(env, id);
    const x = c ? await dropInvite(env, c, (y) => y.id === w.id, null) : null;
    return reply({ type: 7, data: { content: x ? `${ICON} Du hast die Einladung zur Kampagne **${c.game}** abgelehnt.` : `${ICON} Diese Einladung gilt nicht mehr.`, components: [] } });
  }
  if (['campi', 'campu', 'campt', 'campk'].includes(act)) {
    const c = await getCamp(env, id); if (!c || c.status !== 'active') return say('Diese Kampagne gibt es nicht mehr.');
    if (!isIn(c, w.id) && !mod) return say('Einladen können nur Leute, die bei der Kampagne mitmachen.');
    const host = mod || w.id === c.host_discord;
    // Auswahlmenü (nur für dich sichtbar): Personen wählen, Platz reservieren an/aus, als Ersteller Einladungen zurücknehmen.
    const menu = (cc, res, note) => {
      const inv = invOf(cc).filter((x) => !isIn(cc, x.id)), fr = free(cc);
      const rows = [
        { type: 1, components: [{ type: 5, custom_id: `campu:${cc.id}:${res ? 1 : 0}`, placeholder: 'Personen einladen …', min_values: 1, max_values: 10 }] },
        { type: 1, components: [{ type: 2, style: res ? 3 : 2, label: res ? 'Platz reservieren: an' : 'Platz reservieren: aus', emoji: { name: res ? '🪑' : '➖' }, custom_id: `campt:${cc.id}:${res ? 0 : 1}` }] },
      ];
      if (host && inv.length) rows.push({ type: 1, components: [{ type: 3, custom_id: 'campk:' + cc.id, placeholder: 'Einladung zurücknehmen …', min_values: 1, max_values: Math.min(25, inv.length),
        options: inv.slice(0, 25).map((x) => ({ label: (x.name || 'Unbekannt').slice(0, 80), value: x.k, description: x.res ? 'Platz reserviert' : 'ohne Reservierung' })) }] });
      return { flags: 64, content: (note ? note + '\n\n' : '') + `Wen möchtest du zur Kampagne **${cc.game}** einladen? Die Einladung kommt als private Nachricht vom Bot, im Kanal sieht sie niemand. ` +
        (res ? `Mit „Platz reservieren: an“ hält die Kampagne für jede eingeladene Person einen Platz frei, bis sie zusagt, ablehnt oder ${cc.host_name} die Einladung zurücknimmt (noch ${fr} frei).` : 'Ohne Reservierung kann die Person mitmachen, solange ein Platz frei ist.') +
        (inv.length ? `\nEingeladen: ${inv.map((x) => (x.name || '?') + (x.res ? ' 🪑' : '')).join(', ')}` : ''), components: rows, allowed_mentions: { parse: [] } };
    };
    if (act === 'campi') return reply({ type: 4, data: menu(c, true) });
    if (act === 'campt') return reply({ type: 7, data: menu(c, arg === '1') });
    if (act === 'campk') {
      if (!host) return say(`Einladungen zurücknehmen kann nur ${c.host_name} (Ersteller).`);
      const keys = (i.data.values || []).map(String); let cur = c, n = 0;
      for (const k of keys) { if (await dropInvite(env, cur, (x) => x.k === k, w.name)) n++; cur = await getCamp(env, c.id); }
      return reply({ type: 7, data: menu(cur, true, n ? `Zurückgenommen ✓ (${n})` : 'Nichts geändert.') });
    }
    const res = arg !== '0';
    const users = (i.data.resolved && i.data.resolved.users) || {}, members = (i.data.resolved && i.data.resolved.members) || {};
    const ids = (i.data.values || []).map(String).filter((x) => /^\d{1,25}$/.test(x) && !(users[x] && users[x].bot) && !isIn(c, x)).slice(0, 10);
    if (!ids.length) return reply({ type: 7, data: menu(c, res, 'Niemand Neues ausgewählt (wer schon dabei ist oder ein Bot ist, wird übersprungen).') });
    const inv = invOf(c), newRes = ids.filter((x) => !inv.some((y) => y.id === x && y.res)).length;
    if (res && newRes > free(c)) return reply({ type: 7, data: menu(c, res, `Nur noch ${free(c)} Platz/Plätze frei. Wähle weniger Personen oder lade ohne Reservierung ein.`) });
    const at = new Date().toISOString(), list = [];
    for (const x of ids) {
      const u = users[x] || {}, mb = members[x] || {}, name = str(mb.nick || u.global_name || u.username || '', 40);
      const old = inv.find((y) => y.id === x), e = old || { id: x, k: newId().slice(0, 10) };
      Object.assign(e, { name: name || e.name || '', res: res ? 1 : old ? old.res : 0, by: w.name, at });
      if (!old) inv.push(e); list.push(e);
    }
    await saveInv(env, c, inv);
    later(sendInvites(env, await getCamp(env, c.id), list, w.name));
    return reply({ type: 7, data: menu(await getCamp(env, c.id), res, `Eingeladen ✓ ${list.map((x) => x.name || '?').join(', ')} ${list.length === 1 ? 'bekommt' : 'bekommen'} eine private Nachricht vom Bot${res ? ', ein Platz ist reserviert' : ''}. Im Thread steht es auch.`) });
  }
  const s = await getSession(env, id); if (!s) return say('Diese Sitzung gibt es nicht mehr.');
  const c = await getCamp(env, s.campaign_id); if (!c || c.status !== 'active') return say('Diese Kampagne gibt es nicht mehr.');
  const host = mod || w.id === c.host_discord;
  if (!isIn(c, w.id) && !(mod && (act === 'campa' || act === 'campx'))) return say(ERR.not_in + ' Mitmachen kannst du am Post der Kampagne.');
  if (act === 'camps') {
    if (s.date < berlinToday()) return say(ERR.past_session);
    const ab = J(s.absent, []), on = !ab.includes(w.id), nx = on ? ab.concat(w.id) : ab.filter((x) => x !== w.id);
    await env.DB.prepare('UPDATE campaign_sessions SET absent = ?1 WHERE id = ?2').bind(JSON.stringify(nx), s.id).run();
    const rows = await getSessions(env, c.id);
    return reply({ type: 7, data: sessionMessage(c, rows.find((r) => r.id === s.id), rows) });
  }
  if (act === 'campp') {
    if (s.date < berlinToday()) return say(ERR.past_session);
    const row = (custom_id, label, value, extra = {}) => ({ type: 1, components: [{ type: 4, custom_id, label, style: 1, value: String(value), required: true, ...extra }] });
    return reply({ type: 9, data: { custom_id: 'campp:' + s.id, title: 'Anderen Termin vorschlagen', components: [
      row('datum', 'Neues Datum (z. B. 17.11. oder 2026-11-17)', fmtDate(s.date), { max_length: 20 }),
      row('uhrzeit', 'Uhrzeit (HH:MM)', s.time, { min_length: 5, max_length: 5 }),
    ] } });
  }
  if (act === 'campc') {
    const r = await propose(env, c, s, { id: w.id, name: w.name }, null, null, true); if (r.err) return say(ERR[r.err] || 'Da ist etwas schiefgelaufen.');
    if (people(c).length === 1) { const cur = await getSession(env, s.id); if (await applyProp(env, c, cur)) { later(announceApplied(env, c, cur)); return say('Abgesagt ✓ (du bist allein in der Kampagne).'); } }
    later(announceProp(env, c, s.id));
    return say(`Absage vorgeschlagen ✓ Alle werden im Thread gefragt. Stimmen alle zu (oder übernimmt ${c.host_name} sie), fällt die Sitzung aus.`);
  }
  if (act === 'campy' || act === 'campn') {
    const r = await vote(env, c, s, w.id, act === 'campy'); if (r.err) return say(ERR[r.err]);
    const rows = await getSessions(env, c.id), cur = rows.find((x) => x.id === s.id);
    if (r.applied) {
      const ap = r.ap;
      later(announceApplied(env, c, { ...s, _applied: { ...ap, msg: null } }));
      return reply({ type: 7, data: propMessage(c, cur, rows, r.prop, { from: ap.from, n: ap.n, done: 'Alle sind einverstanden. ' + appliedText(ap) }) });
    }
    later(syncSession(env, c, s.id));
    return reply({ type: 7, data: propMessage(c, cur, rows, r.prop) });
  }
  if (act === 'campa' || act === 'campx') {
    const p = J(s.prop, null); if (!p) return say(ERR.no_prop);
    if (act === 'campa') {
      if (!host) return say(`Nur ${c.host_name} (Ersteller) oder Moderierende können den Vorschlag direkt übernehmen. Stimm mit „Passt mir“ ab.`);
      if (!(await applyProp(env, c, s))) return say(ERR.changed);
      const rows = await getSessions(env, c.id), cur = rows.find((x) => x.id === s.id);
      later(announceApplied(env, c, { ...s, _applied: { ...s._applied, msg: null } }));
      return reply({ type: 7, data: propMessage(c, cur || s, rows, p, { from: s._applied.from, n: s._applied.n, done: `Übernommen von ${w.name}. ` + appliedText(s._applied) }) });
    }
    if (!host && p.by !== w.id) return say('Zurückziehen kann nur, wer den Vorschlag gemacht hat (oder der Ersteller).');
    await env.DB.prepare('UPDATE campaign_sessions SET prop = NULL WHERE id = ?1').bind(s.id).run();
    const rows = await getSessions(env, c.id), cur = rows.find((x) => x.id === s.id);
    later(syncSession(env, c, s.id));
    return reply({ type: 7, data: propMessage(c, cur, rows, p, { done: p.by === w.id ? 'Zurückgezogen.' : `Abgelehnt von ${w.name}.` }) });
  }
  return say('Unbekannte Aktion.');
}
export async function campaignSubmit(i, env, ctx) {
  await ensureCampaigns(env);
  const [, sid] = String(i.data.custom_id).split(':'), w = who(i);
  const s = await getSession(env, sid); if (!s) return say('Diese Sitzung gibt es nicht mehr.');
  const c = await getCamp(env, s.campaign_id); if (!c || c.status !== 'active') return say('Diese Kampagne gibt es nicht mehr.');
  const f = {}; for (const r of i.data.components || []) for (const x of r.components || []) f[x.custom_id] = x.value;
  const date = parseDate(str(f.datum, 20)); if (!date) return say(ERR.bad_date);
  const r = await propose(env, c, s, { id: w.id, name: w.name }, date, str(f.uhrzeit, 5)); if (r.err) return say(ERR[r.err] || 'Da ist etwas schiefgelaufen.');
  if (people(c).length === 1) { const cur = await getSession(env, s.id); if (await applyProp(env, c, cur)) { ctx.waitUntil(announceApplied(env, c, cur).catch(() => {})); return say('Verschoben ✓ (du bist allein in der Kampagne).'); } }
  ctx.waitUntil(announceProp(env, c, s.id).catch((e) => console.log('prop post failed', e && e.message)));
  return say(`Vorschlag gepostet ✓ ${when(date, r.prop.time)}. Stimmen alle zu (oder übernimmt ${c.host_name} ihn), wird die Sitzung verschoben.`);
}
