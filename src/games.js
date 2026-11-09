// Spiele aus der BGG-GeekList automatisch übernehmen: Daten über die BGG-XML-API (thing, stats=1) holen und in D1 speichern.
import { decodeXml } from './bgg.js';

const attr = (s, re) => { const m = re.exec(s); return m ? decodeXml(m[1]) : null; };
const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? 0 : Number(v));

// "1,2,3,5+" -> "1-3,5+"  (Format wie in der Seite: Bereiche, letzter Wert evtl. mit +)
function ranges(list) {
  const nums = [...new Set(list.map((x) => x.n))].sort((a, b) => a - b);
  const plus = list.find((x) => x.plus);
  const out = []; let i = 0;
  while (i < nums.length) {
    let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    const isPlus = plus && nums[j] === plus.n;
    out.push(nums[i] === nums[j] ? nums[i] + (isPlus ? '+' : '') : nums[i] + '-' + nums[j] + (isPlus ? '+' : ''));
    i = j + 1;
  }
  return out.join(',');
}

const SUB = { strategygames: 'S', familygames: 'F', thematic: 'T', partygames: 'P', abstracts: 'A', childrensgames: 'K', wargames: 'W' };

export function parseThings(xml) {
  const games = [];
  for (const m of xml.matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>/g)) {
    const head = m[1], b = m[2];
    const id = +(attr(head, /\bid="(\d+)"/) || 0), type = attr(head, /\btype="([^"]+)"/);
    const name = attr(b, /<name\b[^>]*\btype="primary"[^>]*\bvalue="([^"]*)"/) || attr(b, /<name\b[^>]*\bvalue="([^"]*)"/);
    if (!id || !name) continue;
    const bestL = [], recL = [];
    const poll = /<poll\b[^>]*name="suggested_numplayers"[\s\S]*?<\/poll>/.exec(b);
    if (poll) {
      for (const r of poll[0].matchAll(/<results\b[^>]*numplayers="([^"]+)"[^>]*>([\s\S]*?)<\/results>/g)) {
        const plus = r[1].endsWith('+'), n = parseInt(r[1], 10);
        if (!n) continue;
        const v = (label) => num(attr(r[2], new RegExp('<result\\b[^>]*value="' + label + '"[^>]*numvotes="(\\d+)"')));
        const best = v('Best'), rec = v('Recommended'), not = v('Not Recommended');
        if (best + rec + not === 0) continue;
        if (best >= rec && best >= not && best > 0) bestL.push({ n, plus });
        if (best + rec > not) recL.push({ n, plus });
      }
    }
    const ranks = [...b.matchAll(/<rank\b[^>]*\bname="([^"]+)"[^>]*\bvalue="([^"]*)"/g)];
    const rankV = ranks.find((x) => x[1] === 'boardgame');
    const types = ranks.filter((x) => SUB[x[1]] && /^\d+$/.test(x[2])).map((x) => SUB[x[1]]).join('');
    const links = (t) => [...b.matchAll(new RegExp('<link\\b[^>]*type="' + t + '"[^>]*>', 'g'))].map((x) => ({ id: +attr(x[0], /\bid="(\d+)"/), v: attr(x[0], /\bvalue="([^"]*)"/), inbound: /inbound="true"/.test(x[0]) }));
    const thumb = /<thumbnail>\s*([^<\s]+)\s*<\/thumbnail>/.exec(b) || /<image>\s*([^<\s]+)\s*<\/image>/.exec(b);
    const t1 = num(attr(b, /<minplaytime\b[^>]*value="(\d+)"/)) || num(attr(b, /<playingtime\b[^>]*value="(\d+)"/));
    const t2 = num(attr(b, /<maxplaytime\b[^>]*value="(\d+)"/)) || t1;
    games.push({
      id, n: name, y: num(attr(b, /<yearpublished\b[^>]*value="(-?\d+)"/)) || null,
      p1: num(attr(b, /<minplayers\b[^>]*value="(\d+)"/)) || 1, p2: num(attr(b, /<maxplayers\b[^>]*value="(\d+)"/)) || 1,
      t1, t2: t2 === t1 ? 0 : t2, a: num(attr(b, /<minage\b[^>]*value="(\d+)"/)),
      r: Math.round(num(attr(b, /<average\b[^>]*value="([\d.]+)"/)) * 100) / 100, br: Math.round(num(attr(b, /<bayesaverage\b[^>]*value="([\d.]+)"/)) * 100) / 100,
      u: num(attr(b, /<usersrated\b[^>]*value="(\d+)"/)), w: Math.round(num(attr(b, /<averageweight\b[^>]*value="([\d.]+)"/)) * 100) / 100,
      rank: rankV && /^\d+$/.test(rankV[2]) ? +rankV[2] : 0, best: ranges(bestL), rec: ranges(recL),
      cats: links('boardgamecategory').map((x) => x.v), mechs: links('boardgamemechanic').map((x) => x.v),
      des: (links('boardgamedesigner')[0] || {}).v || '', exp: type === 'boardgameexpansion' ? 1 : 0,
      base: (links('boardgameexpansion').find((x) => x.inbound) || {}).id || 0, types, thumb: thumb ? thumb[1] : '',
    });
  }
  return games;
}

