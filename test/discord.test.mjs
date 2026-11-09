import { verifySignature, nextTuesday, parseDate, COMMANDS } from '../src/discord.js';
import assert from 'node:assert/strict';
const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('hex');
const sign = async (m) => Buffer.from(await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(m))).toString('hex');
assert.equal(await verifySignature(pub, await sign('123{"type":1}'), '123', '{"type":1}'), true);
assert.equal(await verifySignature(pub, await sign('123{"type":1}'), '124', '{"type":1}'), false);
assert.equal(await verifySignature(pub, 'zz', '123', 'x'), false);
assert.equal(nextTuesday(new Date('2026-11-09T12:00:00Z')), '2026-11-10');   // Montag
assert.equal(nextTuesday(new Date('2026-11-10T10:00:00Z')), '2026-11-10');   // Dienstag vor 18 Uhr
assert.equal(nextTuesday(new Date('2026-11-10T18:30:00Z')), '2026-11-17');   // Dienstag nach 18 Uhr
assert.equal(parseDate('17.11.', new Date('2026-11-09T12:00:00Z')), '2026-11-17');
assert.equal(parseDate('01.01.', new Date('2026-11-09T12:00:00Z')), '2027-01-01');
assert.equal(parseDate('morgen', new Date('2026-11-09T12:00:00Z')), '2026-11-10');
assert.equal(parseDate('quatsch'), null);
assert.equal(COMMANDS.length, 2);
console.log('discord ok');
import { hasStarted } from '../src/discord.js';
assert.equal(hasStarted({ date: '2026-11-10', time: '18:00' }, new Date('2026-11-10T16:30:00Z')), false); // 17:30 Berlin
assert.equal(hasStarted({ date: '2026-11-10', time: '18:00' }, new Date('2026-11-10T17:00:00Z')), true);  // 18:00 Berlin
assert.equal(hasStarted({ date: '2026-11-10', time: '18:00' }, new Date('2026-11-09T23:00:00Z')), false);
assert.equal(hasStarted({ date: '2026-11-09', time: '18:00' }, new Date('2026-11-10T08:00:00Z')), true);
console.log('hasStarted ok');
