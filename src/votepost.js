// Wunschspiele in Discord: einige Tage vor jedem Stammtisch postet der Bot im Runden-Kanal eine Abstimmung
// (Top-Wünsche mit 👍-Knöpfen, die für diesen Tag schon geplanten Runden, Link zur Webseite). Die Nachricht wird bei jeder
// Stimme (Webseite oder Discord) und im 20-Minuten-Takt aktualisiert. Ist der Stammtisch vorbei, wird sie als beendet markiert
// (Knöpfe weg) und für den nächsten Stammtisch eine neue gepostet.
// Einstellungen in der Verwaltung (config 'booking'): votePostDays (0 = aus, Standard 5), votePing (here | role | none).
// Zustand in config 'vote_post' = { day, ch, msg, h }.
import { discord, channelIds, discordOn, berlin, fmtDate, wdName, who, say, reply, seatInfo } from './discord.js';
import { getBooking, addDays } from './booking.js';
import { ensureVotes, voteDay, voteList, castVote, VOTE_MAX } from './votes.js';
import { clubGameList } from './games.js';
import { listMemberGames } from './membergames.js';

const LIST_N = 10, BTN_N = 5;
const clean = (s) => String(s || '').replace(/[[\]*_~`|]/g, '');
const WD_LONG = { So: 'Sonntag', Mo: 'Montag', Di: 'Dienstag', Mi: 'Mittwoch', Do: 'Donnerstag', Fr: 'Freitag', Sa: 'Samstag' };
const dayTxt = (day) => `${WD_LONG[wdName(day)]}, ${fmtDate(day).slice(0, 6)}`;
const webUrl = (env) => (env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/$/, '') + '/#stammtisch' : '');
const link = (env, r) => (r.discord_msg && env.DISCORD_GUILD_ID ? `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${r.discord_channel}/${r.discord_msg}` : '');

async function getState(env) { const r = await env.DB.prepare("SELECT value FROM config WHERE key = 'vote_post'").first(); try { return r ? JSON.parse(r.value) : {}; } catch { return {}; } }
const setState = (env, v) => env.DB.prepare("INSERT INTO config(key, value) VALUES('vote_post', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(v)).run();
export async function votePostLink(env) { const s = await getState(env); return s.msg && s.day && env.DISCORD_GUILD_ID ? { day: s.day, url: `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${s.ch}/${s.msg}` } : null; }

// Runden, die für den Tag schon geplant sind (noch nicht als gespielt eingetragen).
async function plannedRounds(env, day) {
  const { results } = await env.DB.prepare('SELECT * FROM parties WHERE date = ?1 AND play_id IS NULL ORDER BY time').bind(day).all();
  return results;
}
const sameGame = (v, r) => (v.gameId ? Number(r.game_id) === Number(v.gameId) : String(r.game).trim().toLowerCase() === String(v.game).trim().toLowerCase());

export async function pollMessage(env, day, closed = false) {
  await ensureVotes(env);
  const list = await voteList(env, day), rounds = await plannedRounds(env, day);
  const lines = list.slice(0, LIST_N).map((v, i) => {
    const r = rounds.find((x) => sameGame(v, x));
    const names = v.names.slice(0, 6).map(clean).join(', ') + (v.names.length > 6 ? ' …' : '');
    return `${i + 1}. **${clean(v.game)}** · 👍 ${v.n} (${names})${r ? ` · 📅 Runde ${r.time || ''} geplant` : ''}`;
  });
  let desc = closed ? 'Die Abstimmung ist vorbei. Danke fürs Mitmachen!' : `Was wollt ihr beim Stammtisch spielen? Jede Person hat bis zu ${VOTE_MAX} Stimmen. Stimmt unten für die Top-Wünsche ab. Mit ➕ schlagt ihr ein anderes Spiel aus der Sammlung oder den Mitgliederspielen vor. Wer eine Runde anbietet, sieht so, was gefragt ist.`;
  desc += '\n\n**🗳️ Wünsche**\n' + (lines.length ? lines.join('\n') : '_Noch keine Wünsche. Mach den Anfang!_');
  if (list.length > LIST_N) desc += `\n… und ${list.length - LIST_N} weitere auf der Webseite`;
  if (rounds.length) {
    desc += '\n\n**📅 Schon geplant**\n' + rounds.slice(0, 15).map((r) => { const { taken, free } = seatInfo(r), l = link(env, r); return `${r.time ? r.time + ' · ' : ''}${l ? `[${clean(r.game)}](${l})` : `**${clean(r.game)}**`} · ${taken}/${r.seats} dabei · ${free ? `noch ${free} frei` : 'voll'}`; }).join('\n');
  }
  if (desc.length > 3900) desc = desc.slice(0, 3890) + ' …';
  const voters = new Set(list.flatMap((v) => v.names)).size, votes = list.reduce((n, v) => n + v.n, 0);
  const embed = { title: `🗳️ Wunschspiele für ${dayTxt(day)}${closed ? ' (beendet)' : ''}`, description: desc, color: 0x2f6fb0, footer: { text: `${votes} Stimme${votes === 1 ? '' : 'n'} von ${voters} Person${voters === 1 ? '' : 'en'}${closed ? '' : ' · Nochmal klicken nimmt die Stimme zurück'}` } };
  const components = [];
  if (!closed) {
    const btns = list.slice(0, BTN_N).filter((v) => ('vote:' + v.key).length <= 100).map((v) => ({ type: 2, style: 2, custom_id: 'vote:' + v.key, label: `${v.game}`.slice(0, 70) + ` (${v.n})`, emoji: { name: '👍' } }));
    if (btns.length) components.push({ type: 1, components: btns });
    const row = [{ type: 2, style: 1, custom_id: 'voteadd', label: 'Anderes Spiel vorschlagen', emoji: { name: '➕' } }], web = webUrl(env);
    if (web) row.push({ type: 2, style: 5, label: 'Zur Webseite / Runde anbieten', url: web });
    components.push({ type: 1, components: row });
  }
  return { embeds: [embed], components };
}

// 20-Minuten-Takt (und nach jeder Stimme): posten, aktualisieren oder beenden.
export async function syncVotePoll(env, now = new Date()) {
  if (!discordOn(env)) return '';
  const rule = await getBooking(env), ch = channelIds(env)[0], st = await getState(env), day = await voteDay(env);
  // Alter Post (Stammtisch vorbei): als beendet markieren.
  if (st.msg && st.day && st.day !== day) {
    try { await discord(env, 'PATCH', `/channels/${st.ch}/messages/${st.msg}`, await pollMessage(env, st.day, true)); } catch (e) { console.log('vote post close failed', e && e.message); }
    await setState(env, {});
    st.msg = null;
  }
  if (!day || !rule.votePostDays) return '';
  if (st.msg && st.day === day) {
    const body = await pollMessage(env, day), h = JSON.stringify(body);
    if (h === st.h) return '';
    try { await discord(env, 'PATCH', `/channels/${st.ch}/messages/${st.msg}`, body); await setState(env, { ...st, h }); return 'updated'; }
    catch (e) { if (!/discord 404/.test(e.message)) throw e; await setState(env, {}); return 'gone'; } // gelöscht: nicht neu posten
  }
  if (st.day === day) return ''; // schon gepostet und von Hand gelöscht
  const b = berlin(now), from = addDays(day, -rule.votePostDays);
  if (b.date < from || (b.date === from && b.hour < 12)) return '';
  const body = await pollMessage(env, day);
  const role = rule.memberRole, ping = rule.votePing === 'here' ? '@here ' : rule.votePing === 'role' && role ? `<@&${role}> ` : '';
  const msg = await discord(env, 'POST', `/channels/${ch}/messages`, { ...body, content: `${ping}🗳️ Was wollt ihr am ${dayTxt(day)} spielen? Stimmt ab!`, allowed_mentions: rule.votePing === 'here' ? { parse: ['everyone'] } : ping ? { roles: [role] } : { parse: [] } });
  await setState(env, { day, ch, msg: msg.id, h: JSON.stringify(body) });
  return 'posted';
}

// 👍-Knopf in Discord: Stimme setzen oder zurücknehmen (gleiche Regeln wie auf der Webseite).
export async function votePollButton(i, env, ctx) {
  const key = String(i.data.custom_id).slice(5), w = who(i), day = await voteDay(env);
  if (!day) return say('Gerade ist kein Stammtisch geplant.');
  await ensureVotes(env);
  const st = await getState(env);
  if (st.day !== day || (i.message && i.message.id !== st.msg)) return say('Diese Abstimmung ist vorbei.');
  const v = (await voteList(env, day)).find((x) => x.key === key);
  if (!v) return say('Das Spiel steht nicht mehr auf der Liste. Wähle es auf der Webseite.');
  const mine = (await env.DB.prepare('SELECT 1 FROM votes WHERE day = ?1 AND game_key = ?2 AND discord_id = ?3').bind(day, key, w.id).first());
  const res = await castVote(env, day, w.id, w.name, { game: v.game, gameId: v.gameId, year: v.year, mem: v.mem }, !mine);
  if (res === 'vote_limit') return say(`Du hast schon ${VOTE_MAX} Stimmen für diesen Stammtisch vergeben. Nimm erst eine zurück (nochmal auf den Knopf oder auf der Webseite).`);
  if (res === 'in_round') return say(`Du bist bei der geplanten Runde mit **${clean(v.game)}** dabei. Das zählt schon automatisch als deine Stimme.`);
  ctx.waitUntil(syncVotePoll(env).catch((e) => console.log('vote post refresh failed', e && e.message)));
  const left = VOTE_MAX - (await env.DB.prepare('SELECT COUNT(*) AS n FROM votes WHERE day = ?1 AND discord_id = ?2').bind(day, w.id).first()).n;
  return say(mine ? `Deine Stimme für **${clean(v.game)}** ist zurückgenommen.` : `👍 Notiert: Du willst am ${dayTxt(day)} **${clean(v.game)}** spielen. Noch ${left} Stimme${left === 1 ? '' : 'n'} übrig. Nochmal klicken nimmt sie zurück.`);
}

// ➕ Anderes Spiel vorschlagen: Formular mit Spielname, dann Suche in Sammlung + Mitgliederspielen.
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
async function candidates(env) {
  const club = await clubGameList(env), mem = await listMemberGames(env).catch(() => []), seen = new Set(), out = [];
  for (const g of club) { const k = g.gameId ? 'g' + g.gameId : 'n' + norm(g.game); if (!seen.has(k)) { seen.add(k); out.push({ ...g, k }); } }
  for (const g of mem) { const k = g.gameId ? 'g' + g.gameId : 'm' + g.id; if (!seen.has(k)) { seen.add(k); out.push({ gameId: g.gameId || null, game: g.game, year: g.year || null, mem: true, k }); } }
  return out;
}
export function findGames(all, q) {
  const n = norm(q);
  if (!n) return [];
  const exact = all.filter((g) => norm(g.game) === n);
  if (exact.length) return exact;
  const words = n.split(' ');
  return all.filter((g) => { const x = norm(g.game); return words.every((w) => x.includes(w)); })
    .sort((a, b) => norm(a.game).indexOf(words[0]) - norm(b.game).indexOf(words[0]) || a.game.length - b.game.length);
}

async function addVote(i, env, ctx, g) {
  const w = who(i), day = await voteDay(env);
  if (!day) return say('Gerade ist kein Stammtisch geplant.');
  await ensureVotes(env);
  const res = await castVote(env, day, w.id, w.name, { game: g.game, gameId: g.gameId, year: g.year, mem: g.mem }, true);
  if (res === 'vote_limit') return say(`Du hast schon ${VOTE_MAX} Stimmen für diesen Stammtisch vergeben. Nimm erst eine zurück (Knopf im Post oder auf der Webseite).`);
  if (res === 'in_round') return say(`Du bist bei der geplanten Runde mit **${clean(g.game)}** dabei. Das zählt schon automatisch als deine Stimme.`);
  ctx.waitUntil(syncVotePoll(env).catch((e) => console.log('vote post refresh failed', e && e.message)));
  const left = VOTE_MAX - (await env.DB.prepare('SELECT COUNT(*) AS n FROM votes WHERE day = ?1 AND discord_id = ?2').bind(day, w.id).first()).n;
  return say(`👍 Notiert: Du willst am ${dayTxt(day)} **${clean(g.game)}** spielen. Noch ${left} Stimme${left === 1 ? '' : 'n'} übrig.`);
}

export async function voteAddButton(i, env, ctx) {
  const cid = String(i.data.custom_id);
  if (cid === 'voteadd') {
    return reply({ type: 9, data: { custom_id: 'voteadd', title: 'Spiel für den Stammtisch vorschlagen', components: [
      { type: 1, components: [{ type: 4, custom_id: 'q', label: 'Spielname (Sammlung oder Mitgliederspiele)', style: 1, min_length: 2, max_length: 100, required: true, placeholder: 'z. B. Azul' }] }] } });
  }
  const g = (await candidates(env)).find((x) => x.k === cid.slice(8));
  if (!g) return say('Das Spiel habe ich nicht mehr gefunden.');
  return addVote(i, env, ctx, g);
}

export async function voteAddSubmit(i, env, ctx) {
  const q = ((i.data.components || []).flatMap((r) => r.components || []).find((c) => c.custom_id === 'q') || {}).value || '';
  const hits = findGames(await candidates(env), q), web = webUrl(env);
  if (!hits.length) return say(`„${clean(q)}“ habe ich weder in der Club-Sammlung noch bei den Mitgliederspielen gefunden. Versuch es mit einem anderen Namen${web ? ` oder such auf der Webseite: ${web}` : '.'}`);
  if (hits.length === 1) return addVote(i, env, ctx, hits[0]);
  const btns = hits.slice(0, 5).filter((g) => ('voteadd:' + g.k).length <= 100).map((g) => ({ type: 2, style: 2, custom_id: 'voteadd:' + g.k, label: (g.game + (g.year ? ` (${g.year})` : '') + (g.mem ? ' · Mitglied' : '')).slice(0, 80) }));
  return reply({ type: 4, data: { flags: 64, content: `Ich habe ${hits.length} passende Spiele gefunden${hits.length > 5 ? ', hier die ersten 5' : ''}. Welches meinst du?`, components: [{ type: 1, components: btns }] } });
}
