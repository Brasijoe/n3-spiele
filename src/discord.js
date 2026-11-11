// Discord-Bot als HTTP-Interactions-Endpoint (kein dauerhaft laufender Prozess nötig).
// Befehle: /party (Spielrunde anlegen), /log (Partie eintragen). Buttons: Dabei / Absagen / Partie eintragen.
import { bggSearch } from './bgg.js';
import { warmCover } from './games.js';
import { bringButton, bringSubmit } from './membergames.js';
import { getBooking, isMember, isStammtisch, nextStammtische, ruleText, introOk, INTRO_HELP } from './booking.js';

const enc = new TextEncoder();
const hex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const codeHash = (c) => sha256('n3-member:' + normCode(c));
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne I, O, 0, 1
function newMemberCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => ALPHA[x % ALPHA.length]).join('');
}
const showCode = (c) => c.slice(0, 4) + '-' + c.slice(4);
const ownsRound = async (row, uid) => (row.host_discord && row.host_discord === uid) || (await sha256('discord:' + uid)) === row.host_key_hash;
export const reply = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
export const say = (content) => reply({ type: 4, data: { content, flags: 64 } }); // nur für die Person sichtbar

export async function verifySignature(pubKeyHex, sigHex, timestamp, bodyText) {
  if (!pubKeyHex || !sigHex || !timestamp) return false;
  try {
    let key;
    try { key = await crypto.subtle.importKey('raw', hex(pubKeyHex), { name: 'Ed25519' }, false, ['verify']); }
    catch { key = await crypto.subtle.importKey('raw', hex(pubKeyHex), { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']); }
    const algo = key.algorithm.name;
    return await crypto.subtle.verify(algo, key, hex(sigHex), enc.encode(timestamp + bodyText));
  } catch { return false; }
}

// ---- Datum (Europe/Berlin) ----
const berlin = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
};
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function nextTuesday(now = new Date()) {
  const b = berlin(now); let add = (2 - b.wd + 7) % 7;
  if (add === 0 && b.hour >= 18) add = 7;
  return addDays(b.date, add);
}
// Standardtermin: der nächste von „Dienstag 18:00“ und „erster Samstag im Monat 18:00“.
export function nextEventDate(now = new Date()) {
  const b = berlin(now), tue = nextTuesday(now);
  const firstSat = (y, m) => { const d = new Date(Date.UTC(y, m, 1, 12)); d.setUTCDate(1 + ((6 - d.getUTCDay() + 7) % 7)); return d.toISOString().slice(0, 10); };
  let y = +b.date.slice(0, 4), m = +b.date.slice(5, 7) - 1, sat = firstSat(y, m);
  if (sat < b.date || (sat === b.date && b.hour >= 18)) sat = firstSat(m === 11 ? y + 1 : y, (m + 1) % 12);
  return sat < tue ? sat : tue;
}
export function parseDate(input, now = new Date()) {
  const s = str(input, 20).toLowerCase(); const b = berlin(now);
  if (!s) return nextEventDate(now);
  if (s === 'heute') return b.date;
  if (s === 'morgen') return addDays(b.date, 1);
  if (isDate(s)) return s;
  const m = /^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/.exec(s);
  if (m) {
    let y = m[3] ? +m[3] : +b.date.slice(0, 4);
    let iso = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    if (!m[3] && iso < b.date) iso = `${y + 1}${iso.slice(4)}`;
    return isDate(iso) ? iso : null;
  }
  return null;
}
export function hasStarted(r, now = new Date()) {
  return r.date <= berlin(now).date; // ab dem Tag der Runde (deutsche Zeit)
}
export const berlinToday = () => berlin().date;
// Standardtermin nach der Regel aus der Verwaltung: heute, wenn Stammtisch ist und es noch vor 18 Uhr ist, sonst der nächste.
export function nextStammtischDate(rule, now = new Date()) {
  const b = berlin(now), from = b.hour < 18 ? b.date : addDays(b.date, 1);
  return nextStammtische(from, rule, 1, 400)[0] || nextEventDate(now);
}
const fmtDay = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
// Antwort für Nicht-Mitglieder, die einen anderen Tag wollen.
const stammtischOnly = (rule) => `Ohne Mitgliederrolle kannst du Runden nur an Stammtisch-Tagen anbieten (${ruleText(rule)}). Nächste Termine: ${nextStammtische(berlinToday(), rule, 4).map(fmtDay).join(', ')}\nFür andere Tage brauchst du einen Event-Code oder fragst ein Mitglied.`;
// Erste Zeile der Discord-Nachricht; bei Runden mit Event-Code steht der Eventname dabei.
export const headline = (r) => `**${r.host}** sucht Mitspielende${r.event_name ? ` am Event „${r.event_name}“` : ''}!`;
export const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
export const wdName = (iso) => ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(iso + 'T12:00:00Z').getUTCDay()];

// ---- Nachricht ----
export function view(r, env = {}) {
  const att = JSON.parse(r.attendees || '{}');
  const people = Object.entries(att).filter(([, a]) => !a.out).map(([k, a]) => (/^d\d{5,}$/.test(k) ? `<@${k.slice(1)}>` : a.name));
  const taken = people.length + 1, free = Math.max(0, r.seats - taken);
  const logged = !!r.play_id;
  const hostTxt = r.host_discord ? `<@${r.host_discord}>` : r.host;
  const gameTxt = r.game + (r.year ? ` (${r.year})` : '');
  // Klare Felder statt langer Textzeile: Feldnamen fett, Werte normal, keine Leerräume.
  const bar = '🟧'.repeat(Math.min(taken, r.seats)) + '⬜'.repeat(Math.max(0, r.seats - taken));
  const dabei = [`👑 ${hostTxt}`, ...people.map((x) => '🙋 ' + x)].join('\n').slice(0, 1000);
  const fields = logged
    ? [{ name: '✅ Gespielt am', value: fmtDate(r.date) }, { name: `👥 Spielende (${taken})`, value: dabei }]
    : [
      { name: '📅 Wann', value: `${wdName(r.date)}, ${fmtDate(r.date)}${r.time ? ` · ${r.time} Uhr` : ''}` },
      { name: `🪑 ${r.seats} Plätze`, value: `${bar}  ${free ? `noch ${free} frei` : '🔒 voll'}` },
      { name: '👥 Dabei', value: dabei },
    ];
  if (r.note) fields.push({ name: '💬 Hinweis', value: r.note.slice(0, 500) });
  // Eine Karte: Titel, Angaben, darunter das große Bild (Discord setzt Bilder immer ans Ende).
  const embed = { title: '🎲 ' + gameTxt, color: logged ? 0x2e7d32 : free ? 0xe8a33d : 0x8a8a8a, fields };
  if (logged) embed.footer = { text: 'Als gespielt registriert' };
  if (r.game_id) {
    embed.url = 'https://boardgamegeek.com/boardgame/' + r.game_id;
    if (env.PUBLIC_URL) embed.image = { url: `${env.PUBLIC_URL.replace(/\/$/, '')}/api/cover/${r.game_id}-big.jpg` };
  }
  const embeds = [embed];
  const components = logged ? [] : [{ type: 1, components: [
    { type: 2, style: 3, label: 'Ich bin dabei', emoji: { name: '✋' }, custom_id: 'join:' + r.id, disabled: !free },
    { type: 2, style: 2, label: 'Absagen', custom_id: 'leave:' + r.id },
    { type: 2, style: 1, label: 'Verwalten (Ersteller)', emoji: { name: '⚙️' }, custom_id: 'manage:' + r.id },
  ] }];
  return { embeds, components, allowed_mentions: { parse: [] } };
}

// Nur der Ersteller sieht diese Schaltflächen (kurzlebige Nachricht, nur für ihn sichtbar).
const managePanel = (r) => ({ type: 7, data: { content: `**Runde verwalten:** ${r.game}`, embeds: [], components: [{ type: 1, components: [
  { type: 2, style: 1, label: 'Als gespielt registrieren', custom_id: 'log:' + r.id },
  { type: 2, style: 2, label: 'Bearbeiten', custom_id: 'edit:' + r.id },
  { type: 2, style: 4, label: 'Stornieren', custom_id: 'cancel:' + r.id },
] }] } });
const done = (text) => reply({ type: 7, data: { content: text, embeds: [], components: [] } });
function editModal(r) {
  const row = (custom_id, label, value, extra = {}) => ({ type: 1, components: [{ type: 4, custom_id, label, style: 1, value: String(value == null ? '' : value), required: true, ...extra }] });
  return { type: 9, data: { custom_id: 'edit:' + r.id, title: 'Spielrunde bearbeiten', components: [
    row('spiel', 'Spiel', r.game, { max_length: 120 }),
    row('datum', 'Datum (z. B. 17.11. oder 2026-11-17)', fmtDate(r.date), { max_length: 20 }),
    row('uhrzeit', 'Uhrzeit (HH:MM)', r.time || '18:00', { max_length: 5, min_length: 5 }),
    row('plaetze', 'Plätze inkl. Gastgeber (2–30)', r.seats, { max_length: 2 }),
    row('hinweis', 'Hinweis / kurze Vorstellung', r.note || '', { required: false, max_length: 500, style: 2 }),
  ] } };
}

const modOf = (i) => { const p = BigInt((i.member && i.member.permissions) || '0'); return (p & 0x20n) !== 0n || (p & 0x8n) !== 0n; };
export const who = (i) => {
  const u = (i.member && i.member.user) || i.user || {};
  return { id: u.id, name: str((i.member && i.member.nick) || u.global_name || u.username || 'Spieler', 40) };
};
const opt = (i, name) => { const o = (i.data.options || []).find((x) => x.name === name); return o ? o.value : undefined; };

async function cmdParty(i, env) {
  const w = who(i);
  const raw = str(opt(i, 'spiel'), 160);
  if (!raw) return say('Bitte ein Spiel angeben.');
  // Autocomplete liefert "id|Name|Jahr"; freier Text bleibt möglich.
  let gameId = null, game = raw, year = null;
  const m = /^(\d+)\|(.*?)\|(\d*)$/.exec(raw);
  if (m) { gameId = +m[1]; game = m[2]; year = m[3] ? +m[3] : null; }
  const rule = await getBooking(env), roles = (i.member && i.member.roles) || [];
  const date = opt(i, 'datum') ? parseDate(opt(i, 'datum')) : nextStammtischDate(rule); if (!date) return say('Datum nicht verstanden. Beispiele: 2026-11-17, 17.11., heute, morgen.');
  const time = str(opt(i, 'uhrzeit') || '18:00', 5); if (!/^\d{2}:\d{2}$/.test(time)) return say('Uhrzeit bitte als HH:MM, z. B. 18:00.');
  const seats = Number(opt(i, 'plaetze') || 4); if (!(seats >= 2 && seats <= 30)) return say('Plätze: 2 bis 30.');
  const note = str(opt(i, 'hinweis'), 500);
  if (!isMember(rule, roles)) {
    if (date < berlinToday()) return say('Das Datum liegt in der Vergangenheit.');
    if (!isStammtisch(date, rule)) return say(stammtischOnly(rule));
    if (!introOk(note)) return say(INTRO_HELP + ' Bitte `/party` noch einmal mit `hinweis` ausfüllen.');
  }
  const id = newId();
  await env.DB.prepare("INSERT INTO parties(id, game_id, game, guest, year, date, time, seats, host, host_key_hash, note, attendees, created_at, host_discord) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'{}',?12,?13)")
    .bind(id, gameId, game.slice(0, 120), 0, year, date, time, seats, w.name, await sha256('discord:' + w.id), note, new Date().toISOString(), w.id).run();
  const row = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();
  // Per REST posten, damit wir die Nachricht später aktualisieren können; sonst normale Antwort.
  try {
    if (i.channel_id && env.DISCORD_BOT_TOKEN) { await announceParty(env, id, i.channel_id); return say('Runde angelegt ✓ – sie steht jetzt im Kanal.'); }
  } catch (e) { console.log('announce failed', e && e.message); }
  return reply({ type: 4, data: { content: `**${w.name}** sucht Mitspielende!`, ...view(row, env) } });
}

async function cmdLog(i, env) {
  const raw = str(opt(i, 'spiel'), 160);
  let gameId = null, game = raw, year = null;
  const m = /^(\d+)\|(.*?)\|(\d*)$/.exec(raw);
  if (m) { gameId = +m[1]; game = m[2]; year = m[3] ? +m[3] : null; }
  const players = Number(opt(i, 'spieler')); if (!game || !(players >= 1 && players <= 99)) return say('Bitte Spiel und Spielerzahl angeben.');
  const date = parseDate(opt(i, 'datum') || 'heute'); if (!date) return say('Datum nicht verstanden.');
  const dur = opt(i, 'dauer');
  const w = who(i);
  await env.DB.prepare("INSERT INTO plays(id, game_id, game, guest, year, date, players, winner, note, duration, first_play, created_at, logged_by, via, by_discord) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11,?12,'discord',?13)")
    .bind(newId(), gameId, game.slice(0, 120), 0, year, date, players, str(opt(i, 'sieger'), 80), str(opt(i, 'hinweis'), 200), dur ? Math.round(Number(dur)) : null, new Date().toISOString(), w.name, w.id).run();
  return say(`Eingetragen: ${game}, ${players} Spielende, ${fmtDate(date)} ✓`);
}

async function button(i, env) {
  const [act, id] = String(i.data.custom_id).split(':');
  const w = who(i);
  const row = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();
  if (!row) return say('Diese Runde gibt es nicht mehr.');
  if (!row.discord_msg && i.message && i.channel_id && !(i.message.flags & 64)) await env.DB.prepare('UPDATE parties SET discord_channel = ?1, discord_msg = ?2 WHERE id = ?3').bind(i.channel_id, i.message.id, id).run();
  // Verwalten dürfen: der Ersteller (bei Runden aus Discord) und Personen mit der Serverrecht „Server verwalten“ oder Administrator
  // (bei Runden von der Webseite ist das die einzige Möglichkeit in Discord; dort verwaltet der Ersteller sie im Browser).
  const perms = BigInt((i.member && i.member.permissions) || '0');
  const isMod = (perms & 0x20n) !== 0n || (perms & 0x8n) !== 0n;
  const isHost = isMod || (await ownsRound(row, w.id));
  const isOwner = await ownsRound(row, w.id);
  const key = 'd' + w.id;
  if (act === 'join') {
    if (isOwner) return say('Du bist der Gastgeber und hast schon einen Platz.');
    const r = await env.DB.prepare(`UPDATE parties SET attendees = json_set(attendees, '$.' || ?1, json(?2))
      WHERE id = ?3 AND play_id IS NULL AND (SELECT count(*) FROM json_each(parties.attendees) WHERE coalesce(json_extract(value, '$.out'), 0) = 0 AND key != ?1) + 1 < seats`)
      .bind(key, JSON.stringify({ name: w.name, at: new Date().toISOString() }), id).run();
    if (!r.meta.changes) return say('Leider schon voll.');
  } else if (act === 'leave') {
    if (isOwner) return say('Als Gastgeber kannst du nicht absagen, sondern die Runde über „Verwalten“ stornieren.');
    await env.DB.prepare("UPDATE parties SET attendees = json_set(attendees, '$.' || ?1 || '.out', 1) WHERE id = ?2 AND json_type(attendees, '$.' || ?1) IS NOT NULL").bind(key, id).run();
  } else if (act === 'manage') {
    if (!isHost) return say('Nur der Ersteller oder Moderierende können die Runde verwalten.');
    if (row.play_id) return say('Die Runde ist schon als gespielt registriert.');
    return reply({ type: 4, data: { ...managePanel(row).data, flags: 64 } });
  } else if (act === 'log') {
    if (!isHost) return say('Nur der Ersteller oder Moderierende können die Runde als gespielt registrieren.');
    if (!hasStarted(row)) return say(`Das geht erst am Tag des vereinbarten Termins (${fmtDate(row.date)}).`);
    if (!row.play_id) {
      const att = Object.values(JSON.parse(row.attendees || '{}')).filter((a) => !a.out).length + 1;
      const pid = newId();
      await env.DB.prepare("INSERT INTO plays(id, game_id, game, guest, year, date, players, winner, note, duration, first_play, created_at, logged_by, via, by_discord) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,0,?10,?11,'discord',?12)")
        .bind(pid, row.game_id, row.game, row.guest, row.year, row.date, att, '', 'Über Discord eingetragen', new Date().toISOString(), w.name, row.host_discord || w.id).run();
      await env.DB.prepare('UPDATE parties SET play_id = ?1 WHERE id = ?2 AND play_id IS NULL').bind(pid, id).run();
    }
    await syncParty(env, id, true);
    return done('Als gespielt registriert ✓');
  } else if (act === 'edit') {
    if (!isHost) return say('Nur der Ersteller oder Moderierende können die Runde bearbeiten.');
    if (row.play_id) return say('Die Runde ist schon als gespielt registriert.');
    return reply(editModal(row));
  } else if (act === 'cancel') {
    if (!isHost) return say('Nur der Ersteller oder Moderierende können die Runde stornieren.');
    return reply({ type: 7, data: { content: `**Wirklich stornieren?** ${row.game} (${fmtDate(row.date)}). Das löscht die Runde auch auf der Webseite.`, components: [{ type: 1, components: [
      { type: 2, style: 4, label: 'Ja, Runde stornieren', custom_id: 'cancelyes:' + id },
      { type: 2, style: 2, label: 'Zurück', custom_id: 'cancelno:' + id },
    ] }] } });
  } else if (act === 'cancelno') {
    if (!isHost) return say('Nur der Ersteller oder Moderierende können das entscheiden.');
    return reply(managePanel(row));
  } else if (act === 'cancelyes') {
    if (!isHost) return say('Nur der Ersteller oder Moderierende können die Runde stornieren.');
    await env.DB.prepare('DELETE FROM parties WHERE id = ?1').bind(id).run();
    await cancelPartyMessage(env, row, true);
    return done('Runde storniert ✓');
  } else return say('Unbekannte Aktion.');
  const fresh = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();
  return reply({ type: 7, data: view(fresh, env) });
}

async function editSubmit(i, env) {
  const id = String(i.data.custom_id).split(':')[1];
  const w = who(i);
  const row = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();
  if (!row) return say('Diese Runde gibt es nicht mehr.');
  if (!(await ownsRound(row, w.id)) && !modOf(i)) return say('Nur der Ersteller oder Moderierende können die Runde bearbeiten.');
  if (row.play_id) return say('Die Runde ist schon als gespielt registriert.');
  const f = {};
  for (const r of i.data.components || []) for (const c of r.components || []) f[c.custom_id] = c.value;
  const game = str(f.spiel, 120); if (!game) return say('Das Spiel darf nicht leer sein.');
  const date = parseDate(f.datum); if (!date) return say('Datum nicht verstanden. Beispiele: 2026-11-17 oder 17.11.');
  const time = str(f.uhrzeit, 5); if (!/^\d{2}:\d{2}$/.test(time)) return say('Uhrzeit bitte als HH:MM, z. B. 18:00.');
  const seats = Number(f.plaetze);
  const note = str(f.hinweis, 500);
  // Eigene Runde ohne Mitgliederrolle (Moderierende ausgenommen): neues Datum nur an Stammtisch-Tagen, Vorstellung bleibt Pflicht.
  if (!modOf(i) && !row.event_id) {
    const rule = await getBooking(env);
    if (!isMember(rule, (i.member && i.member.roles) || [])) {
      if (date !== row.date && (date < berlinToday() || !isStammtisch(date, rule))) return say(stammtischOnly(rule));
      if (!introOk(note)) return say(INTRO_HELP);
    }
  }
  const taken = Object.values(JSON.parse(row.attendees || '{}')).filter((a) => !a.out).length + 1;
  if (!(seats >= 2 && seats <= 30) || seats < taken) return say(`Plätze: 2 bis 30, mindestens ${taken} (so viele sind schon dabei).`);
  const same = game === row.game;
  await env.DB.prepare('UPDATE parties SET game = ?1, game_id = ?2, year = ?3, date = ?4, time = ?5, seats = ?6, note = ?7 WHERE id = ?8')
    .bind(game, same ? row.game_id : null, same ? row.year : null, date, time, seats, note, id).run();
  await syncParty(env, id, true);
  return done('Gespeichert ✓');
}

async function autocomplete(i, env, ctx) {
  const f = (i.data.options || []).find((o) => o.focused);
  const q = str(f && f.value, 80);
  let choices = [];
  if (q.length >= 2) {
    try {
      choices = (await bggSearch(env, ctx, q, { tries: 1 })).slice(0, 10).map((x) => {
        const label = (x.n + (x.y ? ` (${x.y})` : '') + (x.e ? ' – Erweiterung' : '')).slice(0, 100);
        return { name: label, value: `${x.id}|${x.n}|${x.y || ''}`.slice(0, 100) };
      });
    } catch { /* BGG nicht erreichbar: freie Eingabe bleibt möglich */ }
  }
  return reply({ type: 8, data: { choices } });
}

export async function handleInteraction(req, env, ctx) {
  const text = await req.text();
  if (!(await verifySignature(env.DISCORD_PUBLIC_KEY, req.headers.get('x-signature-ed25519'), req.headers.get('x-signature-timestamp'), text))) return new Response('bad signature', { status: 401 });
  const i = JSON.parse(text);
  if (i.type === 1) return reply({ type: 1 });
  if (env.DISCORD_GUILD_ID && i.guild_id !== env.DISCORD_GUILD_ID) return say('Dieser Bot ist für diesen Server nicht freigeschaltet.');
  // Optional: nur ein Kanal. Buttons an alten Nachrichten gelten ebenfalls nur dort.
  const chans = channelIds(env);
  if (chans.length && !chans.includes(i.channel_id)) {
    return i.type === 4 ? reply({ type: 8, data: { choices: [] } }) : say(`Bitte nutze den Bot nur in ${chans.map((c) => `<#${c}>`).join(', ')}.`);
  }
  try {
    await ensureCols(env);
    if (i.type === 4) return await autocomplete(i, env, ctx);
    if (i.type === 2) return i.data.name === 'party' ? await cmdParty(i, env) : i.data.name === 'log' ? await cmdLog(i, env) : i.data.name === 'code' ? await cmdCode(i, env) : say('Unbekannter Befehl.');
    const cid = String((i.data && i.data.custom_id) || '');
    if (i.type === 3) return cid.startsWith('bring') ? await bringButton(i, env, ctx) : await button(i, env);
    if (i.type === 5) return cid.startsWith('bring') ? await bringSubmit(i, env, ctx) : await editSubmit(i, env);
  } catch (e) { console.log('discord error', e && e.message); return say('Da ist etwas schiefgelaufen. Bitte nochmal versuchen.'); }
  return say('Nicht unterstützt.');
}

const GAME = { type: 3, name: 'spiel', description: 'Spielname (Vorschläge von BoardGameGeek)', required: true, autocomplete: true };
export const COMMANDS = [
  { name: 'code', description: 'Persönlichen Code für die Webseite abholen (nur für dich sichtbar)' },
  { name: 'party', description: 'Spielrunde anlegen und Mitspielende suchen', options: [
    GAME,
    { type: 3, name: 'datum', description: 'Standard: nächster Stammtisch. Format 2026-11-17, 17.11., heute, morgen' },
    { type: 3, name: 'uhrzeit', description: 'HH:MM, Standard 18:00' },
    { type: 4, name: 'plaetze', description: 'Plätze inkl. dir, Standard 4', min_value: 2, max_value: 30 },
    { type: 3, name: 'hinweis', description: 'Zusatzinfo. Ohne Mitgliederrolle Pflicht: stell dich kurz vor', max_length: 500 },
  ] },
  { name: 'log', description: 'Eine gespielte Partie eintragen', options: [
    GAME,
    { type: 4, name: 'spieler', description: 'Anzahl Spielende', required: true, min_value: 1, max_value: 99 },
    { type: 3, name: 'datum', description: 'Standard: heute' },
    { type: 3, name: 'sieger', description: 'Wer hat gewonnen?' },
    { type: 4, name: 'dauer', description: 'Dauer in Minuten', min_value: 1, max_value: 1440 },
    { type: 3, name: 'hinweis', description: 'Notiz' },
  ] },
];

export async function registerCommands(env) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_APP_ID) throw Object.assign(new Error('no_discord'), { code: 'no_discord' });
  const base = `https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}`;
  const url = env.DISCORD_GUILD_ID ? `${base}/guilds/${env.DISCORD_GUILD_ID}/commands` : `${base}/commands`;
  const res = await fetch(url, { method: 'PUT', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(COMMANDS) });
  if (!res.ok) throw Object.assign(new Error('discord ' + res.status + ' ' + (await res.text()).slice(0, 200)), { code: 'discord_' + res.status });
  return (await res.json()).length;
}

