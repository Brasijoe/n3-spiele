# N3 Spielesammlung (eigenständige Version)

Die Spielesammlung des Nerd Nexus Nürnberg als eigene Webseite: Sammlung mit Filtern, Partien eintragen (auch Gastspiele mit Live-Suche bei BoardGameGeek), Statistik, „Mitspieler finden“ und eine Verwaltungsansicht. Sie läuft komplett auf **Cloudflare** (Worker + D1-Datenbank, Free-Tarif reicht) und lässt sich per Link oder **iFrame** in die N3-Homepage einbinden.

```
public/            statische Seite (index.html), Cover, Schriften, _headers
src/index.js       Worker: API unter /api/*, Rechteprüfung (Anmeldung, Admin, QR-/Event-Codes), Limits
src/auth.js        „Mit Discord anmelden“, Sitzungen, Zugangsprüfung über den Bot
src/discord.js     Discord-Bot (/party, /log, /code) und Abgleich der Runden-Nachrichten
src/games.js       Spiele, die per GeekList-Import nachgetragen wurden
src/bgg.js         BGG-XML-API: Suche und GeekList (Token nur hier)
schema.sql         Tabellen der D1-Datenbank
seed.sql           übernommene Daten aus dem Prototyp
docs/              Einbettungs-Snippet für die Homepage
test/              Parser-Test, Browser-Test (e2e), Hilfsskript
```

## Für neue Helfer

Kurzer Einstieg, wenn du (oder dein Claude) hier mitarbeiten willst.

**Wie es läuft:** Ein Push auf `main` wird von Cloudflare automatisch gebaut und ist nach 1–2 Minuten live unter https://n3-spiele.nerdnexus.workers.dev (eingebettet auf nerd-nexus.de). Deshalb wird nie direkt auf `main` gearbeitet, sondern auf einem eigenen Branch mit Pull Request. Gemergt wird erst, wenn Johannes es freigibt. Der fehlschlagende Check „Workers Builds“ bei Pull Requests ist bekannt (Vorschau-Builds sind nicht eingerichtet) und kein Fehler im Code.

**Was du brauchst:**
- Zum Mitentwickeln: Zugriff auf dieses Repo (Johannes fügt dich unter Settings → Collaborators hinzu). Mehr nicht, lokal läuft alles mit Testwerten.
- Nur wer selbst deployt oder Einstellungen ändert: Zugang zum Cloudflare-Konto (Worker `n3-spiele`, D1-Datenbank) und zur Discord-App im Developer Portal. Das vergibt Johannes.

**Wo was steht:**
- Die ganze Seite (HTML, CSS, JS, Texte DE/EN, Spieledaten) ist `public/index.html`. Texte stehen im Objekt `TXT` (`de` und `en`).
- Öffentliche Einstellungen (Discord-Server, Kanal, Rolle, Adresse) stehen in `wrangler.toml`. Geheimnisse stehen **nur** in Cloudflare (Liste am Ende von `wrangler.toml`).
- Tabellen legt der Worker beim ersten Zugriff selbst an bzw. ergänzt Spalten. `schema.sql` ist nur der Grundstock.

**Regeln:**
- Niemals Tokens oder Passwörter (BGG, Discord-Bot, Client-Secret, Admin) ins Repo, in Code oder in Chats schreiben.
- Volle Namen von Leihgebern gehören nicht ins öffentliche Repo, nur Kurznamen (das Verzeichnis liegt in der Verwaltung).
- Der Bot läuft noch auf dem **Discord-Testserver**. Umstellen auf den echten N3-Server nur auf Ansage von Johannes (vorbereitete Werte stehen auskommentiert in `wrangler.toml`; dann auch `DISCORD_ROLE_ID` auf die Brettspiel-Rolle setzen).
- Vor jedem Pull Request: `npm test` und, wenn Anmeldung/Rechte betroffen sind, `node test/web-login.mjs` (siehe Abschnitt 6).

**Mit Claude arbeiten:** Repo in Claude Code (z. B. claude.ai/code) öffnen und sagen, was du willst. Ein guter Startsatz: „Lies zuerst die README, arbeite auf einem eigenen Branch und öffne einen Pull Request, nicht mergen.“ Claude kann von dort aus BGG nicht erreichen; Änderungen am BGG-Import also auf dem eigenen Rechner testen.

