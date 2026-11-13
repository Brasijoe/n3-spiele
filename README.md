# N3 game collection (standalone version)

The board game collection of Nerd Nexus Nürnberg as its own website: the collection with filters, logging plays (including guest games with live search on BoardGameGeek), statistics, "Mitspieler finden" (find players) and an admin view. It runs entirely on **Cloudflare** (Worker + D1 database, the free plan is enough) and can be linked to or embedded in the N3 homepage via **iFrame**.

Want to set this up for another club? See [`docs/HANDOVER.md`](docs/HANDOVER.md).

UI labels in quotes below are the German texts shown on the page (the admin view, "Verwaltung", is German only).

```
public/            static page (index.html), covers, fonts, _headers
src/index.js       Worker: API under /api/*, permission checks (login, admin, QR/event codes), limits
src/auth.js        "Mit Discord anmelden" (sign in with Discord), sessions, access check via the bot
src/discord.js     Discord bot (/party, /log, /code) and sync of round messages
src/games.js       games added later via the GeekList import
src/bgg.js         BGG XML API: search and GeekList (token only here)
schema.sql         D1 database tables
seed.sql           data taken over from the prototype
docs/              embed snippet for the homepage, handover for reuse
test/              parser tests, browser test (e2e), helper script
```

## For new helpers

A short intro if you (or your Claude) want to work on this.

**How it runs:** A push to `main` is built automatically by Cloudflare and is live after 1–2 minutes at https://n3-spiele.nerdnexus.workers.dev (embedded on nerd-nexus.de). That is why nobody works directly on `main`: use your own branch and a pull request. Merging happens only once Johannes approves. The failing "Workers Builds" check on pull requests is known (preview builds are not set up) and is not a code error.

**What you need:**
- To develop: access to this repo (Johannes adds you under Settings → Collaborators). Nothing else; locally everything runs with test values.
- Only if you deploy yourself or change settings: access to the Cloudflare account (Worker `n3-spiele`, D1 database) and to the Discord app in the Developer Portal. Johannes grants that.

**Where things are:**
- The whole page (HTML, CSS, JS, texts DE/EN, game data) is `public/index.html`. Texts are in the `TXT` object (`de` and `en`).
- Public settings (Discord server, channel, role, address) are in `wrangler.toml`. Secrets are **only** in Cloudflare (list at the end of `wrangler.toml`).
- The Worker creates tables on first access and adds missing columns itself. `schema.sql` is only the base.

**Rules:**
- Never write tokens or passwords (BGG, Discord bot, client secret, admin) into the repo, code or chats.
- Full names of lenders do not belong in the public repo, only short names (the directory is in the admin view).
- The bot still runs on the **Discord test server**. Switch to the real N3 server only when Johannes says so (prepared values are commented out in `wrangler.toml`; then also set `DISCORD_ROLE_ID` to the board game role).
- Before every pull request: `npm test` and, if login/permissions are affected, `node test/web-login.mjs` (see section 6).

**Working with Claude:** Open the repo in Claude Code (e.g. claude.ai/code) and say what you want. A good opening line: "Read the README first, work on your own branch and open a pull request, don't merge." Claude cannot reach BGG from there, so test changes to the BGG import on your own computer.

**Open ideas (only after agreement):** own address like `spiele.nerd-nexus.de` (domain DNS moved to Cloudflare), role check at go-live, `/code` for non-members only time-limited, installable web app (PWA).

## 1. One-time setup

Requirements: Node.js 20 or newer and a Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler d1 create n3-spiele        # prints a database_id -> put it into wrangler.toml
npm run db:init                         # creates tables and imports the existing data
npx wrangler secret put ADMIN_TOKEN     # password for the admin view, choose long and random
npx wrangler secret put BGG_TOKEN       # enter a NEW BGG token (see below)
npm run deploy
```

Then open **"Verwaltung"** (admin) at the bottom right of the page, log in with the admin password and set the 4-digit code under "Vereinscode ändern" (change club code). As long as no code is set, no plays or rounds can be created.

Alternatively, import the GitHub repo into Cloudflare (Workers & Pages, Import a repository). Every push is then published automatically. You then set the secrets and the D1 binding in the dashboard.

**Domain:** Under Workers, Settings, Domains & Routes, add a custom domain like `spiele.<n3-domain>` (the domain must be on Cloudflare). Without your own domain you get a `*.workers.dev` address.

## 2. Embedding in the homepage

1. In `public/_headers`, enter the homepage address under `frame-ancestors`, for example
   `Content-Security-Policy: frame-ancestors 'self' https://www.n3-domain.de`
   (with `*` any site may embed it) and publish again.
