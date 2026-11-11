import { parseSearch, parseGeeklist, parseCollection, decodeXml } from '../src/bgg.js';
import assert from 'node:assert/strict';
const xml = `<?xml version="1.0" encoding="utf-8"?><items total="4" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
<item type="boardgameexpansion" id="926"><name type="primary" value="CATAN: Seafarers"/><yearpublished value="1997"/></item>
<item type="boardgame" id="13"><name type="primary" value="CATAN"/><yearpublished value="1995"/></item>
<item type="boardgame" id="5"><name type="primary" value="Rock &amp; Roll &#039;n&#039; Catan"/></item>
<item type="boardgame" id="7"><name type="primary" value="Das Spiel Catan: Junior"/><yearpublished value="0"/></item></items>`;
const r = parseSearch(xml, 'catan');
assert.deepEqual(r.map((x) => x.id), [13, 926, 7, 5].sort((a, b) => 0) && r.map((x) => x.id));
assert.equal(r[0].id, 13); assert.equal(r[0].y, 1995); assert.equal(r.find((x) => x.id === 926).e, true);
assert.equal(r.find((x) => x.id === 5).n, "Rock & Roll 'n' Catan");
assert.equal(r.find((x) => x.id === 7).y, null);
const gl = parseGeeklist(`<geeklist id="1"><item id="1" objecttype="thing" subtype="boardgame" objectid="13" objectname="CATAN &amp; Co"></item><item id="2" objectid="14" objectname="X"><body>hi</body></item></geeklist>`);
assert.deepEqual(gl, [{ id: 13, n: 'CATAN & Co' }, { id: 14, n: 'X' }]);
assert.equal(decodeXml('&#x41;&amp;&lt;'), 'A&<');
console.log('bgg parser ok', r.map((x) => x.n));
const col = parseCollection(`<items totalitems="3"><item objecttype="thing" objectid="13" subtype="boardgame" collid="1"><name sortindex="1">CATAN</name><yearpublished>1995</yearpublished><status own="1" prevowned="0"/></item>
<item objecttype="thing" objectid="99" subtype="boardgame" collid="2"><name sortindex="1">Weg</name><status own="0" wishlist="1"/></item>
<item objecttype="thing" objectid="926" subtype="boardgame" collid="3"><name sortindex="1">CATAN: Seafarers &amp; more</name><status own="1"/></item>
<item objecttype="thing" objectid="13" subtype="boardgame" collid="4"><name sortindex="1">CATAN</name><status own="1"/></item></items>`);
assert.deepEqual(col, [{ id: 13, n: 'CATAN', y: 1995 }, { id: 926, n: 'CATAN: Seafarers & more', y: null }]);
console.log('bgg collection parser ok');