**Offene Ideen (nur nach Absprache):** eigene Adresse wie `spiele.nerd-nexus.de` (DNS der Domain zu Cloudflare), Rollenprüfung am Go-Live, `/code` für Nicht-Mitglieder nur befristet, installierbare Web-App (PWA).

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
- **Eintragen per QR-Code (ohne Discord):** In der Verwaltung unter „Eintragen per QR-Code“ einen Schlüssel erzeugen und „Aushang drucken“ (A4-Plakat, `qr.html`). Der QR-Code führt auf `/?log=<schlüssel>`, öffnet direkt den Eintragen-Dialog und merkt sich den Schlüssel auf dem Handy. Wer so einträgt, gibt nur seinen Namen an (in der Verwaltung bei der Partie sichtbar, „(QR)“). Grenzen: 40 Partien pro Stunde und IP, 150 pro Tag insgesamt über diesen Weg. Wird der Link weitergegeben, einfach einen neuen Schlüssel erzeugen und neu drucken; alte Aushänge und gemerkte Schlüssel gelten dann sofort nicht mehr. Test: `node test/qr-log.cjs` (nach `test/reset.sh`).
- **Sprache, Besitzer, Inventurdaten:** Verwaltung, Block „Sprache, Besitzer und Inventurdaten“. Vorbelegt aus der Inventurliste (Stand 11.11.2026, `DEF_META` in `public/index.html`): Inventarnummer, Anschaffungsdatum, Zustand und Leihgeber/Spender (nur Vorname, weil die Seite öffentlich ist; „?“ = unbekannt). Je Spiel die Sprache der Ausgabe (DE/EN/FR), die Sprachabhängigkeit (Standard: BGG-Umfrage „Language Dependence“, Stand 11.11.2026, hier überschreibbar), Besitzer und „dabei seit“. Gespeichert in `config` unter `gamemeta`. Besitzer und Datum sieht man beim Überfahren eines Covers. Der Sprachfilter zeigt zuerst die Spiele in der gewählten Sprache, dann sprachneutrale und fast sprachneutrale Spiele.
- **Besitzer-Verzeichnis:** Verwaltung, aufklappbar unter der Spieleliste. Eine Zeile pro Person, `Kurzname = voller Name`. Gespeichert in `config` unter `owners` und nur mit Admin-Token lesbar (`/api/config/owners`), damit volle Namen nicht im öffentlichen Code stehen. Das Besitzerfeld schlägt beim Tippen alle bekannten Besitzer vor. Der volle Name erscheint beim Überfahren und im Excel-Export unter Leihgeber/Spender.
- **Excel-Export für die Inventurliste:** Verwaltung, „Als Excel exportieren“. Spalten wie in der Inventurliste plus BGG-ID, Besitzer, Datum, Sprache und BGG-Daten. Die Datei entsteht im Browser, ohne Fremdbibliothek.
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
npm test                         # Parser-Tests (BGG, Discord, Spiele)
```

`test/reset.sh` startet einen frischen Worker auf Port 8799 (Admin-Passwort `test-admin-pw` aus `.dev.vars`). `test/web-login.mjs` prüft Anmeldung und Rechte gegen ein simuliertes Discord; welche Werte in `.dev.vars` dafür nötig sind, steht oben in der Datei.

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
- Variablen in `wrangler.toml`: `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_GUILD_ID` (nur dieser Server darf den Bot nutzen), optional `DISCORD_CHANNEL_ID` (nur dieser Kanal; hierhin postet der Bot auch Runden, die auf der Webseite angelegt werden). Secret: `DISCORD_BOT_TOKEN`.
- Befehle registrieren (nach jeder Änderung an `COMMANDS`): `POST /api/admin/discord/register` mit Header `X-Admin-Token`.
- Im Developer Portal unter *General Information* als **Interactions Endpoint URL** die URL oben eintragen.

## Anmeldung auf der Webseite („Mit Discord anmelden“)

Partien eintragen und Runden anbieten geht nach einer Anmeldung: **„Mit Discord anmelden“** (Popup, Discord-Scope nur `identify`) oder einmalig mit dem persönlichen Code aus `/code`. Beides ergibt eine Sitzung, die sich der Browser 180 Tage merkt (in der Datenbank nur als Hash, Tabelle `sessions`). Ein früher gemerkter Code wird beim nächsten Besuch automatisch in eine Anmeldung getauscht.

Zugang hat nur, wer auf dem Discord-Server (`DISCORD_GUILD_ID`) ist und den ersten Bot-Kanal (`DISCORD_CHANNEL_ID`) sehen kann. Ist `DISCORD_ROLE_ID` gesetzt, braucht man zusätzlich diese Rolle (für den N3-Server: Brettspiel-Rolle; auf dem Testserver leer). Geprüft wird über den Bot, höchstens alle 10 Minuten neu; wer den Server verlässt, wird abgemeldet.

Angemeldete sehen bei ihren eigenen Partien und Runden „Bearbeiten“ (Partie: Datum, Spieler, Dauer, Gewinner, Notiz, Löschen; Runde: Spiel, Datum, Uhrzeit, Plätze, Notiz, Löschen). Bei fremden Einträgen erscheinen die Knöpfe nicht, und der Server lehnt es ab.

Einrichtung (einmalig):
1. Discord Developer Portal → die App → **OAuth2** → **Redirects**: `https://n3-spiele.nerdnexus.workers.dev/api/auth/callback` hinzufügen.
2. Dort das **Client Secret** kopieren und in Cloudflare als Secret `DISCORD_CLIENT_SECRET` speichern.
3. Später auf dem N3-Server: `DISCORD_ROLE_ID` in `wrangler.toml` auf die ID der Brettspiel-Rolle setzen.