2. Put the block from `docs/embed-snippet.html` where you want it on the homepage and adjust the address in `src`.

The snippet makes the iFrame grow with its content (no scroll bar inside the iFrame) and makes dialogs appear in the visible part of the homepage. Inside the iFrame the page hides its title and intro automatically.

Useful parameters for links and the iFrame: `?lang=de` or `?lang=en`, `#statistik` and `#partys` for the tabs, `?embed=1` for the compact view even without an iFrame.

## 3. Operation

- **Change the club code:** admin view on the page. The code is stored salted as SHA-256 in the database and checked only on the server.
- **Plays, rounds, highlights:** admin view on the page. Only admins delete plays; admins and the host (in the same browser) delete rounds.
- **Logging via QR code (without Discord):** In the admin view under "Eintragen per QR-Code", create a key and click "Aushang drucken" (print poster, A4, `qr.html`). The QR code leads to `/?log=<key>`, opens the log dialog directly and remembers the key on the phone. People logging this way only enter their name (visible on the play in the admin view, "(QR)"). Limits: 40 plays per hour per IP, 150 per day in total via this route. If the link gets passed around, just create a new key and reprint; old posters and remembered keys stop working immediately. Test: `node test/qr-log.cjs` (after `test/reset.sh`).
- **Language, owner, inventory data:** admin view, block "Sprache, Besitzer und Inventurdaten". Pre-filled from the inventory list (as of 2026-11-11, `DEF_META` in `public/index.html`): inventory number, acquisition date, condition and lender/donor (first name only, because the page is public; "?" = unknown). Per game: the language of the edition (DE/EN/FR), language dependence (default: BGG poll "Language Dependence" as of 2026-11-11, can be overridden here), owner and "dabei seit" (in the club since). Stored in `config` under `gamemeta`. Owner and date show when hovering over a cover. The language filter shows games in the chosen language first, then language-neutral and mostly language-neutral games.
- **Member-owned games ("Mitglieder besitzen"):** Members (Discord member role) add their own games under "Mitglieder besitzen", only with consent that their Discord server name is shown publicly as owner. The games are framed purple in the overview and can be shown or hidden with the "Herkunft" (origin) filter; they do not count as part of the collection. Games of people without the member role are not shown. Members can ask others to bring a game on up to 3 dates: the bot posts in the (first) bot channel mentioning the owner, who accepts a date (time and seats in a dialog) or declines (optional message, then buttons for a direct message). Accepting automatically creates a round with both people already in it. Limits: 5 requests per day per person, 30 in total. Admins delete entries under "Mitglieder besitzen". Test: `test/member-games.mjs` (instructions at the top of the file).
- **Owner directory:** admin view, expandable below the game list. One line per person, `short name = full name`. Stored in `config` under `owners` and readable only with the admin token (`/api/config/owners`), so full names are not in the public code. The owner field suggests all known owners while typing. The full name appears on hover and in the Excel export under lender/donor.
- **Excel export for the inventory list:** admin view, "Als Excel exportieren". Columns as in the inventory list plus BGG ID, owner, date, language and BGG data. The file is created in the browser, without a third-party library.
- **Backup:** see the "Backup" section below (nightly to R2, download in the admin view).
- **Swap tokens:** `npx wrangler secret put BGG_TOKEN` (or `ADMIN_TOKEN`), no new deployment needed.
- **Logs when something fails:** `npx wrangler tail`

## 4. BoardGameGeek

- **Live search:** The page calls `/api/bgg/search?q=…`. The Worker calls the BGG XML API with the token, limited to 60 requests per minute per IP, and caches results for 24 hours in the Cloudflare cache. If BGG is down, the page still searches the club's own collection and the name can be typed freely.
- **GeekList sync:** Daily at 03:17 UTC the Worker loads the GeekList (`GEEKLIST_ID` in `wrangler.toml`). The admin view shows which GeekList entries are still missing on the page. "Jetzt von BGG laden" (load from BGG now) does it immediately.
- **Important:** This package was built without network access to BGG. The parsing of the XML responses is tested with samples in the documented format (`npm test`), but not yet against the real API. After publishing, please try "Jetzt von BGG laden" in the admin view once and a search in the guest game dialog. On `bgg_error`, `npx wrangler tail` helps; usually the token is wrong or expired.
- **Token:** Please regenerate the token that was posted in the chat at https://boardgamegeek.com/applications and enter only the new one.
- Covers and the "Powered by BGG" logo are stored locally in `public/covers/`. The BGG terms of use still require the credit (it is in the footer).

## 5. Security and privacy

