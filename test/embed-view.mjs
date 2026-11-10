import fs from 'node:fs'; import assert from 'node:assert/strict';
const { priv } = JSON.parse(fs.readFileSync('/tmp/dk.json', 'utf8'));
const key = await crypto.subtle.importKey('pkcs8', Buffer.from(priv, 'base64'), 'Ed25519', false, ['sign']);
const post = async (obj) => { const body = JSON.stringify(obj), ts = String(Date.now()); const sig = Buffer.from(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(ts + body))).toString('hex'); return (await fetch('http://localhost:8799/api/discord/interactions', { method: 'POST', headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body })).json(); };
const r = await post({ type: 2, guild_id: 'g1', member: { user: { id: '111222333', username: 'Hans' } }, data: { name: 'party', options: [{ name: 'spiel', value: '1084|Test|2000' }, { name: 'datum', value: '2099-01-05' }] } });
const e = r.data.embeds[0]; console.log(JSON.stringify({ title: e.title, description: e.description, thumb: e.thumbnail, fields: e.fields, footer: e.footer }, null, 1));
assert.equal(e.thumbnail.url, 'https://example.test/api/cover/1084'); assert.match(e.fields[1].value, /<@111222333>/);
process.exit(0);
