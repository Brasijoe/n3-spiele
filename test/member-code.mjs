// /code in Discord -> Webseite akzeptiert den Code; Runde gehört dem Discord-Konto. Läuft gegen test/reset.sh (DISCORD_PUBLIC_KEY aus /tmp/dk.json, DISCORD_GUILD_ID=g1).
import fs from 'node:fs';
import assert from 'node:assert/strict';
const { priv } = JSON.parse(fs.readFileSync('/tmp/dk.json', 'utf8'));
const key = await crypto.subtle.importKey('pkcs8', Buffer.from(priv, 'base64'), 'Ed25519', false, ['sign']);
const post = async (obj) => {
  const body = JSON.stringify(obj), ts = String(Date.now());
  const sig = Buffer.from(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(ts + body))).toString('hex');
  return (await fetch('http://localhost:8799/api/discord/interactions', { method: 'POST', headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body })).json();
};
const W = 'http://localhost:8799/api';
const user = (id, name) => ({ member: { user: { id, username: name } } });
const web = (code, body) => fetch(W + '/parties', { method: 'POST', headers: { 'content-type': 'application/json', 'x-member-code': code }, body: JSON.stringify(body) });
let r = await post({ type: 2, guild_id: 'g1', ...user('555', 'Eva'), data: { name: 'code' } });
const m = /`([A-Z0-9]{4}-[A-Z0-9]{4})`/.exec(r.data.content); assert.ok(m, r.data.content); const code = m[1];
console.log('code issued:', code.replace(/./g, '*'));
const party = { game: 'Azul', date: '2099-01-05', time: '18:00', seats: 4, host: 'Fake' };
assert.equal((await web('', party)).status, 403);
assert.equal((await web('AAAA-BBBB', party)).status, 403);
r = await web(code.toLowerCase().replace('-', ' '), party); assert.equal(r.status, 200);   // Schreibweise egal
const created = await r.json();
const list = await (await fetch(W + '/parties')).json(); assert.equal(list[0].host, 'Eva'); console.log('host name from Discord:', list[0].host);
// Erneuter /code macht den alten Code ungültig
r = await post({ type: 2, guild_id: 'g1', ...user('555', 'Eva'), data: { name: 'code' } });
const code2 = /`([A-Z0-9]{4}-[A-Z0-9]{4})`/.exec(r.data.content)[1]; assert.notEqual(code, code2);
assert.equal((await web(code, party)).status, 403); assert.equal((await web(code2, party)).status, 200);
// Die Eva darf ihre Webrunde in Discord verwalten, jemand anderes nicht
const click = (id, name) => post({ type: 3, guild_id: 'g1', ...user(id, name), data: { custom_id: 'manage:' + created.id } });
assert.equal((await click('555', 'Eva')).data.flags, 64); assert.match((await click('556', 'Fritz')).data.content, /Ersteller/);
assert.equal((await click('555', 'Eva')).data.components[0].components.length, 3); console.log('web round manageable by its Discord owner ok');
process.exit(0);