- The BGG token is stored only as a secret in the Worker, never in the browser or the repo.
- The page is publicly readable. Writing requires the club code (creating plays and rounds) or the admin password (admin view). Joining a round only needs a name, but is limited.
- Wrong code: at most 15 attempts in 10 minutes per IP. That protects against fun and chance, but a 4-digit code is no protection against a targeted attack from many addresses.
- There are no cookies and no third-party calls: fonts (Karla, Rubik, OFL license) and covers are served by the site itself. Login data and names of players are stored only in the D1 database.
- For rate limiting, the `rate` table briefly stores IP addresses in plain text and deletes them after 24 hours at the latest. Please mention this in the privacy statement, as well as Cloudflare's server logs.
- The API sends no CORS headers, so other websites cannot call it from the browser.

## 6. Local development

```bash
cp .dev.vars.example .dev.vars   # local test values
npm run db:init:local
npm run dev                      # http://localhost:8787
npm test                         # parser tests (BGG, Discord, games)
```

`test/reset.sh` starts a fresh Worker on port 8799 (admin password `test-admin-pw` from `.dev.vars`). `test/web-login.mjs` checks login and permissions against a simulated Discord; the `.dev.vars` values it needs are listed at the top of the file.

The browser test `test/e2e.cjs` needs Playwright, a fresh local database (`test/reset.sh`, starts port 8799 with code 1234 and admin password `test-admin-pw`) and a small web server for the parent page (`cd test/parent && python3 -m http.server 8800`). Note: this test is outdated (written for the old club code) and needs updating.

## 7. Data model (D1)

`plays` (plays, with `guest` for guest games), `parties` (rounds with `attendees` as a JSON object, `play_id` once logged), `config` (`club_code_hash`, `highlights`, `geeklist`), `rate` (rate limiting). More tables are added by the Worker itself; see [`docs/HANDOVER.md`](docs/HANDOVER.md) for the full list.

The game data itself (ratings, player counts, categories, texts) is JSON in `public/index.html` (`<script id="gameData">`). Rebuilding this data automatically from the GeekList is not implemented yet; for now the sync only shows what is missing.

## 8. Differences from the prototype

- The club code is now checked on the server instead of in the browser.
- Admin access by admin password instead of a Claude account.
- Other people's changes appear after 15 to 20 seconds (polling instead of a live connection), your own changes immediately.
- The live search uses the real BGG API instead of a bundled catalog.

## 9. Next steps

- **Discord bot** in the same Worker: endpoint `/api/discord` (slash commands `/party` and `/log`, join button, reminder the day after). It works on the same tables, so rounds from Discord also appear on the page. This needs a Discord app (application ID, public key, bot token as secrets) and a channel.
- Rebuild the game data automatically from the GeekList.

## Discord bot

The bot runs in the same Worker (no extra server). Endpoint: `https://<worker>/api/discord/interactions`.