// ---- Nachrichten über die REST-API (Webseite -> Kanal, Aktualisierungen) ----
const api = (env) => env.DISCORD_API_BASE || 'https://discord.com/api/v10';
export async function discord(env, method, path, body) {
  const res = await fetch(api(env) + path, { method, headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error('discord ' + res.status + ' ' + (await res.text()).slice(0, 160));
  return res.json();
}
// DISCORD_CHANNEL_ID: eine oder mehrere Kanal-IDs, durch Komma getrennt. Der erste Kanal ist das Ziel für Runden von der Webseite.
export const channelIds = (env) => String(env.DISCORD_CHANNEL_ID || '').split(',').map((x) => x.trim()).filter(Boolean);
export const discordOn = (env) => !!(env.DISCORD_BOT_TOKEN && channelIds(env).length);

// Spalten für die Verknüpfung mit der Discord-Nachricht (einmal pro Worker-Instanz prüfen).
let colsOk = false;
export async function ensureCols(env) {
  if (colsOk) return;
  const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('parties')").all();
  const have = new Set(results.map((r) => r.name));
  if (!have.has('discord_channel')) await env.DB.prepare('ALTER TABLE parties ADD COLUMN discord_channel TEXT').run();
  if (!have.has('discord_msg')) await env.DB.prepare('ALTER TABLE parties ADD COLUMN discord_msg TEXT').run();
  if (!have.has('host_discord')) await env.DB.prepare('ALTER TABLE parties ADD COLUMN host_discord TEXT').run();
  if (!have.has('event_id')) await env.DB.prepare('ALTER TABLE parties ADD COLUMN event_id TEXT').run();
  if (!have.has('event_name')) await env.DB.prepare('ALTER TABLE parties ADD COLUMN event_name TEXT').run();
  if (!have.has('bring_id')) await env.DB.prepare('ALTER TABLE parties ADD COLUMN bring_id TEXT').run();
  // Spiele, die Mitglieder selbst besitzen (Besitzer = Discord-Name, mit Zustimmung), und Anfragen „Bitte mitbringen“.
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS member_games (id TEXT PRIMARY KEY, discord_id TEXT NOT NULL, game_id INTEGER, game TEXT NOT NULL, year INTEGER, note TEXT NOT NULL DEFAULT \'\', data TEXT, consent_at TEXT NOT NULL, created_at TEXT NOT NULL)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS member_games_owner ON member_games(discord_id)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS bring_requests (id TEXT PRIMARY KEY, mgame_id TEXT NOT NULL, owner_discord TEXT NOT NULL, owner_name TEXT NOT NULL, req_discord TEXT NOT NULL, req_name TEXT NOT NULL, game TEXT NOT NULL, game_id INTEGER, year INTEGER, seats INTEGER, dates TEXT NOT NULL, note TEXT NOT NULL DEFAULT \'\', status TEXT NOT NULL DEFAULT \'open\', chosen_date TEXT, party_id TEXT, answer TEXT, discord_channel TEXT, discord_msg TEXT, created_at TEXT NOT NULL)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, valid_until TEXT NOT NULL, date_from TEXT NOT NULL, date_to TEXT NOT NULL, created_at TEXT NOT NULL)').run();
  const pc = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('plays')").all()).results.map((r) => r.name));
  for (const c of ['logged_by', 'via', 'by_discord']) if (!pc.has(c)) await env.DB.prepare(`ALTER TABLE plays ADD COLUMN ${c} TEXT`).run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS members (discord_id TEXT PRIMARY KEY, name TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE, blocked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0)').run();
  // Discord-Rollen (JSON) für die Mitgliederregel beim Runden-Anbieten.
  const mc = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('members')").all()).results.map((r) => r.name));
  if (!mc.has('roles')) await env.DB.prepare('ALTER TABLE members ADD COLUMN roles TEXT').run();
  if (!mc.has('bgg_user')) await env.DB.prepare('ALTER TABLE members ADD COLUMN bgg_user TEXT').run();
  // Herkunft der Mitgliederspiele ('bgg' = aus der BGG-Sammlung importiert; nur diese entfernt ein Abgleich automatisch).
  const gc = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('member_games')").all()).results.map((r) => r.name));
  if (!gc.has('src')) {
    await env.DB.prepare('ALTER TABLE member_games ADD COLUMN src TEXT').run();
    // Bisherige Importe erkennen: mehrere Spiele derselben Person mit identischem Zeitstempel stammen aus einem BGG-Import.
    await env.DB.prepare("UPDATE member_games SET src = 'bgg' WHERE (discord_id, created_at) IN (SELECT discord_id, created_at FROM member_games GROUP BY discord_id, created_at HAVING COUNT(*) > 1)").run();
  }
  // Mehrere Besitzer desselben Spiels: alle werden gefragt (owners = JSON [{id, name, mg}]), wer zuerst annimmt, bringt es mit.
  const bc = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('bring_requests')").all()).results.map((r) => r.name));
  if (!bc.has('owners')) await env.DB.prepare('ALTER TABLE bring_requests ADD COLUMN owners TEXT').run();
  if (!bc.has('declined')) await env.DB.prepare('ALTER TABLE bring_requests ADD COLUMN declined TEXT').run();
  colsOk = true;
}

const getParty = (env, id) => env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();

// Schutz vor Spam über die Webseite: globale Obergrenzen für Nachrichten des Bots (Tabelle `rate`).
// Neue Runden: max. 5 pro Stunde und 15 pro Tag. Aktualisierungen: max. 60 pro Stunde. Darüber schweigt der Bot,
// die Webseite funktioniert unverändert weiter.
async function budget(env, name, max, windowSec) {
  const k = 'dc:' + name + ':' + Math.floor(Date.now() / 1000 / windowSec);
  const row = await env.DB.prepare('INSERT INTO rate(k, n, ts) VALUES(?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n').bind(k, Date.now()).first();
  return row.n <= max;
}
export async function announceParty(env, id, channelId, fromWeb = false) {
  if (fromWeb && !((await budget(env, 'new-h', 5, 3600)) && (await budget(env, 'new-d', 15, 86400)))) { console.log('discord: announce limit reached, skipped'); return null; }
  channelId = channelId || channelIds(env)[0];
  const row = await getParty(env, id); if (!row) return null;
  if (row.game_id) { try { await Promise.race([warmCover(env, row.game_id), new Promise((r) => setTimeout(r, 4000))]); } catch { /* ohne Vorwärmen */ } }
  const msg = await discord(env, 'POST', `/channels/${channelId}/messages`, { content: headline(row), ...view(row, env) });
  await env.DB.prepare('UPDATE parties SET discord_channel = ?1, discord_msg = ?2 WHERE id = ?3').bind(channelId, msg.id, id).run();
  return msg.id;
}
export async function syncParty(env, id, internal = false) {
  if (!internal && !(await budget(env, 'upd-h', 60, 3600))) { console.log('discord: update limit reached, skipped'); return; }
  const row = await getParty(env, id);
  if (!row || !row.discord_msg) return;
  await discord(env, 'PATCH', `/channels/${row.discord_channel}/messages/${row.discord_msg}`, { content: headline(row), ...view(row, env) });
}
export async function cancelPartyMessage(env, row, internal = false) {
  if (!row || !row.discord_msg) return;
  if (!internal && !(await budget(env, 'upd-h', 60, 3600))) { console.log('discord: update limit reached, skipped'); return; }
  await discord(env, 'PATCH', `/channels/${row.discord_channel}/messages/${row.discord_msg}`, { content: `~~${row.game}~~ – die Runde von **${row.host}** wurde storniert.`, embeds: [], components: [] });
}

// Prüft (höchstens alle 10 Minuten pro Person), ob jemand noch auf dem Server ist. Wer ihn verlassen hat, verliert den Code.
export async function stillMember(env, m) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return true;
  if (Date.now() - m.checked_at < 600000) return true;
  const res = await fetch(`${api(env)}/guilds/${env.DISCORD_GUILD_ID}/members/${m.discord_id}`, { headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } });
  if (res.status === 404) { await env.DB.prepare('DELETE FROM members WHERE discord_id = ?1').bind(m.discord_id).run(); return false; }
  if (res.ok) await env.DB.prepare('UPDATE members SET checked_at = ?1 WHERE discord_id = ?2').bind(Date.now(), m.discord_id).run();
  return true;
}

async function cmdCode(i, env) {
  const w = who(i);
  const code = newMemberCode();
  await env.DB.prepare('INSERT INTO members(discord_id, name, code_hash, blocked, created_at, checked_at, roles) VALUES(?1, ?2, ?3, 0, ?4, ?5, ?6) ON CONFLICT(discord_id) DO UPDATE SET name = excluded.name, code_hash = excluded.code_hash, checked_at = excluded.checked_at, roles = excluded.roles')
    .bind(w.id, w.name, await codeHash(code), new Date().toISOString(), Date.now(), JSON.stringify((i.member && i.member.roles) || [])).run();
  return say(`**Dein persönlicher Code: \`${showCode(code)}\`**\nGib ihn auf der Webseite ein, um Spielrunden anzulegen oder Partien einzutragen. Er gehört zu deinem Discord-Konto (Name: ${w.name}). Gib ihn nicht weiter. Mit einem neuen \`/code\` wird der alte ungültig.`);
}
