// Wer darf an welchem Tag eine Runde anbieten?
// - Mitglieder (Discord-Rolle aus der Verwaltung, z. B. „Mitglied“) an jedem Tag.
// - Alle anderen nur an Stammtisch-Tagen (Regel aus der Verwaltung, Standard: jeden Dienstag + erster Samstag im Monat),
//   mit Event-Code an den Eventtagen (wie bisher).
// Ist keine Mitgliederrolle eingetragen, gilt die Einschränkung nicht (alle dürfen jeden Tag).
// Startwert der Rolle: DISCORD_MEMBER_ROLE_ID aus wrangler.toml; sobald in der Verwaltung gespeichert wurde, gilt nur noch die Verwaltung.
// Einstellungen: config-Schlüssel 'booking' = { memberRole, weekdays:[0–6], monthly:[{nth:1–4|-1, wd:0–6}], extra:[ISO], skip:[ISO] }.

export const DEFAULT_BOOKING = { memberRole: '', weekdays: [2], monthly: [{ nth: 1, wd: 6 }], extra: [], skip: [] };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (s) => ISO.test(s) && !isNaN(Date.parse(s));
const wdOf = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();
const dayOf = (iso) => +iso.slice(8, 10);
const monthLen = (iso) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7), 0)).getUTCDate();
export const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Eingaben aus der Verwaltung säubern (alles optional, Unsinn fällt weg).
export function cleanBooking(b) {
  b = b || {};
  const wd = (x) => Number.isInteger(x) && x >= 0 && x <= 6;
  const dates = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter(isIso))].sort().slice(0, 200);
  return {
    memberRole: String(b.memberRole || '').replace(/\D/g, '').slice(0, 25),
    weekdays: [...new Set((Array.isArray(b.weekdays) ? b.weekdays : []).map(Number).filter(wd))].sort(),
    monthly: (Array.isArray(b.monthly) ? b.monthly : []).map((x) => ({ nth: Number(x && x.nth), wd: Number(x && x.wd) }))
      .filter((x) => [1, 2, 3, 4, -1].includes(x.nth) && wd(x.wd)).slice(0, 10),
    extra: dates(b.extra),
    skip: dates(b.skip),
  };
}

export async function getBooking(env) {
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'booking'").first();
  // Noch nichts gespeichert: Mitgliederrolle aus wrangler.toml (DISCORD_MEMBER_ROLE_ID) als Startwert.
  const def = { ...DEFAULT_BOOKING, memberRole: String(env.DISCORD_MEMBER_ROLE_ID || '').replace(/\D/g, '') };
  if (!row) return def;
  try { return cleanBooking(JSON.parse(row.value)); } catch { return def; }
}

export function isStammtisch(iso, rule) {
  if (!isIso(iso)) return false;
  if (rule.skip.includes(iso)) return false;
  if (rule.extra.includes(iso)) return true;
  const wd = wdOf(iso), d = dayOf(iso);
  if (rule.weekdays.includes(wd)) return true;
  return rule.monthly.some((x) => x.wd === wd && (x.nth === -1 ? d + 7 > monthLen(iso) : Math.ceil(d / 7) === x.nth));
}

// Die nächsten Stammtisch-Tage ab (einschließlich) fromIso, höchstens `days` Tage voraus.
export function nextStammtische(fromIso, rule, count = 8, days = 120) {
  const out = [];
  for (let i = 0, d = fromIso; i <= days && out.length < count; i++, d = addDays(d, 1)) if (isStammtisch(d, rule)) out.push(d);
  return out;
}

// Gehört diese Person zu den Mitgliedern? roles = Rollen-IDs aus Discord (Array oder JSON-Text, null = unbekannt).
export function isMember(rule, roles) {
  if (!rule.memberRole) return true;
  if (typeof roles === 'string') { try { roles = JSON.parse(roles); } catch { roles = null; } }
  return Array.isArray(roles) && roles.includes(rule.memberRole);
}

// Darf jemand ohne Mitgliederrolle an diesem Tag? Gibt null oder einen Fehlercode zurück.
export function checkBookingDate(rule, roles, date) {
  if (isMember(rule, roles)) return null;
  return isStammtisch(date, rule) ? null : 'stammtisch_only';
}

const WD_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const NTH_DE = { 1: 'ersten', 2: 'zweiten', 3: 'dritten', 4: 'vierten', '-1': 'letzten' };
// Kurzer Text für Discord, z. B. „jeden Dienstag, am ersten Samstag im Monat“.
export function ruleText(rule) {
  const parts = rule.weekdays.map((w) => 'jeden ' + WD_DE[w]).concat(rule.monthly.map((x) => `am ${NTH_DE[x.nth]} ${WD_DE[x.wd]} im Monat`));
  return parts.join(', ') || 'an den Stammtisch-Terminen';
}

// Vorstellung im Hinweis (nur Nicht-Mitglieder ohne Event-Code): mindestens INTRO_MIN Zeichen.
export const INTRO_MIN = 40;
export const introOk = (note) => String(note || '').trim().length >= INTRO_MIN;
export const INTRO_HELP = 'Stell dich im Hinweis kurz vor (mind. ' + INTRO_MIN + ' Zeichen): wer du bist, ob du schon mal bei uns warst, wie gut du das Spiel kennst und ob du es erklären kannst oder erklärt bekommen möchtest.';
