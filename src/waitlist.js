// Warteliste für volle Runden (Webseite und Discord).
// parties.waitlist = JSON [{k, name, did?, at}] in Reihenfolge der Anmeldung. k ist der Schlüssel, unter dem die Person
// beim Nachrücken in attendees eingetragen wird (Webseite: zufälliger Schlüssel aus dem Browser, Discord: 'd<id>').
// Wird ein Platz frei (Absage, mehr Plätze, Reservierung abgelaufen/freigegeben), rückt die erste Person automatisch nach
// und bekommt (mit Discord) eine Direktnachricht; im Thread der Runde steht ein kurzer Hinweis.
import { discord, resExpired, expireReservations, berlinToday, fmtDate, wdName } from './discord.js';

export const WAIT_MAX = 20;
export const waitOf = (row) => { try { const w = JSON.parse((row && row.waitlist) || '[]'); return Array.isArray(w) ? w : []; } catch { return []; } };
const attOf = (row) => { try { return JSON.parse((row && row.attendees) || '{}') || {}; } catch { return {}; } };
// Belegte Plätze inkl. Gastgeber (wie in der Discord-Ansicht: reservierte zählen, abgelaufene nicht).
export const takenSeats = (row, now = new Date().toISOString()) => Object.values(attOf(row)).filter((a) => a && !a.out && !resExpired(a, now)).length + 1;
const sameDid = (a, did) => did && a && (String(a.did || '') === String(did));
// Ist die Person (Schlüssel oder Discord-ID) schon dabei?
export function inRound(row, key, did) {
  const att = attOf(row);
  if (key && att[key] && !att[key].out) return true;
  if (did) { if (String(row.host_discord || '') === String(did)) return true; const d = att['d' + did]; if (d && !d.out) return true; return Object.values(att).some((a) => !a.out && sameDid(a, did)); }
  return false;
}
// Platz auf der Warteliste (1-basiert) oder 0.
export function waitPos(row, key, did) {
  const w = waitOf(row);
  const i = w.findIndex((e) => (key && e.k === key) || sameDid(e, did) || (did && e.k === 'd' + did));
  return i + 1;
}

// Optimistisch schreiben: nur, wenn sich waitlist/attendees seit dem Lesen nicht geändert haben (bis zu 4 Versuche).
async function writeRow(env, row, att, wl) {
  const r = await env.DB.prepare('UPDATE parties SET attendees = ?1, waitlist = ?2 WHERE id = ?3 AND attendees = ?4 AND coalesce(waitlist, \'[]\') = ?5')
    .bind(JSON.stringify(att), JSON.stringify(wl), row.id, row.attendees, row.waitlist || '[]').run();
  return !!(r.meta && r.meta.changes);
}
const load = (env, id) => env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();

// Auf die Warteliste. Ergebnis: {pos} oder {err: 'gone'|'not_full'|'already_in'|'wait_full'}.
export async function addWait(env, id, entry) {
  for (let t = 0; t < 4; t++) {
    const row = await expireReservations(env, await load(env, id));
    if (!row || row.play_id || row.date < berlinToday()) return { err: 'gone' };
    if (inRound(row, entry.k, entry.did)) return { err: 'already_in' };
    const pos = waitPos(row, entry.k, entry.did); if (pos) return { pos, already: true };
    if (takenSeats(row) < row.seats) return { err: 'not_full' };
    const wl = waitOf(row); if (wl.length >= WAIT_MAX) return { err: 'wait_full' };
    const e = { k: entry.k, name: entry.name, at: new Date().toISOString() }; if (entry.did) e.did = String(entry.did);
    wl.push(e);
    if (await writeRow(env, row, attOf(row), wl)) return { pos: wl.length };
  }
  return { err: 'busy' };
}
// Von der Warteliste nehmen (Schlüssel oder Discord-ID). true, wenn jemand entfernt wurde.
export async function removeWait(env, id, key, did) {
  for (let t = 0; t < 4; t++) {
    const row = await load(env, id); if (!row) return false;
    const wl = waitOf(row), rest = wl.filter((e) => !((key && e.k === key) || sameDid(e, did) || (did && e.k === 'd' + did)));
    if (rest.length === wl.length) return false;
    if (await writeRow(env, row, attOf(row), rest)) return true;
  }
  return false;
}