Test: `node test/web-login.mjs` gegen `test/reset.sh` mit einem Mock-Discord (siehe Kopf der Datei).

## Wer darf wann eine Runde anbieten? (Mitglieder und Stammtisch-Tage)

- **Mitglieder** (Discord-Rolle, z. B. „Mitglied“) können Runden an jedem Tag anbieten, auf der Webseite und mit `/party`.
- **Alle anderen** nur an **Stammtisch-Tagen** (Standard: jeden Dienstag und am ersten Samstag im Monat). Im Kalender des Dialogs sind die übrigen Tage gesperrt. Außerdem ist der Hinweis Pflicht und muss eine kurze Vorstellung enthalten (mind. 40 Zeichen).
- **Event-Code**: davon ausgenommen, es gelten wie bisher nur die Eventtage.

Einstellungen in der Verwaltung unter „Runden: Mitglieder und Stammtisch-Tage“: Rollen-ID der Mitglieder, wöchentliche und monatliche Termine, zusätzliche Tage und ausfallende Tage (gespeichert in `config`, Schlüssel `booking`). Solange dort nichts gespeichert wurde, gilt `DISCORD_MEMBER_ROLE_ID` aus `wrangler.toml` als Rolle. Rollen-ID leer = keine Einschränkung. Die Rollen werden bei der Anmeldung und danach höchstens alle 10 Minuten über den Bot gelesen (Spalte `members.roles`); in Discord kommen sie direkt mit dem Befehl.

Der Kalender auf nerd-nexus.de/termine (WordPress-Plugin EventPrime) bietet keine lesbare Schnittstelle mit Daten (REST nur Namen, keine iCal-Adresse) und ist nicht aktuell gepflegt. Deshalb kommen die Stammtisch-Tage aus der Regel in der Verwaltung.

Nach dem Deploy einmal „Discord-Befehle registrieren“ klicken (neue Beschreibungen bei `/party`).

Test: `node test/booking.mjs` (siehe Kopf der Datei).

## Persönliche Codes (statt Vereinscode)

Mitglieder holen sich auf dem Discord-Server mit `/code` einen persönlichen 8-stelligen Code (nur für sie sichtbar). Damit legen sie auf der Webseite Runden an oder tragen Partien ein; der Browser merkt sich den Code. Die Runde trägt den Discord-Namen und gehört dem Discord-Konto, der Ersteller kann sie also auch in Discord über „Verwalten“ ändern. Ein neues `/code` macht den alten ungültig. Wer den Server verlässt, verliert den Code (Prüfung höchstens alle 10 Minuten, braucht `DISCORD_GUILD_ID` und den Bot-Token). Der Code wird nur als Hash gespeichert (Tabelle `members`).
Nach dem Deploy einmal in der Verwaltung „Discord-Befehle registrieren“ klicken, damit `/code` erscheint.