- Commands: `/party spiel [datum] [uhrzeit] [plaetze] [hinweis]` (game, date, time, seats, note) creates a round (default: next Tuesday 18:00, 4 seats); the message has the buttons *Ich bin dabei* (I'm in), *Absagen* (cancel) and, for the host, *Partie eintragen* (log play). `/log spiel spieler [datum] [sieger] [dauer] [hinweis]` (game, players, date, winner, duration, note) logs a play directly. Game names are suggested live from BGG.
- The rounds are in the same table as on the website ("Mitspieler finden" tab).
- Variables in `wrangler.toml`: `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_GUILD_ID` (only this server may use the bot), optional `DISCORD_CHANNEL_ID` (only this channel; the bot also posts rounds created on the website here). Secret: `DISCORD_BOT_TOKEN`.
- Register commands (after every change to `COMMANDS`): `POST /api/admin/discord/register` with header `X-Admin-Token`.
- In the Developer Portal under *General Information*, enter the URL above as the **Interactions Endpoint URL**.

## Website login ("Mit Discord anmelden")

Logging plays and offering rounds works after signing in: **"Mit Discord anmelden"** (popup, Discord scope `identify` only) or once with the personal code from `/code`. Both create a session that the browser remembers for 180 days (stored in the database only as a hash, table `sessions`). A previously remembered code is automatically swapped for a login on the next visit.

Access is granted only to people who are on the Discord server (`DISCORD_GUILD_ID`) and can see the first bot channel (`DISCORD_CHANNEL_ID`). If `DISCORD_ROLE_ID` is set, that role is also required (for the N3 server: the board game role; empty on the test server). This is checked via the bot, re-checked at most every 10 minutes; anyone who leaves the server is logged out.

Signed-in users see "Bearbeiten" (edit) on their own plays and rounds (play: date, players, duration, winner, note, delete; round: game, date, time, seats, note, delete). On other people's entries the buttons do not appear, and the server rejects it.

Setup (one time):
1. Discord Developer Portal → the app → **OAuth2** → **Redirects**: add `https://n3-spiele.nerdnexus.workers.dev/api/auth/callback`.
2. Copy the **Client Secret** there and save it in Cloudflare as the secret `DISCORD_CLIENT_SECRET`.
3. Later on the N3 server: set `DISCORD_ROLE_ID` in `wrangler.toml` to the ID of the board game role.

Test: `node test/web-login.mjs` against `test/reset.sh` with a mock Discord (see the top of the file).

## Who may offer a round when? (members and Stammtisch days)

- **Members** (Discord role, e.g. "Mitglied") can offer rounds on any day, on the website and with `/party`.
- **Everyone else** only on **Stammtisch days** (club nights; default: every Tuesday and the first Saturday of the month). In the dialog's calendar the other days are disabled. The note is also required and must contain a short introduction (at least 40 characters).
- **Event code**: exempt from this; as before, only the event days apply.

Settings in the admin view under "Runden: Mitglieder und Stammtisch-Tage": role ID of the members, weekly and monthly dates, extra days and cancelled days (stored in `config`, key `booking`). As long as nothing has been saved there, `DISCORD_MEMBER_ROLE_ID` from `wrangler.toml` is used as the role. Empty role ID = no restriction. Roles are read via the bot at login and after that at most every 10 minutes (column `members.roles`); in Discord they come directly with the command.

The calendar on nerd-nexus.de/termine (WordPress plugin EventPrime) offers no readable interface with dates (REST only gives names, no iCal address) and is not kept up to date. That is why the Stammtisch days come from the rule in the admin view.

After deploying, click "Discord-Befehle registrieren" (register Discord commands) once (new descriptions for `/party`).

Test: `node test/booking.mjs` (see the top of the file).

## Personal codes (instead of the club code)

On the Discord server, members get a personal 8-digit code with `/code` (visible only to them). With it they create rounds or log plays on the website; the browser remembers the code. The round carries the Discord name and belongs to the Discord account, so the creator can also change it in Discord via "Verwalten" (manage). A new `/code` invalidates the old one. Anyone who leaves the server loses the code (checked at most every 10 minutes, needs `DISCORD_GUILD_ID` and the bot token). The code is stored only as a hash (table `members`).
After deploying, click "Discord-Befehle registrieren" once in the admin view so that `/code` appears.

## Backup

**What happens:** Every night at 03:17 UTC (before the GeekList sync) the Worker writes the whole D1 database as a SQL file into the private R2 bucket `n3-spiele-backup` (`d1/<date>T<time>Z.sql`). The newest 30 backups are kept, older ones are deleted by the Worker. All tables are included except the data of `rate` and `auth_handoff` (short-lived counters and login handoffs; their structure is included). Code: `src/backup.js`.

**One-time setup (before the first deploy of this version):** Cloudflare dashboard → *R2 Object Storage* → *Create bucket* → name `n3-spiele-backup`, location automatic, do **not** enable public access. Alternatively `npx wrangler r2 bucket create n3-spiele-backup`. R2 must be enabled once on the account (free up to 10 GB; the backups are a few MB). If the bucket is missing, the deploy fails.

**Admin view, block "Datensicherung" (backup):**
- "Aktuellen Stand herunterladen" (download current state): creates a SQL file right away and downloads it, independent of R2. Do this now and then and keep the file outside Cloudflare (e.g. OneDrive).
- "Jetzt in R2 sichern" (back up to R2 now): stores a backup in the bucket immediately (e.g. before bigger changes).
- List of the backups in the bucket; a click downloads the file.

The files contain private data (full names from the owner directory, Discord IDs, sessions, code hashes). Do not share them and **never put them into the public GitHub repo**.

**Restore:**
1. Get a backup: download it in the admin view, or in the dashboard under R2 → `n3-spiele-backup` → `d1/`.
2. In the repo folder: `npx wrangler d1 execute n3-spiele --remote --file=n3-spiele-….sql`
   The file drops every backed-up table (`DROP TABLE`) and recreates it with the saved content. Everything entered after the backup is lost.
3. Try it first locally: `npx wrangler d1 execute n3-spiele --local --file=….sql` and look at it with `npx wrangler dev`.

**Smaller mishaps (last 30 days):** D1 *Time Travel* resets the database to any minute, without a file:
`npx wrangler d1 time-travel info n3-spiele` (current state) and `npx wrangler d1 time-travel restore n3-spiele --timestamp=2026-11-13T10:00:00Z`. This also overwrites everything after that point.

**Check that it runs:** Workers → n3-spiele → Observability, search for `backup ok` or `backup failed`, or check the date of the newest backup in the admin view.
