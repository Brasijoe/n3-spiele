import { parseThings } from '../src/games.js';
import assert from 'node:assert/strict';
const xml = `<?xml version="1.0" encoding="utf-8"?><items termsofuse="x">
<item type="boardgame" id="324856"><thumbnail>https://cf.geekdo-images.com/abc__thumb/img/x.jpg</thumbnail><image>https://cf.geekdo-images.com/abc__original/img/x.jpg</image>
<name type="primary" sortindex="1" value="Guards of Atlantis II" /><name type="alternate" sortindex="1" value="GoA 2" />
<description>Text</description><yearpublished value="2020" /><minplayers value="2" /><maxplayers value="10" /><playingtime value="45" /><minplaytime value="30" /><maxplaytime value="45" /><minage value="14" />
<poll name="suggested_numplayers" title="User Suggested Number of Players" totalvotes="100">
<results numplayers="2"><result value="Best" numvotes="3" /><result value="Recommended" numvotes="20" /><result value="Not Recommended" numvotes="30" /></results>
<results numplayers="3"><result value="Best" numvotes="10" /><result value="Recommended" numvotes="30" /><result value="Not Recommended" numvotes="5" /></results>
<results numplayers="4"><result value="Best" numvotes="40" /><result value="Recommended" numvotes="20" /><result value="Not Recommended" numvotes="2" /></results>
<results numplayers="5"><result value="Best" numvotes="9" /><result value="Recommended" numvotes="30" /><result value="Not Recommended" numvotes="1" /></results>
<results numplayers="6"><result value="Best" numvotes="1" /><result value="Recommended" numvotes="3" /><result value="Not Recommended" numvotes="10" /></results>
<results numplayers="6+"><result value="Best" numvotes="0" /><result value="Recommended" numvotes="1" /><result value="Not Recommended" numvotes="20" /></results></poll>
<link type="boardgamecategory" id="1022" value="Adventure" /><link type="boardgamemechanic" id="2" value="Team-Based Game" /><link type="boardgamedesigner" id="9" value="Mateusz Kopacz" />
<statistics page="1"><ratings><usersrated value="3721" /><average value="8.1234" /><bayesaverage value="7.4" /><ranks><rank type="subtype" id="1" name="boardgame" friendlyname="Board Game Rank" value="214" bayesaverage="7.4" /><rank type="family" id="5497" name="strategygames" friendlyname="Strategy Game Rank" value="120" bayesaverage="7.3" /><rank type="family" id="5498" name="thematic" friendlyname="Thematic Rank" value="Not Ranked" bayesaverage="Not Ranked" /></ranks><averageweight value="2.6" /></ratings></statistics></item>
<item type="boardgameexpansion" id="379999"><name type="primary" sortindex="1" value="Guards of Atlantis II: Tabletop MOBA &amp; Arcane Hero Pack" /><yearpublished value="2021" /><minplayers value="2" /><maxplayers value="10" /><playingtime value="45" />
<link type="boardgameexpansion" id="324856" value="Guards of Atlantis II" inbound="true" /></item></items>`;
const g = parseThings(xml);
assert.equal(g.length, 2);
const a = g[0];
assert.equal(a.n, 'Guards of Atlantis II'); assert.equal(a.y, 2020); assert.equal(a.p1, 2); assert.equal(a.p2, 10);
assert.equal(a.t1, 30); assert.equal(a.t2, 45); assert.equal(a.a, 14); assert.equal(a.r, 8.12); assert.equal(a.u, 3721); assert.equal(a.w, 2.6);
assert.equal(a.rank, 214); assert.equal(a.types, 'S'); assert.equal(a.best, '4'); assert.equal(a.rec, '3-5');
assert.deepEqual(a.cats, ['Adventure']); assert.deepEqual(a.mechs, ['Team-Based Game']); assert.equal(a.des, 'Mateusz Kopacz'); assert.equal(a.exp, 0);
assert.match(a.thumb, /geekdo-images/);
const e = g[1]; assert.equal(e.exp, 1); assert.equal(e.base, 324856); assert.equal(e.n, 'Guards of Atlantis II: Tabletop MOBA & Arcane Hero Pack'); assert.equal(e.rank, 0);
console.log('games parser ok');
