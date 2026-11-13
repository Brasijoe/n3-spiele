// Datensicherung der D1-Datenbank als SQL-Datei.
// Nachts (Cron 03:17 UTC) in den privaten R2-Bucket (Binding BACKUP), die letzten KEEP Sicherungen bleiben liegen.
// Zusätzlich in der Verwaltung als Download (Kopie außerhalb von Cloudflare).
// Wiederherstellen: wrangler d1 execute n3-spiele --remote --file=<datei>.sql (siehe README, „Datensicherung“).

export const KEEP = 30;
const PREFIX = 'd1/';
// Kurzlebige Tabellen: Struktur ja, Inhalt nein (Zähler für Ratenbegrenzung, Login-Übergaben von wenigen Minuten).
const SKIP_DATA = new Set(['rate', 'auth_handoff']);
const PAGE = 500;

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';

export function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Array.isArray(v)) {
    const bytes = Array.isArray(v) ? v : Array.from(new Uint8Array(v.buffer || v, v.byteOffset || 0, v.byteLength));
    return "X'" + bytes.map((b) => (b & 255).toString(16).padStart(2, '0')).join('') + "'";
  }
  return q(v);
}

// Komplette Datenbank als SQL-Text: pro Tabelle DROP + CREATE + INSERTs, danach die Indizes.
// Ohne BEGIN/COMMIT, weil `wrangler d1 execute` keine eigenen Transaktionen erlaubt.
export async function dumpDb(env) {
  const { results: objs } = await env.DB.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY type DESC, name"
  ).all();
  const tables = objs.filter((o) => o.type === 'table');
  const rest = objs.filter((o) => o.type !== 'table');
  const out = [
    '-- N3 Spielesammlung: Sicherung der D1-Datenbank',
    '-- Erstellt: ' + new Date().toISOString(),
    '-- Wiederherstellen: npx wrangler d1 execute n3-spiele --remote --file=<diese Datei>',
    '-- ACHTUNG: ersetzt alle Tabellen der Datenbank durch den Stand dieser Datei.',
    'PRAGMA defer_foreign_keys = TRUE;',
    '',
  ];
  const counts = {};
  for (const t of tables) {
    out.push('DROP TABLE IF EXISTS ' + ident(t.name) + ';', t.sql + ';');
    let n = 0;
    if (!SKIP_DATA.has(t.name)) {
      for (let off = 0; ; off += PAGE) {
        const { results } = await env.DB.prepare('SELECT * FROM ' + ident(t.name) + ' ORDER BY rowid LIMIT ?1 OFFSET ?2').bind(PAGE, off).all();
        for (const r of results) {
          const cols = Object.keys(r);
          out.push('INSERT INTO ' + ident(t.name) + ' (' + cols.map(ident).join(', ') + ') VALUES (' + cols.map((c) => sqlValue(r[c])).join(', ') + ');');
        }
        n += results.length;
        if (results.length < PAGE) break;
      }
    }
    counts[t.name] = n;
    out.push('');
  }
  for (const o of rest) out.push(o.sql + ';');
  out.push('');
  return { sql: out.join('\n'), counts };
}

const keyFor = (d = new Date()) => PREFIX + d.toISOString().slice(0, 19).replace(/:/g, '-') + 'Z.sql';
export const validKey = (k) => typeof k === 'string' && /^d1\/[0-9TZ-]+\.sql$/.test(k);

// Neue Sicherung in R2 ablegen und ältere über KEEP hinaus löschen.
export async function backupToR2(env) {
  if (!env.BACKUP) { const e = new Error('no_bucket'); e.code = 'no_bucket'; throw e; }
  const { sql, counts } = await dumpDb(env);
  const key = keyFor();
  await env.BACKUP.put(key, sql, { httpMetadata: { contentType: 'application/sql; charset=utf-8' }, customMetadata: { counts: JSON.stringify(counts) } });
  const all = await listBackups(env);
  const old = all.slice(KEEP).map((o) => o.key);
  if (old.length) await env.BACKUP.delete(old);
  return { key, size: sql.length, counts, removed: old.length };
}

// Neueste zuerst.
export async function listBackups(env) {
  if (!env.BACKUP) return [];
  const items = [];
  let cursor;
  do {
    const r = await env.BACKUP.list({ prefix: PREFIX, cursor });
    for (const o of r.objects) items.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() });
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return items.sort((a, b) => (a.key < b.key ? 1 : -1));
}

export function sqlDownload(body, name) {
  return new Response(body, { headers: { 'content-type': 'application/sql; charset=utf-8', 'content-disposition': 'attachment; filename="' + name + '"', 'cache-control': 'no-store' } });
}