const headers = (env) => ({ Authorization: 'Bearer ' + env.BGG_TOKEN, 'User-Agent': 'n3-spiele/1.0 (Nerd Nexus Nuernberg, non-commercial)', Accept: 'application/xml' });

async function fetchThings(env, ids) {
  let res;
  for (let i = 0; i < 4; i++) {
    res = await fetch('https://boardgamegeek.com/xmlapi2/thing?stats=1&id=' + ids.join(','), { headers: headers(env) });
    if (res.status !== 202 && res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  if (res.status === 202 || res.status === 429) throw Object.assign(new Error('busy'), { code: 'bgg_busy' });
  if (!res.ok) throw Object.assign(new Error('bgg ' + res.status), { code: 'bgg_error' });
  return parseThings(await res.text());
}

let tableOk = false;
export async function ensureExtra(env) {
  if (tableOk) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS extra_games (id INTEGER PRIMARY KEY, data TEXT NOT NULL, thumb TEXT NOT NULL DEFAULT \'\', updated_at TEXT NOT NULL)').run();
  tableOk = true;
}

// IDs der fest eingebauten Spiele (aus der ausgelieferten Seite).
let builtIn = null;
async function builtInIds(env) {
  if (builtIn) return builtIn;
  const res = await env.ASSETS.fetch(new Request('https://assets.local/index.html'));
  const m = /<script type="application\/json" id="gameData">([\s\S]*?)<\/script>/.exec(await res.text());
  builtIn = new Set(JSON.parse(m[1]).g.map((x) => x[0]));
  return builtIn;
}

// Fehlende GeekList-Einträge von BGG holen und speichern. Gibt die Anzahl neu übernommener Spiele zurück.
export async function syncExtras(env) {
  if (!env.BGG_TOKEN) throw Object.assign(new Error('no_token'), { code: 'no_token' });
  await ensureExtra(env);
  const gl = await env.DB.prepare("SELECT value FROM config WHERE key = 'geeklist'").first();
  if (!gl) return 0;
  const items = JSON.parse(gl.value).items;
  const known = new Set(await builtInIds(env));
  (await env.DB.prepare('SELECT id FROM extra_games').all()).results.forEach((r) => known.add(r.id));
  const missing = [...new Set(items.map((i) => i.id))].filter((id) => !known.has(id)).slice(0, 40);
  let added = 0;
  for (let i = 0; i < missing.length; i += 20) {
    const games = await fetchThings(env, missing.slice(i, i + 20));
    for (const g of games) {
      const { thumb, ...data } = g;
      await env.DB.prepare('INSERT INTO extra_games(id, data, thumb, updated_at) VALUES(?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET data = excluded.data, thumb = excluded.thumb, updated_at = excluded.updated_at')
        .bind(g.id, JSON.stringify(data), thumb, new Date().toISOString()).run();
      added++;
    }
  }
  return added;
}

export async function listExtras(env) {
  await ensureExtra(env);
  const { results } = await env.DB.prepare('SELECT data FROM extra_games ORDER BY id').all();
  return results.map((r) => JSON.parse(r.data));
}

// Cover: gleiche Herkunft wie die Seite, damit der Browser keine Drittanbieter anspricht (24 h Edge-Cache).
export async function coverResponse(env, ctx, id) {
  await ensureExtra(env);
  const row = await env.DB.prepare('SELECT thumb FROM extra_games WHERE id = ?1').bind(id).first();
  if (!row || !row.thumb) return new Response('not found', { status: 404 });
  let u; try { u = new URL(row.thumb); } catch { return new Response('bad', { status: 404 }); }
  if (u.protocol !== 'https:' || !/(^|\.)geekdo-images\.com$/.test(u.hostname)) return new Response('forbidden', { status: 403 });
  const cache = caches.default, key = new Request('https://cache.invalid/cover/' + id);
  const hit = await cache.match(key); if (hit) return hit;
  const res = await fetch(u.toString(), { headers: { 'User-Agent': 'n3-spiele/1.0' } });
  if (!res.ok) return new Response('upstream', { status: 502 });
  const out = new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') || 'image/jpeg', 'cache-control': 'public, max-age=604800' } });
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}
