# N3 game collection

The board game collection of Nerd Nexus Nürnberg (N3) as its own website, with a Discord bot in the same backend. It runs entirely on **Cloudflare** (Worker + D1 database, the free plan is enough) and is embedded in the N3 homepage via **iFrame**.

Live: https://n3-spiele.nerdnexus.workers.dev (embedded on nerd-nexus.de)

> **Reusing this for another club, or handing it to another AI?** Read **[`docs/HANDOVER.md`](docs/HANDOVER.md)**. It covers the concept, architecture, full data model, step-by-step setup for a new club, what is N3-specific, hosting alternatives, running without Discord or BGG, and a go-live checklist.

UI labels in quotes below are the German texts shown on the page (the admin view, "Verwaltung", is German only).

## Contents

1. [Features](#1-features)
2. [Repository layout](#2-repository-layout)
3. [For new helpers](#3-for-new-helpers)
4. [Setup](#4-setup)
5. [Embedding in the homepage](#5-embedding-in-the-homepage)
6. [Login and permissions](#6-login-and-permissions)
7. [Discord bot](#7-discord-bot)
8. [Who may offer or join a round when](#8-who-may-offer-or-join-a-round-when)
9. [Admin view ("Verwaltung")](#9-admin-view-verwaltung)
10. [BoardGameGeek](#10-boardgamegeek)
11. [Operations](#11-operations)
12. [Security and privacy](#12-security-and-privacy)
13. [Local development and tests](#13-local-development-and-tests)
14. [Data model](#14-data-model)
15. [Go-live on the real N3 Discord server](#15-go-live-on-the-real-n3-discord-server)
16. [Open ideas](#16-open-ideas)

## 1. Features

- **Collection ("Sammlung"):** cards with cover, rating, complexity, player count (incl. best with), duration and age. Filters (collapsed by default, "Filter anzeigen"): players, duration, complexity, category, game type, language (DE/EN/FR, language-neutral games listed after the chosen language), "only two players"; live search and sorting. Expansions are listed under their base game (more than 3 open a "+ N weitere" popup). Admins see owner and "in the club since" when hovering over a cover.
- **Slideshow:** a highlights carousel (games and short texts chosen in the admin view) alternates every 30 seconds with "Zuletzt gespielt" (up to 10 recently played games).
- **Logging plays ("Partie eintragen"):** date, players, winner, duration, first play, note. Works for collection games and for **guest games** (any game via live BGG search, or a free name). Signed-in users edit and delete their own plays; admins edit all.
- **Statistics tab (`#statistik`):** most played games and "Zuletzt im Club gespielt" (recently played in the club).
- **Find players ("Mitspieler finden", `#partys`):** offer a round (game, date, time, seats, note), others join or leave. Rounds are posted in the Discord bot channel and kept in sync both ways. The page explains the rules and the Discord setup (collapsed by default).
- **Event codes:** let anyone offer rounds on event days without Discord (see section 9).
- **Logging via QR code:** for people without Discord (see section 9).
- **Member-owned games ("Mitglieder besitzen"):** a second tab next to the collection where members list their own games and others can ask them to bring one (see section 9).
- **"Does anyone have …?" ("Hat jemand …?"):** on the sub-page "Hat jemand …?" of the "Mitspieler-/Spielesuche" tab (sub-tabs "Mitspieler gesucht" | "Spiele gesucht" with counts; `#partys` and `#suche` open them directly), signed-in users look for a game that is neither in the collection nor owned by a member; the bot asks in the bot channel (see section 9).
- **Discord button:** next to the language switch. Signed out it is the Discord icon as a sign-in button ("Mit Discord anmelden" slides out on hover); signed in it is the Discord icon with a direct link to the bot channel. Login checks that the person is on the server (`DISCORD_GUILD_ID`, test server until go-live); if not, a dialog explains they must join first and shows the invite link (`DISCORD_URL`), also on the login popup.
- **Discord links open the app:** on phones the OS opens `https://discord.com/...` links in the app if installed. On computers, links to discord.com/discord.gg go through `public/dc.html` in a new tab, which tries `discord://` first and falls back to the web after ~1.6 s.
- **Languages:** German and English (`?lang=de|en`, switch in the header). Discord bot texts are German only.

## 2. Repository layout

```
public/index.html  the whole page: HTML, CSS, JS, texts (object TXT, de/en), built-in game data (<script id="gameData">)
public/qr.html     printable QR poster
public/covers/     covers and the "Powered by BGG" logo; public/fonts/ self-hosted fonts; public/_headers
src/index.js       Worker: API under /api/*, permissions, limits, cron jobs
src/auth.js        "Mit Discord anmelden" (OAuth), sessions, access check via the bot
src/discord.js     Discord bot (/party, /log, /code, buttons, modals), round message sync, DB migrations (ensureCols)
src/booking.js     Stammtisch-day rule, member check, intro rule
src/membergames.js member-owned games, BGG collection import, bring requests
src/wanted.js     "Hat jemand …?" game requests in the bot channel
src/games.js       GeekList games missing from the page (extra_games), cover proxy
src/bgg.js         BGG XML API: search, GeekList, collection (token only here)
schema.sql         base tables (the Worker adds the rest itself)
seed.sql           data taken over from the first prototype
docs/              HANDOVER.md (reuse handover), embed-snippet.html
test/              unit tests and integration tests (see section 13)
```

## 3. For new helpers

A short intro if you (or your Claude) want to work on this.

**How it runs:** A push to `main` is built automatically by Cloudflare and is live after 1–2 minutes. That is why nobody works directly on `main`: use your own branch and a pull request. Merging happens only once Johannes approves. The failing "Workers Builds" check on pull requests is known (preview builds are not set up) and is not a code error.

**What you need:**
- To develop: access to this repo (Johannes adds you under Settings → Collaborators). Nothing else; locally everything runs with test values.
- Only if you deploy yourself or change settings: access to the Cloudflare account (Worker `n3-spiele`, D1 database) and to the Discord app in the Developer Portal. Johannes grants that.

**Where things are:**
- The whole page is `public/index.html`. Texts are in the `TXT` object (`de` and `en`).
- Public settings (Discord server, channel, roles, invite link, address) are in `wrangler.toml`. Secrets are **only** in Cloudflare (list at the end of `wrangler.toml`).
- The Worker creates missing tables and columns on first access (`ensureCols` in `src/discord.js`), so deployments never need a manual migration.

**Rules:**
- Never write tokens or passwords (BGG, Discord bot, client secret, admin) into the repo, code or chats.
- Full names of lenders do not belong in the public repo, only short names (the full names are in the admin-only owner directory).
- The bot still runs on the **Discord test server**. Switch to the real N3 server only when Johannes says so (section 15).
- Before every pull request: `npm test` and, if login, permissions, booking or member games are affected, the matching integration test (section 13).
- Write README changes in English.

**Working with Claude:** Open the repo in Claude Code (e.g. claude.ai/code) and say what you want. A good opening line: "Read the README and docs/HANDOVER.md first, work on your own branch and open a pull request, don't merge." Claude cannot reach BGG from the cloud, so test changes to the BGG import on your own computer.

## 4. Setup

Requirements: Node.js 20 or newer and a Cloudflare account. (Already done for N3; this is for a fresh install. A new club should follow [`docs/HANDOVER.md`](docs/HANDOVER.md) section 4.)

```bash
npm install
npx wrangler login
npx wrangler d1 create n3-spiele        # prints a database_id -> put it into wrangler.toml
npm run db:init                         # creates the base tables and imports seed.sql
npx wrangler secret put ADMIN_TOKEN     # password for the admin view, long and random
npx wrangler secret put BGG_TOKEN       # BGG XML API token (section 10)
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_CLIENT_SECRET
npm run deploy
```

N3 uses the GitHub import instead (Cloudflare: Workers & Pages, Import a repository): every push to `main` deploys automatically; secrets and the D1 binding are set in the dashboard.

After the first deploy: set up the Discord app (section 7), open "Verwaltung" at the bottom right of the page, log in with the admin password, click "Discord-Befehle registrieren", save the member role and Stammtisch days, and click "Jetzt von BGG laden".

**Domain:** Worker → Settings → Domains & Routes, add a custom domain like `spiele.nerd-nexus.de` (the domain's DNS must be on Cloudflare). Without one, the `*.workers.dev` address is used.

## 5. Embedding in the homepage

1. `public/_headers` limits embedding via `frame-ancestors` to nerd-nexus.de. Add other sites there if needed.
2. Put the block from `docs/embed-snippet.html` on the homepage (WordPress: Custom HTML block) and adjust the address in `src` if it changes.

The snippet makes the iFrame grow with its content (no scroll bar inside) and keeps dialogs in the visible part of the homepage. Inside the iFrame the page hides its own title and intro.

Useful parameters: `?lang=de` or `?lang=en`, `#statistik` and `#partys` for the tabs, `?embed=1` for the compact view even without an iFrame.

## 6. Login and permissions

The page is publicly readable. Writing needs one of these:

| Way | Who | What it allows |
|---|---|---|
| **"Mit Discord anmelden"** (OAuth popup, scope `identify` only) | People on the Discord server who can see the first bot channel, plus `DISCORD_ROLE_ID` if set | Log plays, offer and join rounds, member games (with member role), edit/delete own entries |
| **Personal code** from `/code` in Discord | Same as above | One-time login on the web; swapped for a session. A new `/code` invalidates the old one |
| **Event code** (from the admin view) | Anyone with the code | Offer rounds on the event's days (with a name), bring requests within the event range |
| **QR club key** (poster in the club) | Anyone in the club | Log plays with just a name |
| **Admin password** (`ADMIN_TOKEN`) | Admins | Everything in "Verwaltung", edit/delete all plays and rounds |

Sessions last 180 days and are stored only as a hash (table `sessions`). Membership and roles are re-checked via the bot at most every 10 minutes; anyone who leaves the server is logged out and loses their code. Signed-in users see "Bearbeiten" only on their own plays and rounds, and the server rejects edits of other people's entries.

OAuth setup (one time): Discord Developer Portal → the app → **OAuth2** → **Redirects**: add `https://n3-spiele.nerdnexus.workers.dev/api/auth/callback`; copy the **Client Secret** into the Cloudflare secret `DISCORD_CLIENT_SECRET`.

Test: `node test/web-login.mjs` (see the top of the file).

## 7. Discord bot

The bot runs in the same Worker (HTTP interactions, no extra server). Endpoint: `https://<worker>/api/discord/interactions`.

- `/party spiel [datum] [uhrzeit] [plaetze] [hinweis]` (game, date, time, seats, note) creates a round. Default: next Stammtisch, 18:00, 4 seats. The message has *Ich bin dabei* (join), *Absagen* (leave), *Verwalten (Ersteller)* (manage, creator only) and, after the round, *Als gespielt registrieren* (log as played). Game names are suggested live from BGG.
- `/log spiel spieler [datum] [sieger] [dauer] [hinweis]` (game, players, date, winner, duration, note) logs a play.
- `/code` gives a personal code for the website (only visible to you).
- Rounds created on the website are posted in the first bot channel (rate-limited), with the event name for event rounds.
- **Thread per round:** every round post in the first channel (#mitspieler-gesucht; web, `/party`, accepted bring request, "Hab ich: Runde anlegen") gets a public thread named "<game> · <weekday> <date>" with a short first message. The creator and everyone who joins with Discord (button, or web while signed in; stored as `did` on the attendee) are added, people who leave are removed, a date change renames it. It is closed (archived + locked) on cancellation and by the nightly run after the game day. Columns `parties.discord_thread`, `parties.thread_state`. Bot needs "Create Public Threads", "Send Messages in Threads" and "Manage Threads" in that channel. Test: `test/threads.mjs`.
- Bring requests for member games are posted there too, with *Annehmen/Ablehnen/Zurückziehen* (accept/decline/withdraw) buttons.

Settings in `wrangler.toml`: `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_GUILD_ID` (only this server), `DISCORD_WANTED_CHANNEL_ID` (channel for "Hat jemand …?" posts, test: #spiele-gesucht; empty = first `DISCORD_CHANNEL_ID`; rounds created from a found game still go to the first `DISCORD_CHANNEL_ID`), `DISCORD_CHANNEL_ID` (comma list; the bot only reacts there, the first one is the target for posts from the website), `DISCORD_ROLE_ID` (optional role required for web login), `DISCORD_MEMBER_ROLE_ID` (start value of the member role), `DISCORD_URL` (invite link). Secret: `DISCORD_BOT_TOKEN`.

In the Developer Portal under *General Information*, set the URL above as **Interactions Endpoint URL**. After every change to `COMMANDS` in `src/discord.js`, click "Discord-Befehle registrieren" in the admin view (or `POST /api/admin/discord/register` with header `X-Admin-Token`).

Tests: `npm test` (unit), `test/discord-e2e.mjs`, `test/discord-sync.mjs`, `test/member-code.mjs`.

## 8. Who may offer or join a round when

- **Members** (Discord member role) can offer and join rounds on any day, on the website and with `/party`.
- **Everyone else** only on **Stammtisch days** (club nights; default every Tuesday and the first Saturday of the month). Other days are greyed out in the date picker. When offering, the note must contain a short introduction (at least 40 characters).
- **Rounds on Stammtisch days and event rounds** are open for everyone to join. Rounds on other days are members only.
- **Event codes** are exempt from the Stammtisch rule; only the event days apply.

Settings in the admin view under "Runden: Mitglieder und Stammtisch-Tage": member role ID, weekly and monthly days, extra days and cancelled days (stored in `config`, key `booking`). Until something is saved there, `DISCORD_MEMBER_ROLE_ID` from `wrangler.toml` is the role. Empty role ID = no restriction.

The calendar on nerd-nexus.de/termine (WordPress plugin EventPrime) offers no readable feed with dates, which is why the Stammtisch days come from this rule.

Tests: `node test/booking.mjs`, `node test/join-rules.mjs`.

## 9. Admin view ("Verwaltung")

Link at the bottom right of the page, login with the admin password.

- **Highlights:** choose games, order and short texts (DE/EN) for the carousel.
- **Plays and rounds:** edit and delete any entry.
- **Event codes:** create a code with event name, valid-until date and event day range. With it, anyone can offer rounds on those days without Discord; the event name appears in the Discord post. Delete the code to stop it.
- **Logging via QR code ("Eintragen per QR-Code"):** create a key and print a poster ("Aushang drucken", `qr.html`, A4/A5/A6, German front, English back). The QR code leads to `/?log=<key>`, opens the log dialog directly and remembers the key on the phone. People logging this way only enter their name (shown as "(QR)" on the play). The link is never printed as text. Limits: 40 plays per hour per IP, 150 per day in total. If the link gets around, create a new key and reprint; old posters and remembered keys stop working immediately. Test: `node test/qr-log.cjs`.
- **Member role and Stammtisch days:** see section 8.
- **Language, owner and inventory data ("Sprache, Besitzer und Inventurdaten"):** per game: edition language (DE/EN/FR), language dependence (default from the BGG poll, overridable), owner, "dabei seit" (in the club since), inventory number, acquisition date, condition. Pre-filled from the inventory list (`DEF_META` in `public/index.html`, first names only; "?" = unknown). Stored in `config` under `gamemeta`. Sortable list with live search.
- **Owner directory:** expandable below the game list, one line per person `short name = full name`. Stored in `config` under `owners`, readable only with the admin token, so full names never appear in public code. The owner field autocompletes known owners. The full name shows on hover (admins) and in the Excel export.
- **Excel export ("Als Excel exportieren"):** columns as in the inventory list plus BGG ID, owner, date, language and BGG data. Created in the browser.
- **GeekList ("Jetzt von BGG laden"):** shows which GeekList entries are missing on the page and loads them now (section 10).
- **"Discord-Befehle registrieren":** after deploys that change slash commands.
- **Member games:** admins can delete entries.

### Member-owned games ("Mitglieder besitzen")

- Members (member role) add their own games in the "Mitglieder besitzen" tab, manually or by importing their BGG collection (BGG username, owned games). Repeating the import syncs: games no longer owned on BGG are offered for removal; manually added games are kept. Adding requires consent that the Discord server name (nickname, else global name) is shown publicly as owner (pre-checked).
- Member games are framed purple, do not count as part of the collection, and use the same filters (plus an owner filter). Games the club also owns are greyed out and listed last. The same game from several members is one card. "Deine Spiele (N)" opens a dialog to search and remove your own games.
- **Bring requests ("Mitbringen anfragen"):** members (or non-members with a valid event code, dates within the event) ask for up to 3 dates. The bot posts in the first bot channel and mentions all owners. The first owner to accept picks a date, time and seats, and a round is created with both people in it; others get "too late". A decline removes only that owner; the request ends when all have declined (shown like a withdrawn one). After a decline, buttons offer a direct message. Limits: 5 requests per day per person, 30 per day in total; max 1000 games per member.
- The nightly job removes games of owners who left the server or lost the member role (and cancels their open requests). Missing BGG details are backfilled every 20 minutes.
- Test: `test/member-games.mjs` (instructions at the top of the file).

### "Does anyone have …?" ("Hat jemand …?")

- On the "Hat jemand …?" sub-page, "Neue Suche" opens a BGG search. If the game is in the club collection, the dialog offers "Runde anbieten"; if a member owns it, it offers the bring request; if someone already looks for it, it offers "Ich will auch mitspielen". Otherwise "Nach dem Spiel fragen" posts in the first bot channel (server checks the same, `in_club` / `in_members` / `already_wanted`).
- Bot buttons: **"Hab ich: Runde anlegen"** (date, time, seats, note; creates a round with the requester and everyone who pressed "Will auch mitspielen" as far as seats and day rules allow), **"Hab ich"** (closes the request and offers direct-message buttons), **"Ich will auch mitspielen"** (toggle, also on the web), **"Zurückziehen"** (requester only; admins can withdraw on the web).
- The same four actions are on each card on the web page ("Hab ich: Runde anlegen" opens a dialog with date, time, seats and note). Answering on the web requires being signed in (Discord login or `/code`), unlike joining a round. Web answers update the Discord post and announce the round there, just like the buttons (`POST /api/wanted/:id/found` with optional `round`, `POST /api/wanted/:id/interest`).
- Day rules as for `/party`: a host without the member role needs a Stammtisch day and a short intro; if the requester has no member role, only Stammtisch days work. Interested non-members are not added on other days but are mentioned.
- Open requests are listed on the web page for 3 months, then the nightly run marks them expired and strikes through the Discord message. Limits: 10 requests per 24 hours for members, 3 for non-members (withdrawn ones count; the error shows "used/max"), 50 per day in total, max 20 interested per request.

## 10. BoardGameGeek

- **Token:** BGG XML API application token from https://boardgamegeek.com/applications, stored only as the secret `BGG_TOKEN`. If a token was ever posted in a chat, regenerate it.
- **Live search:** the page calls `/api/bgg/search?q=…`; the Worker calls BGG with the token, limited to 60 requests per minute per IP, cached 24 hours. If BGG is down, the page searches the club's own collection and the name can be typed freely.
- **GeekList sync:** nightly at 03:17 UTC the Worker reads the GeekList (`GEEKLIST_ID` in `wrangler.toml`) and imports games missing from the built-in data into `extra_games` (up to 40 per run, via `/api/games/extra`). "Jetzt von BGG laden" in the admin view does it immediately. BGG sometimes answers 202/429; the Worker retries.
- **Covers:** built-in covers are in `public/covers/`; other covers come through the Worker's cover proxy, so the browser never calls BGG directly. Keep the "Powered by BGG" credit in the footer (BGG terms).
- The built-in game data (`<script id="gameData">` in `public/index.html`) was generated once from the GeekList; there is no script in the repo that rebuilds it.
- Cloud environments (including Claude cloud sessions) usually cannot reach BGG. Test BGG changes locally or on the live Worker; on `bgg_error`, `npx wrangler tail` usually shows a wrong or expired token.

## 11. Operations

- **Cron jobs** (`wrangler.toml`): `17 3 * * *` nightly (rate table cleanup, GeekList read and import, member game pruning and backfill) and `*/20 * * * *` (member game backfill only). The code checks the exact nightly cron string.
- **Backup:** `npx wrangler d1 export n3-spiele --remote --output backup.sql`. D1 Time Travel can also restore the database to a point in time (`npx wrangler d1 time-travel restore n3-spiele --timestamp=…`). Never put backup files in this public repo; they contain private data.
- **Swap tokens:** `npx wrangler secret put BGG_TOKEN` (or `ADMIN_TOKEN`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET`), no new deployment needed.
- **Logs:** `npx wrangler tail`, or Cloudflare dashboard → Workers → n3-spiele → Observability.
- **Failed deploy:** if a Cloudflare build fails with an API error (e.g. `code: 10013` or "internal error") the code is fine; check cloudflarestatus.com and use "Retry build" later. During such outages newer pushes may not start a build at all; the next push to `main` or `npx wrangler deploy` from a local clone deploys the latest version.

## 12. Security and privacy

- BGG token, bot token, client secret and admin password exist only as Cloudflare secrets, never in the browser or the repo.
- Personal codes, sessions and login handoffs are stored only as hashes. The QR key is stored in plain text so the poster can be reprinted.
- Rate limits (in D1, so they apply across instances): wrong admin password 20 per 10 minutes per IP (only wrong attempts count); wrong codes/keys 15–20 per 10 minutes per IP; writes 40 and joins 30 per 10 minutes per IP; QR plays 40 per hour per IP and 150 per day; BGG search 60 and covers 120 per minute per IP.
- No tracking cookies (only a short-lived cookie during the Discord login) and no third-party calls from the browser: fonts (Karla, Rubik, OFL license) and covers are served by the site itself.
- The `rate` table stores IP addresses briefly in plain text and deletes them after 24 hours at the latest. The privacy statement should mention this, Cloudflare's server logs, and the Discord data used for login (ID, name, roles) and for member games (server name as owner).
- The API sends no CORS headers, so other websites cannot call it from the browser.

## 13. Local development and tests

```bash
cp .dev.vars.example .dev.vars   # local test values
npm run db:init:local
npm run dev                      # http://localhost:8787
npm test                         # unit tests: BGG parser, Discord, games
```

`test/reset.sh` starts a fresh Worker on port 8799 with an empty database (admin password `test-admin-pw` from `.dev.vars`). The integration tests run against it, several with a mock Discord; the `.dev.vars` values each one needs are listed at the top of the file:

| Test | Covers |
|---|---|
| `test/web-login.mjs` | Discord login, sessions, own-entry permissions |
| `test/booking.mjs` | Stammtisch-day rule, intro note |
| `test/join-rules.mjs` | who may join which round |
| `test/member-games.mjs` | member games, BGG import, bring requests |
| `test/wanted.mjs` | "Hat jemand …?" requests (same setup as `test/member-games.mjs`) |
| `test/qr-log.cjs` | logging via QR key |
| `test/member-code.mjs` | `/code` personal codes |
| `test/discord-e2e.mjs`, `test/discord-sync.mjs` | bot commands and message sync |
| `test/embed.cjs`, `test/embed-view.mjs` | iFrame embedding (parent page in `test/parent/`) |

`test/e2e.cjs` is outdated (written for the old club code) and needs rewriting before use.

## 14. Data model

D1 tables: `plays` (plays; `guest` for guest games, `by_discord` = owner, `via` = web/discord/qr), `parties` (rounds; `attendees` JSON, `host_discord`, Discord message ids, `event_id`/`event_name`, `bring_id`, `play_id` once logged), `config` (`highlights`, `gamemeta`, `owners`, `booking`, `log_key`, `geeklist`), `rate`, `members`, `sessions`, `auth_handoff`, `events`, `member_games`, `bring_requests`, `wanted` ("Hat jemand …?"; `interested` JSON, `status` open/found/withdrawn/expired, `expires_at`), `extra_games`. Details and the shape of the built-in game data are in [`docs/HANDOVER.md`](docs/HANDOVER.md) section 3.

## 15. Go-live on the real N3 Discord server

Only when Johannes says so. In `wrangler.toml`, replace the test values with the prepared ones in the "GO-LIVE" comment block (`DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`, `DISCORD_WANTED_CHANNEL_ID`, `DISCORD_URL`, `DISCORD_MEMBER_ROLE_ID`) and set `DISCORD_ROLE_ID` to the board game role. Then invite the bot to the N3 server, click "Discord-Befehle registrieren", and check the member role in the admin view (a saved value there overrides `wrangler.toml`).

## 16. Open ideas

Only after agreement: own address like `spiele.nerd-nexus.de`; `/code` for non-members only time-limited (2 weeks, max 2 times); installable web app (PWA); a script that rebuilds the built-in game data from the GeekList.
