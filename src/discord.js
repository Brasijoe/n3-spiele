// Discord-Bot als HTTP-Interactions-Endpoint (kein dauerhaft laufender Prozess nötig).
// Befehle: /party (Spielrunde anlegen), /log (Partie eintragen). Buttons: Dabei / Absagen / Partie eintragen.
import { bggSearch } from './bgg.js';

const enc = new TextEncoder();
const hex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
const reply = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const say = (content) => reply({ type: 4, data: { content, flags: 64 } }); // nur für die Person sichtbar

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
export function parseDate(input, now = new Date()) {
  const s = str(input, 20).toLowerCase(); const b = berlin(now);
  if (!s) return nextTuesday(now);
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
  const b = berlin(now);
  if (r.date !== b.date) return r.date < b.date;
  return !r.time || r.time <= `${String(b.hour).padStart(2, '0')}:${String(b.minute).padStart(2, '0')}`;
}
const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
const wdName = (iso) => ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(iso + 'T12:00:00Z').getUTCDay()];

// ---- Nachricht ----
function view(r) {
  const att = JSON.parse(r.attendees || '{}');
  const names = Object.values(att).filter((a) => !a.out).map((a) => a.name);
  const taken = names.length + 1, free = Math.max(0, r.seats - taken);
  const logged = !!r.play_id;
  const fields = [
    { name: 'Wann', value: `${wdName(r.date)}, ${fmtDate(r.date)}${r.time ? ', ' + r.time + ' Uhr' : ''}`, inline: true },
    { name: 'Plätze', value: `${taken}/${r.seats}${free ? ` (${free} frei)` : ' (voll)'}`, inline: true },
    { name: 'Dabei', value: [`${r.host} (Gastgeber)`, ...names].join('\n').slice(0, 1000) },
  ];
  if (r.note) fields.push({ name: 'Hinweis', value: r.note });
  const embed = { title: r.game + (r.year ? ` (${r.year})` : ''), color: logged ? 0x2e7d32 : 0xe8a33d, fields, footer: { text: logged ? 'Als gespielt registriert ✓' : 'N3 Spielrunde' } };
  if (r.game_id) embed.url = 'https://boardgamegeek.com/boardgame/' + r.game_id;
  const components = logged ? [] : [{ type: 1, components: [
    { type: 2, style: 3, label: 'Ich bin dabei', custom_id: 'join:' + r.id, disabled: !free },
    { type: 2, style: 2, label: 'Absagen', custom_id: 'leave:' + r.id },
    { type: 2, style: 1, label: 'Als gespielt registrieren', custom_id: 'log:' + r.id },
    { type: 2, style: 2, label: 'Bearbeiten', custom_id: 'edit:' + r.id },
    { type: 2, style: 4, label: 'Stornieren', custom_id: 'cancel:' + r.id },
  ] }];
  return { embeds: [embed], components };
}

function confirmView(r) {
  const v = view(r);
  v.components = [{ type: 1, components: [
    { type: 2, style: 4, label: 'Ja, Runde stornieren', custom_id: 'cancelyes:' + r.id },
    { type: 2, style: 2, label: 'Zurück', custom_id: 'cancelno:' + r.id },
  ] }];
  v.embeds[0].footer = { text: 'Wirklich stornieren? Das löscht die Runde auch auf der Webseite.' };
  v.embeds[0].color = 0xc62828;
  return v;
}
function editModal(r) {
  const row = (custom_id, label, value, extra = {}) => ({ type: 1, components: [{ type: 4, custom_id, label, style: 1, value: String(value == null ? '' : value), required: true, ...extra }] });
  return { type: 9, data: { custom_id: 'edit:' + r.id, title: 'Spielrunde bearbeiten', components: [
    row('spiel', 'Spiel', r.game, { max_length: 120 }),
    row('datum', 'Datum (z. B. 17.11. oder 2026-11-17)', fmtDate(r.date), { max_length: 20 }),
    row('uhrzeit', 'Uhrzeit (HH:MM)', r.time || '18:00', { max_length: 5, min_length: 5 }),
    row('plaetze', 'Plätze inkl. Gastgeber (2–30)', r.seats, { max_length: 2 }),
    row('hinweis', 'Hinweis', r.note || '', { required: false, max_length: 200 }),
  ] } };
}