// Freie Plätze mit der Warteliste auffüllen. Gibt die nachgerückten Einträge zurück (und benachrichtigt sie).
// ctx: Benachrichtigungen im Hintergrund (Discord-Antworten müssen in 3 Sekunden raus); ohne ctx wird gewartet.
export async function promoteWaitlist(env, id, ctx = null) {
  for (let t = 0; t < 4; t++) {
    const row = await expireReservations(env, await load(env, id));
    if (!row || row.play_id || row.date < berlinToday()) return [];
    const wl = waitOf(row); if (!wl.length) return [];
    const att = attOf(row); let free = row.seats - takenSeats(row);
    if (free <= 0) return [];
    const moved = [], rest = [];
    for (const e of wl) {
      if (inRound(row, e.k, e.did)) continue; // inzwischen anders dabei: nur von der Liste nehmen
      if (free > 0) { att[e.k] = e.did ? { name: e.name, at: new Date().toISOString(), did: e.did, wl: 1 } : { name: e.name, at: new Date().toISOString(), wl: 1 }; moved.push(e); free--; }
      else rest.push(e);
    }
    if (!(await writeRow(env, row, att, rest))) continue;
    if (moved.length) { const p = notifyMoved(env, row, moved).catch((e) => console.log('waitlist notify failed', e && e.message)); if (ctx) ctx.waitUntil(p); else await p; }
    return moved;
  }
  return [];
}

// Direktnachricht an Nachgerückte mit Discord und ein Hinweis im Thread der Runde. Fehler (DMs gesperrt) werden ignoriert.
async function notifyMoved(env, row, moved) {
  if (!env.DISCORD_BOT_TOKEN) return;
  const when = `${wdName(row.date)}, ${fmtDate(row.date)}${row.time ? ` um ${row.time} Uhr` : ''}`;
  const link = row.discord_msg && env.DISCORD_GUILD_ID ? `\nZur Runde: https://discord.com/channels/${env.DISCORD_GUILD_ID}/${row.discord_channel}/${row.discord_msg}` : '';
  for (const e of moved) {
    const did = e.did || (/^d\d{5,}$/.test(e.k) ? e.k.slice(1) : null);
    if (!did) continue;
    try {
      const dm = await discord(env, 'POST', '/users/@me/channels', { recipient_id: did });
      await discord(env, 'POST', `/channels/${dm.id}/messages`, { content: `✅ Ein Platz ist frei geworden: Du bist von der Warteliste nachgerückt und jetzt bei **${row.game}** am ${when} dabei (Runde von **${row.host}**).\nFalls du nicht mehr kannst, sag bitte ab („Absagen“ im Runden-Post oder auf der Webseite), damit die nächste Person nachrücken kann.${link}`, allowed_mentions: { parse: [] } });
    } catch (err) { console.log('waitlist dm failed', err && err.message); }
  }
  if (row.discord_thread) {
    const names = moved.map((e) => { const did = e.did || (/^d\d{5,}$/.test(e.k) ? e.k.slice(1) : null); return did ? `<@${did}>` : `**${String(e.name).replace(/[*_~`|]/g, '')}**`; });
    try { await discord(env, 'POST', `/channels/${row.discord_thread}/messages`, { content: `🕒 Von der Warteliste nachgerückt: ${names.join(', ')}`, allowed_mentions: { parse: [] } }); } catch (err) { console.log('waitlist thread note failed', err && err.message); }
  }
}

// Alle 20 Minuten: Runden mit Warteliste und freiem Platz auffüllen (falls ein Weg ohne direktes Nachrücken Plätze frei gemacht hat).
export async function sweepWaitlists(env, sync) {
  const { results } = await env.DB.prepare("SELECT id FROM parties WHERE waitlist IS NOT NULL AND waitlist != '[]' AND play_id IS NULL AND date >= ?1 LIMIT 50").bind(berlinToday()).all();
  let n = 0;
  for (const r of results) { const m = await promoteWaitlist(env, r.id); if (m.length) { n += m.length; if (sync) await sync(r.id).catch((e) => console.log('waitlist sync failed', e && e.message)); } }
  return n;
}
