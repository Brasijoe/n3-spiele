// BGG-XML-API: Suche und GeekList. Reine Parser-Funktionen sind exportiert, damit sie sich testen lassen.

export function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();

export function parseSearch(xml, q, limit = 15) {
  const items = [];
  for (const m of xml.matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>/g)) {
    const id = +((/\bid="(\d+)"/.exec(m[1]) || [])[1] || 0);
    const type = (/\btype="([^"]+)"/.exec(m[1]) || [])[1];
    const nm = /<name\b[^>]*\bvalue="([^"]*)"/.exec(m[2]);
    const yr = /<yearpublished\b[^>]*\bvalue="(-?\d+)"/.exec(m[2]);
    if (!id || !nm) continue;
    items.push({ id, n: decodeXml(nm[1]), y: yr && +yr[1] > 0 ? +yr[1] : null, e: type === 'boardgameexpansion' });
  }
  const f = fold(q);
  const tier = (it) => { const k = fold(it.n); return (k === f ? 0 : k.startsWith(f) ? 1 : (' ' + k).includes(' ' + f) ? 2 : 3) + (it.e ? 0.5 : 0); };
  return items.sort((a, b) => tier(a) - tier(b) || a.n.length - b.n.length || (b.y || 0) - (a.y || 0)).slice(0, limit);
}

export function parseGeeklist(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item\b([^>]*)>/g)) {
    const id = /\bobjectid="(\d+)"/.exec(m[1]);
    const nm = /\bobjectname="([^"]*)"/.exec(m[1]);
    if (id && nm) items.push({ id: +id[1], n: decodeXml(nm[1]) });
  }
  return items;
}

const headers = (env) => ({ Authorization: 'Bearer ' + env.BGG_TOKEN, 'User-Agent': 'n3-spiele/1.0 (Nerd Nexus Nuernberg, non-commercial)', Accept: 'application/xml' });

export async function bggSearch(env, ctx, q) {
  q = q.trim().slice(0, 80);
  if (q.length < 2) return [];
  if (!env.BGG_TOKEN) throw Object.assign(new Error('no_token'), { code: 'no_token' });
  const cache = caches.default, key = new Request('https://cache.invalid/bgg-search/' + encodeURIComponent(fold(q)));
  const cached = await cache.match(key);
  if (cached) return cached.json();
  const res = await fetchRetry('https://boardgamegeek.com/xmlapi2/search?type=boardgame,boardgameexpansion&query=' + encodeURIComponent(q), { headers: headers(env) });
  if (res.status === 429 || res.status === 202) throw Object.assign(new Error('busy'), { code: 'bgg_busy' });
  if (!res.ok) throw Object.assign(new Error('bgg ' + res.status), { code: 'bgg_error' });
  const items = parseSearch(await res.text(), q);
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(items), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' } })));
  return items;
}

export async function refreshGeeklist(env) {
  if (!env.BGG_TOKEN) throw Object.assign(new Error('no_token'), { code: 'no_token' });
  const res = await fetchRetry('https://boardgamegeek.com/xmlapi2/geeklist/' + encodeURIComponent(env.GEEKLIST_ID || '387061'), { headers: headers(env) });
  if (res.status === 202 || res.status === 429) throw Object.assign(new Error('busy'), { code: 'bgg_busy' });
  if (!res.ok) throw Object.assign(new Error('bgg ' + res.status), { code: 'bgg_error' });
  const items = parseGeeklist(await res.text());
  if (!items.length) throw Object.assign(new Error('empty'), { code: 'bgg_empty' });
  const value = JSON.stringify({ fetchedAt: new Date().toISOString(), items });
  await env.DB.prepare("INSERT INTO config(key, value) VALUES('geeklist', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(value).run();
  return items.length;
}

// BGG answers 202 ("queued, try again") for big lists and 429 when busy: retry a few times.
async function fetchRetry(url, opts, tries = 4) {
  let res;
  for (let i = 0; i < tries; i++) {
    res = await fetch(url, opts);
    if (res.status !== 202 && res.status !== 429) return res;
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  return res;
}
