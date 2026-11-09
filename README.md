# N3 Spielesammlung (eigenständige Version)

Die Spielesammlung des Nerd Nexus Nürnberg als eigene Webseite: Sammlung mit Filtern, Partien eintragen (auch Gastspiele mit Live-Suche bei BoardGameGeek), Statistik, „Mitspieler finden“ und eine Verwaltungsansicht. Sie läuft komplett auf **Cloudflare** (Worker + D1-Datenbank, Free-Tarif reicht) und lässt sich per Link oder **iFrame** in die N3-Homepage einbinden.

```
public/            statische Seite (index.html), Cover, Schriften, _headers
src/index.js       Worker: API unter /api/*, Prüfung von Vereinscode und Admin, Limits
src/bgg.js         BGG-XML-API: Suche und GeekList (Token nur hier)
schema.sql         Tabellen der D1-Datenbank
seed.sql           übernommene Daten aus dem Prototyp
docs/              Einbettungs-Snippet für die Homepage
test/              Parser-Test, Browser-Test (e2e), Hilfsskript
```

## 1. Einmalig einrichten

Voraussetzungen: Node.js 20 oder neuer und ein Cloudflare-Account.

```bash
npm install
npx wrangler login
npx wrangler d1 create n3-spiele        # gibt eine database_id aus -> in wrangler.toml eintragen
npm run db:init                         # legt Tabellen an und übernimmt die bisherigen Daten
npx wrangler secret put ADMIN_TOKEN     # Passwort für die Verwaltung, lang und zufällig wählen
npx wrangler secret put BGG_TOKEN       # NEUEN BGG-Token eintragen (siehe unten)
npm run deploy
```

Danach auf der Seite unten rechts **„Verwaltung“** öffnen, mit dem Admin-Passwort anmelden und unter „Vereinscode ändern“ den 4-stelligen Code setzen. Solange kein Code gesetzt ist, lassen sich keine Partien und Runden anlegen.

Alternativ lässt sich das GitHub-Repo in Cloudflare importieren (Workers & Pages, Import a repository). Dann wird bei jedem Push automatisch veröffentlicht. Die Secrets und die D1-Anbindung stellst du dann im Dashboard ein.

**Domain:** Unter Workers, Einstellungen, Domains & Routen eine Custom Domain wie `spiele.<n3-domain>` hinzufügen (die Domain muss bei Cloudflare liegen). Ohne eigene Domain gibt es eine `*.workers.dev`-Adresse.

## 2. In die Homepage einbetten

1. In `public/_headers` bei `frame-ancestors` die Adresse der Homepage eintragen, zum Beispiel
   `Content-Security-Policy: frame-ancestors 'self' https://www.n3-domain.de`
   (ausgeliefert ist `*`, also jede Seite darf einbetten) und neu veröffentlichen.
2. Den Block aus `docs/embed-snippet.html` an die gewünschte Stelle der Homepage setzen und die Adresse im `src` anpassen.

Das Snippet sorgt dafür, dass der iFrame mit dem Inhalt wächst (kein Scrollbalken im iFrame) und dass Dialoge im sichtbaren Bereich der Homepage erscheinen. Im iFrame blendet die Seite automatisch Titel und Einleitung aus.

Nützliche Parameter für Links und iFrame: `?lang=de` oder `?lang=en`, `#statistik` und `#partys` für die Tabs, `?embed=1` für die kompakte Ansicht auch ohne iFrame.

## 3. Betrieb

- **Vereinscode ändern:** Verwaltung in der Seite. Der Code wird mit Salz als SHA-256 in der Datenbank gespeichert und nur auf dem Server geprüft.
- **Partien, Runden, Highlights:** Verwaltung in der Seite. Partien löschen können nur Admins, Runden löschen Admins und der Gastgeber im selben Browser.
- **Backup:** `npx wrangler d1 export n3-spiele --remote --output backup.sql`
- **Tokens tauschen:** `npx wrangler secret put BGG_TOKEN` (oder `ADMIN_TOKEN`), ohne neues Deployment.
- **Logs bei Fehlern:** `npx wrangler tail`

## 4. BoardGameGeek

- **Live-Suche:** Die Seite fragt `/api/bgg/search?q=…`. Der Worker ruft die BGG-XML-API mit dem Token auf, begrenzt auf 60 Anfragen pro Minute und IP, und merkt sich Ergebnisse 24 Stunden im Cloudflare-Cache. Fällt BGG aus, durchsucht die Seite weiter die eigene Sammlung und der Name lässt sich frei eintragen.
- **GeekList-Abgleich:** Täglich um 03:17 UTC lädt der Worker die GeekList (`GEEKLIST_ID` in `wrangler.toml`). In der Verwaltung steht, welche Einträge der GeekList auf der Seite noch fehlen. Mit „Jetzt von BGG laden“ geht es auch sofort.
- **Wichtig:** Dieses Paket wurde ohne Netzzugriff zu BGG gebaut. Die Auswertung der XML-Antworten ist mit Beispielen im dokumentierten Format getestet (`npm test`), aber noch nicht gegen die echte API. Bitte nach dem Veröffentlichen einmal „Jetzt von BGG laden“ in der Verwaltung und eine Suche im Gastspiel-Dialog ausprobieren. Bei `bgg_error` hilft `npx wrangler tail`; meist ist dann der Token falsch oder abgelaufen.
- **Token:** Der Token, der im Chat gepostet wurde, bitte bei https://boardgamegeek.com/applications neu erzeugen und nur den neuen eintragen.
- Cover und das „Powered by BGG“-Logo liegen lokal in `public/covers/`. Die BGG-Nutzungsbedingungen verlangen die Nennung weiterhin (ist im Footer).