const who = (i) => {
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
  const date = parseDate(opt(i, 'datum')); if (!date) return say('Datum nicht verstanden. Beispiele: 2026-11-17, 17.11., heute, morgen.');
  const time = str(opt(i, 'uhrzeit') || '18:00', 5); if (!/^\d{2}:\d{2}$/.test(time)) return say('Uhrzeit bitte als HH:MM, z. B. 18:00.');
  const seats = Number(opt(i, 'plaetze') || 4); if (!(seats >= 2 && seats <= 30)) return say('Plätze: 2 bis 30.');
  const id = newId();
  await env.DB.prepare("INSERT INTO parties(id, game_id, game, guest, year, date, time, seats, host, host_key_hash, note, attendees, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'{}',?12)")
    .bind(id, gameId, game.slice(0, 120), 0, year, date, time, seats, w.name, await sha256('discord:' + w.id), str(opt(i, 'hinweis'), 200), new Date().toISOString()).run();
  const row = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();
  // Per REST posten, damit wir die Nachricht später aktualisieren können; sonst normale Antwort.
  try {
    if (i.channel_id && env.DISCORD_BOT_TOKEN) { await announceParty(env, id, i.channel_id); return say('Runde angelegt ✓ – sie steht jetzt im Kanal.'); }
  } catch (e) { console.log('announce failed', e && e.message); }
  return reply({ type: 4, data: { content: `**${w.name}** sucht Mitspielende!`, ...view(row) } });
}

async function cmdLog(i, env) {
  const raw = str(opt(i, 'spiel'), 160);
  let gameId = null, game = raw, year = null;
  const m = /^(\d+)\|(.*?)\|(\d*)$/.exec(raw);
  if (m) { gameId = +m[1]; game = m[2]; year = m[3] ? +m[3] : null; }
  const players = Number(opt(i, 'spieler')); if (!game || !(players >= 1 && players <= 99)) return say('Bitte Spiel und Spielerzahl angeben.');
  const date = parseDate(opt(i, 'datum') || 'heute'); if (!date) return say('Datum nicht verstanden.');
  const dur = opt(i, 'dauer');
  await env.DB.prepare('INSERT INTO plays(id, game_id, game, guest, year, date, players, winner, note, duration, first_play, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11)')
    .bind(newId(), gameId, game.slice(0, 120), 0, year, date, players, str(opt(i, 'sieger'), 80), str(opt(i, 'hinweis'), 200), dur ? Math.round(Number(dur)) : null, new Date().toISOString()).run();
  return say(`Eingetragen: ${game}, ${players} Spielende, ${fmtDate(date)} ✓`);
}