## 5. Sicherheit und Datenschutz

- Der BGG-Token liegt nur als Secret im Worker, nie im Browser oder im Repo.
- Die Seite ist öffentlich lesbar. Schreiben geht nur mit Vereinscode (Partien, Runden anlegen) oder Admin-Passwort (Verwaltung). Beitreten zu einer Runde braucht nur einen Namen, ist aber begrenzt.
- Falscher Code: höchstens 15 Versuche in 10 Minuten pro IP. Das schützt gegen Spaß und Zufall, ein 4-stelliger Code ist aber kein Schutz gegen einen gezielten Angriff mit vielen Adressen.
- Es gibt keine Cookies und keine Drittanbieter-Aufrufe: Schriften (Karla, Rubik, OFL-Lizenz) und Cover werden selbst ausgeliefert. Anmeldedaten und Namen von Mitspielern werden nur in der D1-Datenbank gespeichert.
- Für die Begrenzung speichert die Tabelle `rate` IP-Adressen kurzzeitig im Klartext und löscht sie nach spätestens 24 Stunden. Bitte in der Datenschutzerklärung erwähnen, ebenso die Server-Logs von Cloudflare.
- Die API schickt keine CORS-Header, andere Webseiten können sie also nicht aus dem Browser aufrufen.

## 6. Lokal entwickeln

```bash
cp .dev.vars.example .dev.vars   # lokale Testwerte
npm run db:init:local
npm run dev                      # http://localhost:8787
npm test                         # Parser-Test für die BGG-Antworten
```

Der Browser-Test `test/e2e.cjs` braucht Playwright, eine frische lokale Datenbank (`test/reset.sh`, startet Port 8799 mit Code 1234 und Admin-Passwort `test-admin-pw`) und einen kleinen Webserver für die Elternseite (`cd test/parent && python3 -m http.server 8800`).

## 7. Datenmodell (D1)

`plays` (Partien, mit `guest` für Gastspiele), `parties` (Runden mit `attendees` als JSON-Objekt, `play_id` sobald geloggt), `config` (`club_code_hash`, `highlights`, `geeklist`), `rate` (Begrenzung).

Die Spieledaten selbst (Bewertungen, Spielerzahlen, Kategorien, Texte) stehen als JSON in `public/index.html` (`<script id="gameData">`). Das automatische Neubauen dieser Daten aus der GeekList ist noch nicht umgesetzt, im Moment zeigt der Abgleich nur, was fehlt.

## 8. Unterschiede zum Prototyp

- Vereinscode wird jetzt auf dem Server geprüft statt im Browser.
- Verwaltung per Admin-Passwort statt Claude-Konto.
- Änderungen anderer erscheinen nach 15 bis 20 Sekunden (Abfrage statt Live-Verbindung), eigene Änderungen sofort.
- Die Live-Suche nutzt die echte BGG-API statt eines mitgelieferten Katalogs.

## 9. Nächste Schritte

- **Discord-Bot** im selben Worker: Endpunkt `/api/discord` (Slash-Befehle `/party` und `/log`, Beitreten-Button, Erinnerung am Tag danach). Er arbeitet auf denselben Tabellen, die Runden aus Discord erscheinen also auch auf der Seite. Dafür braucht es eine Discord-App (Application-ID, Public Key, Bot-Token als Secrets) und einen Kanal.
- Spieledaten automatisch aus der GeekList neu bauen.

## Discord-Bot

Der Bot läuft im selben Worker (kein extra Server). Endpoint: `https://<worker>/api/discord/interactions`.

- Befehle: `/party spiel [datum] [uhrzeit] [plaetze] [hinweis]` legt eine Runde an (Standard: nächster Dienstag 18:00, 4 Plätze), die Nachricht hat Buttons *Ich bin dabei*, *Absagen* und (Gastgeber) *Partie eintragen*. `/log spiel spieler [datum] [sieger] [dauer] [hinweis]` trägt direkt eine Partie ein. Spielnamen werden live bei BGG vorgeschlagen.
- Die Runden liegen in derselben Tabelle wie auf der Webseite (Reiter „Mitspieler finden“).
- Variablen in `wrangler.toml`: `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_GUILD_ID` (nur dieser Server darf den Bot nutzen). Secret: `DISCORD_BOT_TOKEN`.
- Befehle registrieren (nach jeder Änderung an `COMMANDS`): `POST /api/admin/discord/register` mit Header `X-Admin-Token`.
- Im Developer Portal unter *General Information* als **Interactions Endpoint URL** die URL oben eintragen.