async function button(i, env) {
  const [act, id] = String(i.data.custom_id).split(':');
  const w = who(i);
  const row = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();
  if (!row) return say('Diese Runde gibt es nicht mehr.');
  if (!row.discord_msg && i.message && i.channel_id) await env.DB.prepare('UPDATE parties SET discord_channel = ?1, discord_msg = ?2 WHERE id = ?3').bind(i.channel_id, i.message.id, id).run();
  const isHost = (await sha256('discord:' + w.id)) === row.host_key_hash;
  const key = 'd' + w.id;
  if (act === 'join') {
    if (isHost) return say('Du bist der Gastgeber und hast schon einen Platz.');
    const r = await env.DB.prepare(`UPDATE parties SET attendees = json_set(attendees, '$.' || ?1, json(?2))
      WHERE id = ?3 AND play_id IS NULL AND (SELECT count(*) FROM json_each(parties.attendees) WHERE coalesce(json_extract(value, '$.out'), 0) = 0 AND key != ?1) + 1 < seats`)
      .bind(key, JSON.stringify({ name: w.name, at: new Date().toISOString() }), id).run();
    if (!r.meta.changes) return say('Leider schon voll.');
  } else if (act === 'leave') {
    if (isHost) return say('Als Gastgeber kannst du die Runde nur löschen (über die Webseite).');
    await env.DB.prepare("UPDATE parties SET attendees = json_set(attendees, '$.' || ?1 || '.out', 1) WHERE id = ?2 AND json_type(attendees, '$.' || ?1) IS NOT NULL").bind(key, id).run();
  } else if (act === 'log') {
    if (!isHost) return say('Nur der Gastgeber kann die Runde als gespielt registrieren.');
    if (!hasStarted(row)) return say(`Das geht erst, wenn der vereinbarte Termin erreicht ist (${fmtDate(row.date)}${row.time ? ', ' + row.time + ' Uhr' : ''}).`);
    if (!row.play_id) {
      const att = Object.values(JSON.parse(row.attendees || '{}')).filter((a) => !a.out).length + 1;
      const pid = newId();
      await env.DB.prepare('INSERT INTO plays(id, game_id, game, guest, year, date, players, winner, note, duration, first_play, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,0,?10)')
        .bind(pid, row.game_id, row.game, row.guest, row.year, row.date, att, '', 'Über Discord eingetragen', new Date().toISOString()).run();
      await env.DB.prepare('UPDATE parties SET play_id = ?1 WHERE id = ?2 AND play_id IS NULL').bind(pid, id).run();
    }
  } else if (act === 'edit') {
    if (!isHost) return say('Nur der Gastgeber kann die Runde bearbeiten.');
    if (row.play_id) return say('Die Runde ist schon als gespielt registriert.');
    return reply(editModal(row));
  } else if (act === 'cancel') {
    if (!isHost) return say('Nur der Gastgeber kann die Runde stornieren.');
    return reply({ type: 7, data: confirmView(row) });
  } else if (act === 'cancelno') {
    if (!isHost) return say('Nur der Gastgeber kann das entscheiden.');
  } else if (act === 'cancelyes') {
    if (!isHost) return say('Nur der Gastgeber kann die Runde stornieren.');
    await env.DB.prepare('DELETE FROM parties WHERE id = ?1').bind(id).run();
    return reply({ type: 7, data: { content: `~~${row.game}~~ – die Runde von **${row.host}** wurde storniert.`, embeds: [], components: [] } });
  } else return say('Unbekannte Aktion.');
  const fresh = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();
  return reply({ type: 7, data: view(fresh) });
}

async function editSubmit(i, env) {
  const id = String(i.data.custom_id).split(':')[1];
  const w = who(i);
  const row = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();
  if (!row) return say('Diese Runde gibt es nicht mehr.');
  if ((await sha256('discord:' + w.id)) !== row.host_key_hash) return say('Nur der Gastgeber kann die Runde bearbeiten.');
  if (row.play_id) return say('Die Runde ist schon als gespielt registriert.');
  const f = {};
  for (const r of i.data.components || []) for (const c of r.components || []) f[c.custom_id] = c.value;
  const game = str(f.spiel, 120); if (!game) return say('Das Spiel darf nicht leer sein.');
  const date = parseDate(f.datum); if (!date) return say('Datum nicht verstanden. Beispiele: 2026-11-17 oder 17.11.');
  const time = str(f.uhrzeit, 5); if (!/^\d{2}:\d{2}$/.test(time)) return say('Uhrzeit bitte als HH:MM, z. B. 18:00.');
  const seats = Number(f.plaetze);
  const taken = Object.values(JSON.parse(row.attendees || '{}')).filter((a) => !a.out).length + 1;
  if (!(seats >= 2 && seats <= 30) || seats < taken) return say(`Plätze: 2 bis 30, mindestens ${taken} (so viele sind schon dabei).`);
  const same = game === row.game;
  await env.DB.prepare('UPDATE parties SET game = ?1, game_id = ?2, year = ?3, date = ?4, time = ?5, seats = ?6, note = ?7 WHERE id = ?8')
    .bind(game, same ? row.game_id : null, same ? row.year : null, date, time, seats, str(f.hinweis, 200), id).run();
  const fresh = await env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();
  return reply({ type: 7, data: view(fresh) });
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
  if (env.DISCORD_CHANNEL_ID && i.channel_id !== env.DISCORD_CHANNEL_ID) {
    return i.type === 4 ? reply({ type: 8, data: { choices: [] } }) : say(`Bitte nutze den Bot nur im Kanal <#${env.DISCORD_CHANNEL_ID}>.`);
  }
  try {
    await ensureCols(env);
    if (i.type === 4) return await autocomplete(i, env, ctx);
    if (i.type === 2) return i.data.name === 'party' ? await cmdParty(i, env) : i.data.name === 'log' ? await cmdLog(i, env) : say('Unbekannter Befehl.');
    if (i.type === 3) return await button(i, env);
    if (i.type === 5) return await editSubmit(i, env);
  } catch (e) { console.log('discord error', e && e.message); return say('Da ist etwas schiefgelaufen. Bitte nochmal versuchen.'); }
  return say('Nicht unterstützt.');
}

const GAME = { type: 3, name: 'spiel', description: 'Spielname (Vorschläge von BoardGameGeek)', required: true, autocomplete: true };
export const COMMANDS = [
  { name: 'party', description: 'Spielrunde anlegen und Mitspielende suchen', options: [
    GAME,
    { type: 3, name: 'datum', description: 'Standard: nächster Dienstag. Format 2026-11-17, 17.11., heute, morgen' },
    { type: 3, name: 'uhrzeit', description: 'HH:MM, Standard 18:00' },
    { type: 4, name: 'plaetze', description: 'Plätze inkl. dir, Standard 4', min_value: 2, max_value: 30 },
    { type: 3, name: 'hinweis', description: 'Zusatzinfo, z. B. Regeln erklärt' },
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
async function discord(env, method, path, body) {
  const res = await fetch(api(env) + path, { method, headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error('discord ' + res.status + ' ' + (await res.text()).slice(0, 160));
  return res.json();
}
export const discordOn = (env) => !!(env.DISCORD_BOT_TOKEN && env.DISCORD_CHANNEL_ID);

// Spalten für die Verknüpfung mit der Discord-Nachricht (einmal pro Worker-Instanz prüfen).
let colsOk = false;
export async function ensureCols(env) {
  if (colsOk) return;
  const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('parties')").all();
  const have = new Set(results.map((r) => r.name));
  if (!have.has('discord_channel')) await env.DB.prepare('ALTER TABLE parties ADD COLUMN discord_channel TEXT').run();
  if (!have.has('discord_msg')) await env.DB.prepare('ALTER TABLE parties ADD COLUMN discord_msg TEXT').run();
  colsOk = true;
}

const getParty = (env, id) => env.DB.prepare('SELECT * FROM parties WHERE id = ?1').bind(id).first();

export async function announceParty(env, id, channelId) {
  channelId = channelId || env.DISCORD_CHANNEL_ID;
  const row = await getParty(env, id); if (!row) return null;
  const msg = await discord(env, 'POST', `/channels/${channelId}/messages`, { content: `**${row.host}** sucht Mitspielende!`, ...view(row) });
  await env.DB.prepare('UPDATE parties SET discord_channel = ?1, discord_msg = ?2 WHERE id = ?3').bind(channelId, msg.id, id).run();
  return msg.id;
}
export async function syncParty(env, id) {
  const row = await getParty(env, id);
  if (!row || !row.discord_msg) return;
  await discord(env, 'PATCH', `/channels/${row.discord_channel}/messages/${row.discord_msg}`, { content: `**${row.host}** sucht Mitspielende!`, ...view(row) });
}
export async function cancelPartyMessage(env, row) {
  if (!row || !row.discord_msg) return;
  await discord(env, 'PATCH', `/channels/${row.discord_channel}/messages/${row.discord_msg}`, { content: `~~${row.game}~~ – die Runde von **${row.host}** wurde storniert.`, embeds: [], components: [] });
}
