# Reuse handover: board game club collection website

**Audience:** another AI assistant (or a developer) who wants to set this website up for a *different* board game club, or keep developing it.
**Reference install:** the Nerd Nexus Nürnberg (N3) collection, this repository, as of 2026-11-13.
**Language note:** code comments, the README and all UI/bot texts are German (UI also English). This handover is in English so it can be reused widely.

> Rule zero: never write tokens, passwords, client secrets, personal codes or full private names into the repo, the page, chats or memory. Secrets live only in Cloudflare (or the secret store of whatever host you choose).

---

## 1. What this is

A public web page that shows a club's board game collection, plus a small backend that lets the community **log plays**, **find players for rounds** and **show what members own and can bring**. A Discord bot runs in the same backend, and Discord is also the login system. Everything runs on one Cloudflare Worker with a D1 (SQLite) database on the free tier, and the club homepage embeds it in an iFrame.

### Feature list (what a club gets)

| Area | Feature |
|---|---|
| Collection | Card grid with BGG covers, ratings, weight, player count (incl. "best with"), duration, age. Filters: players, duration, complexity, category, game type, language (DE/EN/FR/language-neutral), "only two players", live search, sort. Expansions are shown under their base game (bullet list, more than 3 go into a "+ N more" popup). |
| Slideshow | A highlights carousel (games and texts picked by the admin) alternates every 30 s with a "Recently played" view (up to 10 different games). |
| Play log | Log a play (date, players, winner, duration, first play, note). Works for collection games and for **guest games** (any BGG game via live search, or free text). Logged-in users edit/delete only their own plays. |
| Stats tab | Most played, recently played in the club, and similar. |
| Find players ("Mitspieler finden") | Offer a round (game, date, time, seats, note); others join or leave. Rounds are mirrored as Discord messages with buttons and kept in sync both ways. |
| Booking rules | Members (a Discord role) may offer and join rounds on any day. Non-members only on club-night ("Stammtisch") days and must write a short introduction (40 characters or more). Other days are greyed out in the date picker. Club nights are set in the admin view (weekly, nth weekday of month, extra days, cancelled days). |
| Event codes | The admin creates a code for an event (name, valid until, day range). With it, anyone can offer rounds on event days without Discord. The event name shows in the Discord post. |
| QR logging | The admin generates a club key and prints a poster (A4/A5/A6, DE front/EN back). Scanning it opens the log dialog; only a name is needed. Rate-limited, and the key can be rotated. Meant for people without Discord. |
| Member-owned games | Members add their own games (manually or by importing their BGG collection, repeat import = sync), with consent that their Discord server name is shown as owner. Shown purple-framed in a separate tab. Others can ask "please bring this" for up to 3 dates. The bot pings all owners, the first to accept wins, and accepting creates a round with both people in it. Owners who leave the server or lose the role are pruned nightly. |
| Login | "Sign in with Discord" (OAuth2 popup, scope `identify`, 180-day session) or a personal code from the `/code` bot command. Access requires being on the Discord server and seeing the bot channel, plus an optional role. |
| Discord bot | `/party` (offer a round, BGG autocomplete), `/log` (log a play), `/code` (personal web code), join/leave/manage/log buttons, bring-request accept/decline flow. HTTP interactions only, no gateway connection, so no always-on server is needed. |
| Admin ("Verwaltung") | Password login. Highlights, plays (edit/delete), rounds, event codes, QR key and poster, club nights and member role, per-game language/owner/date/inventory metadata, a private owner directory (short name to full name, admin-only), GeekList sync status with a "load from BGG now" button, "register Discord commands" button, Excel export of the inventory. |
| BGG integration | Live search proxy (token server-side, cached 24 h, rate-limited), nightly GeekList read, automatic import of GeekList games missing from the page, cover proxy, member collection import. |
| Embedding | iFrame snippet that auto-resizes and keeps dialogs in the visible part of the host page. `?embed=1`, `?lang=de|en`, `#statistik`, `#partys`. |
| Privacy | No cookies except the short OAuth state cookie, no third-party requests from the browser (fonts and covers are self-hosted or proxied), IP addresses only in the rate table and deleted after 24 h. |

---

## 2. Architecture

```
Browser (club homepage with iFrame, or direct link)
   │  static files: public/index.html (whole UI), qr.html, covers/, fonts/
   │  JSON API: /api/*
   ▼
Cloudflare Worker  (src/index.js, run_worker_first only for /api/*)
   ├── src/auth.js         Discord OAuth login, sessions, access check via bot REST
   ├── src/discord.js      slash commands, buttons, modals, round message sync, DB migrations (ensureCols)
   ├── src/booking.js      club-night rule, member check, intro rule
   ├── src/membergames.js  member-owned games, BGG collection import, bring requests
   ├── src/games.js        GeekList games missing from the page (extra_games), cover proxy
   ├── src/bgg.js          BGG XML API: search, GeekList, collection (token only here)
   ├── D1 database "DB"    plays, parties, config, rate, members, sessions, events, member_games, bring_requests, wanted, extra_games, auth_handoff
   └── Cron                03:17 UTC daily (GeekList, missing games, prune, backfill, rate cleanup); every 20 min (member game backfill)
          ▲
Discord  ─┘  POST /api/discord/interactions (Ed25519-signed); the Worker calls the Discord REST API with the bot token
BGG XML API  ◄── called only by the Worker, with a bearer token
```

Key design choices worth keeping:
- **One file UI.** `public/index.html` is about 300 KB: HTML, CSS, JS, all texts (`TXT.de` / `TXT.en`), and the built-in game data (`<script type="application/json" id="gameData">`). No build step, no framework.
- **Self-migrating database.** `schema.sql` is only the base. `ensureCols()` in `src/discord.js` and `ensurePlayCols()` in `src/index.js` create missing tables and columns on first use, so deploying new code never needs a manual migration.
- **Polling, not websockets.** The page refreshes data every 15 to 20 seconds; your own changes show immediately.
- **No CORS headers.** Other sites cannot call the API from a browser.
- **Background Discord sync.** Discord updates run in `ctx.waitUntil`, and failures never break the web request.

### Request headers used for permissions

| Header | Meaning |
|---|---|
| `X-Admin-Token` | Admin password (compared to secret `ADMIN_TOKEN`; only wrong attempts are rate-limited, 20 per 10 min per IP). |
| `X-Session` | Logged-in user (session token; only its hash is stored in `sessions`). |
| `X-Member-Code` | Personal code from `/code` (legacy, swapped for a session automatically). |
| `X-Log-Key` | QR club key (plays only). |
| `X-Event-Code` | Event code (rounds on event days). |

---

## 3. Data model

### D1 tables

| Table | Purpose | Notes |
|---|---|---|
| `plays` | Logged plays | `game_id` (BGG id or null), `game`, `guest` (1 = not a collection game), `date`, `players`, `winner`, `note`, `duration`, `first_play`, `logged_by` (name for QR plays), `via` (`web`/`discord`/`qr`/…), `by_discord` (owner for edit rights). |
| `parties` | Rounds ("find players") | `attendees` is a JSON object keyed per person so concurrent joins merge. `host_discord` = owner. `discord_channel`/`discord_msg` = mirrored message. `event_id`/`event_name` for event rounds. `bring_id` links to a bring request. `play_id` once logged. |
| `config` | Key/value JSON | Keys: `highlights`, `gamemeta` (per-game language, owner, date, inventory overrides), `owners` (admin-only full-name directory), `booking` (club-night rule + member role), `log_key` (QR key, plaintext so the poster can be reprinted), `geeklist` (last fetch). An old install may still have an unused `club_code_hash` row from the removed 4-digit club code. |
| `rate` | Rate limiting | Key = purpose + IP + time window; purged daily. |
| `members` | Discord users known to the site | `discord_id`, `name`, `code_hash` (personal code, hashed), `blocked`, `checked_at`, `roles` (JSON), `bgg_user`. |
| `sessions` | Web sessions | Token stored only as hash, 180 days. |
| `auth_handoff` | OAuth popup handoff | Short-lived. |
| `events` | Event codes | `name`, `code`, `valid_until`, `date_from`, `date_to`. |
| `member_games` | Games owned by members | `discord_id`, `game_id`, `data` (BGG details JSON, may be null until backfilled), `consent_at`, `src` (`bgg` = imported, removed again by a sync). |
| `bring_requests` | "Please bring" requests | `dates` (JSON, up to 3), `status`, `owners`/`declined` (JSON, multi-owner flow), `party_id` once accepted. |
| `wanted` | "Does anyone have …?" requests (tab "Spiel suchen") | `req_discord`, `req_member`, `game`/`game_id`, `interested` (JSON `[{id,name,m}]`), `status` (open/found/withdrawn/expired), `finder_discord`, `party_id`, `expires_at` (3 months), Discord message ids. |
| `extra_games` | GeekList games not in the built-in data | `data` JSON in the same shape as built-in games, `thumb`. |

### Built-in game data (`#gameData` in `public/index.html`)

```
{ cats:[...EN], catsDe:[...], mechs:[...EN], mechsDe:[...],
  g: [[bggId, name, year, minPlayers, maxPlayers, minTime, maxTime, minAge,
       avgRating, bayesRating, numRatings, weight, rank, best, recommended,
       languageDependence, catIdx[], mechIdx[], designers, ownerFlag, isExpansion, nameEn], ...],
  cov: { bggId: "file in public/covers/" },
  desc: { bggId: [textDe, textEn] },   // highlight texts
  sd: { bggId: "game type letters" } }  // BGG subdomains, e.g. "S" strategy, "F" family, "T" thematic
```

This JSON was generated once from the club's GeekList and BGG data (outside this repo, in the earlier prototype). **There is no generator script in the repo.** See section 6 for how a new club gets its data.

Also in `index.html`: `const DEF_META = {bggId: [inventoryNo, acquiredDate, condition 1-4, ownerFirstName]}`, pre-filled from the N3 inventory spreadsheet. It is N3-specific and must be emptied for a new club.

---

## 4. Base setup for a new club (Cloudflare, recommended)

Prerequisites: Node.js 20+, a GitHub account, a Cloudflare account (free), a Discord server where you are admin, optionally a BGG account.

### 4.1 Get the code
1. Fork or copy this repo into a new repo for the club. Keep it public or private; nothing secret may be in it either way.
2. Apply the generalisation steps from section 5 (at least name, texts, `DEF_META`, game data, IDs in `wrangler.toml`).

### 4.2 Cloudflare
```bash
npm install
npx wrangler login
npx wrangler d1 create <club>-spiele          # copy database_id into wrangler.toml
# also rename name/database_name in wrangler.toml and the db:init scripts in package.json
npx wrangler d1 execute <club>-spiele --remote --file=schema.sql
# skip seed.sql (N3 sample data) or replace it with your own
npx wrangler secret put ADMIN_TOKEN           # long random admin password
npx wrangler deploy
```
Better for automation: in the Cloudflare dashboard use *Workers & Pages → Create → Import a repository*. Every push to `main` then deploys automatically (this is how N3 runs). Bind D1 as `DB` and set the secrets in the dashboard. PR preview builds fail unless you configure previews; disable non-production branch builds or ignore that check.

Optional custom domain: *Worker → Settings → Domains & Routes* (the domain's DNS must be on Cloudflare). Otherwise you get `<worker>.<account>.workers.dev`.

### 4.3 `wrangler.toml` values to set

| Var | What to put |
|---|---|
| `name`, `database_name`, `database_id` | Your Worker and D1 names and the id from `d1 create`. |
| `GEEKLIST_ID` | Your club's BGG GeekList id (the list of club games). Code falls back to N3's list id if empty, so set it or change the fallback in `src/bgg.js`. |
| `PUBLIC_URL` | Public address of the Worker (used for cover images in Discord embeds and as OAuth base). |
| `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY` | From the Discord Developer Portal (public values). |
| `DISCORD_GUILD_ID` | Your server id. Only this server may use the bot and log in. |
| `DISCORD_CHANNEL_ID` | Bot channel id(s), comma separated. The first one receives rounds created on the web and bring requests. Login requires that the user can see the first one. |
| `DISCORD_ROLE_ID` | Optional: role required for web login (empty = no role check). |
| `DISCORD_MEMBER_ROLE_ID` | Start value for the "member" role (booking rules, member games). The admin view setting overrides it once saved. Empty = no member restrictions. |
| `DISCORD_URL` | Invite link for the Discord icon and "join our Discord" buttons. |
| `[triggers] crons` | Keep `"17 3 * * *"` (the code checks this exact string to tell the nightly job from the 20-minute job) and `"*/20 * * * *"`. |

Remove the N3 "GO-LIVE" comment block.

### 4.4 Secrets (Cloudflare only)

| Secret | Source |
|---|---|
| `ADMIN_TOKEN` | You choose (long and random). |
| `BGG_TOKEN` | BGG XML API application token: https://boardgamegeek.com/applications (non-commercial use; describe the club, number of games, daily fetch with caching, "Powered by BGG" credit). |
| `DISCORD_BOT_TOKEN` | Developer Portal → your app → Bot → Reset Token. |
| `DISCORD_CLIENT_SECRET` | Developer Portal → OAuth2 → Client Secret. |

Change any secret with `npx wrangler secret put <NAME>`, no redeploy needed.

### 4.5 Discord app
1. https://discord.com/developers/applications → New Application.
2. *General Information*: copy Application ID and Public Key into `wrangler.toml`. Set **Interactions Endpoint URL** to `https://<your-worker>/api/discord/interactions` (Discord tests it immediately, so deploy first).
3. *Bot*: create the bot, copy the token into the secret. No privileged gateway intents are needed (the bot reads members and roles via REST in its own guild).
4. *OAuth2 → Redirects*: add `https://<your-worker>/api/auth/callback`.
5. Invite the bot: OAuth2 URL generator with scopes `bot` and `applications.commands`, permissions View Channel, Send Messages, Embed Links, Read Message History, Use Application Commands. Make sure it can see the bot channel.
6. On the site, open *Verwaltung* (admin), log in, click **"Discord-Befehle registrieren"**. Repeat this after any change to `COMMANDS` in `src/discord.js`.

### 4.6 First admin steps on the site
- Set the member role and club nights (*"Runden: Mitglieder und Stammtisch-Tage"*).
- Click *"Jetzt von BGG laden"* to read the GeekList; missing games import automatically (max 40 per run, so a large list needs several runs or nights).
- Pick highlights.
- Generate the QR key and print the poster if wanted.
- Fill the owner directory and per-game metadata if you track lenders.

### 4.7 Embed in the club homepage
1. In `public/_headers`, set `Content-Security-Policy: frame-ancestors 'self' https://<club-homepage>` (N3's domain is there now). Use `*` only if any site may embed it.
2. Put `docs/embed-snippet.html` on the homepage (WordPress: a Custom HTML block) with `src` pointing to your Worker plus `?embed=1`. The snippet auto-sizes the iFrame and passes the viewport so dialogs open in view.
3. Inside the iFrame the page hides its own title and intro.

### 4.8 Local development and tests
```bash
cp .dev.vars.example .dev.vars
npm run db:init:local
npm run dev                 # http://localhost:8787
npm test                    # unit tests: BGG parser, Discord, games
```
Integration tests in `test/` run against `test/reset.sh` (fresh Worker on port 8799) with mock Discord servers. Each file's header says which `.dev.vars` values it needs: `web-login.mjs`, `booking.mjs`, `join-rules.mjs`, `member-games.mjs`, `qr-log.cjs`, `member-code.mjs`, `discord-e2e.mjs`. `test/e2e.cjs` is **stale** (written for the old 4-digit club code) and fails; rewrite or delete it.

---

## 5. What is N3-specific and must be generalised

Search the repo for `Nerd Nexus`, `Nürnberg`, `Nuernberg`, `nerd-nexus`, `N3`, `n3-`, `Dienstag`, `Stammtisch`, `Europe/Berlin`, `387061`.

| Item | Where | What to do |
|---|---|---|
| Club name, page title, intro text ("over 180 games every Tuesday from 6 pm") | `public/index.html` (`<title>`, `TXT.de`/`TXT.en`: `title`, `intro`, how-to texts), `public/qr.html` | Rewrite. Ideally move into one `CLUB` config object at the top of the script. |
| Look and feel (dark band like the N3 homepage, orange accent `#f09b19`) | CSS variables at the top of `index.html` | Change the `:root` tokens (light and dark). |
| Built-in game data `#gameData` and `public/covers/` | `index.html`, `public/covers/` | Replace with your club's data, or start with `g: []` and empty `cov/desc/sd` and let the GeekList import fill `extra_games` (see section 6). Keep `covers/logo.png` (Powered by BGG). |
| `DEF_META` inventory (inventory numbers like `N3000xxx`, dates, condition, lender first names) | `index.html` | Set to `{}`. Never put full names in it. |
| Owner flag `'J'`/`'V'` in game rows (lender vs club) | `gameData.g[i][19]` | Reinterpret or ignore. |
| GeekList id fallback `387061` | `src/bgg.js` | Use `GEEKLIST_ID`. |
| BGG `User-Agent` string with the club name | `src/bgg.js`, `src/games.js` | Your club name and contact page (no private email). |
| Hash salts and storage keys (`n3-club:`, `n3-member:`, `n3-sess:`, cookie `n3auth`, `localStorage` keys `n3-*`, postMessage types `n3-games-height`/`n3-games-viewport`) | `src/*.js`, `index.html`, `docs/embed-snippet.html` | Fine to keep. If you change salts, existing hashes stop matching (only matters when migrating an existing install). |
| Time zone `Europe/Berlin` | `src/discord.js` (`berlin()`, `berlinToday`) and date handling in the page | Change for clubs outside CET, ideally to a `TZ` var. |
| Default club nights (Tuesdays + first Saturday, 18:00) | `DEFAULT_BOOKING` in `src/booking.js`, `nextTuesday` in `src/discord.js`, default round time in the page | Change defaults; the admin view overrides at runtime. |
| Discord ids, invite link, role ids, public URL | `wrangler.toml` | Replace (section 4.3). |
| Homepage domain | `public/_headers` | Replace (section 4.7). |
| Bot texts (German only) | `src/discord.js`, `src/booking.js` (`INTRO_HELP`), `src/membergames.js` | Translate if needed. The page translates the stored German bring-request note client-side (key `ptBringNote`). |
| Inventory Excel export columns (match the N3 spreadsheet) | admin code in `index.html` | Adjust to your inventory format. |
| `seed.sql` | repo root | N3 sample rows; delete or replace. |
| README "for new helpers" section (names the N3 maintainer as approver) | `README.md` | Rewrite for your club. |

---

## 6. Getting a club's game data in

Options, from easiest:
1. **GeekList only (no code change).** Create a BGG GeekList with all club games (base games and expansions), set `GEEKLIST_ID`, start with an empty `g` array. The nightly job and the admin button import missing games into `extra_games` (40 per run) and the page merges them via `/api/games/extra`. Covers come through the cover proxy. Limitation: highlight texts (`desc`), German category names and game-type badges may be thinner for imported games than for built-in ones; check how `listExtras` data is merged in `index.html`.
2. **Generate `#gameData` once.** Write a small script (Node, run on a machine that can reach BGG) that reads the GeekList and `xmlapi2/thing?id=...&stats=1` in batches of 20, builds the structure in section 3, downloads covers to `public/covers/`, and writes the JSON into `index.html`. `parseThings` in `src/games.js` and `parseGeeklist` in `src/bgg.js` already do most of the parsing and can be reused. This is the missing "rebuild from GeekList" step noted in the README.
3. **From a spreadsheet.** If the club has an inventory list, match names to BGG ids (BGG search API) and feed the ids into option 1 or 2. `DEF_META` / the `gamemeta` config hold inventory numbers, condition and owners.

Note: BGG answers 202 (queued) or 429 (busy) sometimes; `fetchRetry` retries. Cloud sandboxes (including Claude cloud sessions) usually cannot reach boardgamegeek.com, so test BGG-related changes on a local machine or on the deployed Worker.

---

## 7. Variations

### 7.1 Hosting alternatives

| Option | Effort | Notes |
|---|---|---|
| **Cloudflare Workers + D1** (current) | Lowest | Free tier is enough for a club. Auto-deploy from GitHub. Cron triggers, edge cache, secrets built in. |
| **Self-hosted workerd or Wrangler on a VPS** | Low to medium | `wrangler dev --remote=false` / `workerd` can run the Worker with a local SQLite-backed D1. You must supply HTTPS (reverse proxy such as Caddy), a cron (call a scheduled-trigger endpoint or `wrangler`'s test cron route), backups, and `caches.default` behaviour. Good for clubs that must keep data on their own server. |
| **Node.js + SQLite on a VPS** | Medium | Port `route()` to a small HTTP server (Hono runs on both Workers and Node and would make this easy). Replace `env.DB.prepare(...).bind(...).first()/all()/run()` with `better-sqlite3` (same SQL works; D1 is SQLite). Replace `env.ASSETS` with static file serving, `caches.default` with an in-memory or disk cache, `ctx.waitUntil` with fire-and-forget promises, cron with `node-cron`/systemd timers, and Web Crypto stays (`globalThis.crypto` in Node 20). |
| **WordPress hybrid** | Low | Keep the Cloudflare backend; a tiny WP plugin provides a shortcode that outputs the iFrame snippet (and maybe a settings page for the URL). Maintainers only touch WordPress; the app keeps running on Cloudflare. This was the recommendation when a port to the club's own webhosting was discussed. |
| **Full PHP/WordPress rewrite** | High | Possible on shared hosting: REST routes via `register_rest_route`, tables via `$wpdb`, WP-Cron for nightly jobs. The UI (`index.html`) can stay as is and talk to the new `/api` paths. The Discord bot needs a public HTTPS endpoint that answers within 3 seconds and verifies Ed25519 signatures (`sodium_crypto_sign_verify_detached`); slow shared hosts may time out. Only worth it if the club cannot use any external host. |
| **Static only (no backend)** | Lowest, read-only | Serve `public/` from GitHub Pages or the homepage itself. You lose play logging, rounds, login, bot, live BGG search; the collection, filters and slideshow still work. |

### 7.2 Without Discord
- Leave `DISCORD_*` empty and do not set the bot/OAuth secrets. Then there is no web login, no `/party`/`/log`/`/code`, no member games or bring requests, and booking rules have no member role (treat everyone the same).
- Still works: collection, stats, QR-key logging (name only), event codes for rounds, admin.
- To get personal accounts without Discord you would need another identity source: magic-link email (needs a mail provider), a club-run OAuth (e.g. Google, or the club's WordPress as OAuth provider), or admin-issued personal codes (reuse the `members` table and `/api/auth/code`). Membership roles then come from your own `members.roles` field instead of Discord.
- Other chat platforms (Telegram, Matrix, Slack) can replace the bot by porting `src/discord.js`; the round/play tables stay the same.

### 7.3 Without BGG
- Leave `BGG_TOKEN` empty. Live search falls back to searching the club's own collection plus free text; GeekList import and member collection import are off.
- You then maintain `#gameData` by hand (or from a spreadsheet) and must provide your own covers. Keep the data shape, or simplify the filters that depend on BGG fields (weight, ratings, best player count).
- If you do use BGG data or images, keep the "Powered by BGG" credit (BGG terms).

### 7.4 Smaller variations
- One language only: drop `TXT.en` and the switch.
- No member games, no event codes, no QR: each feature is a self-contained block in the page and a route group in the Worker; hide the UI first, remove code later.
- Different booking rules: all logic is in `src/booking.js` plus the date picker in the page.

---

## 8. Go-live checklist for a new club

1. Generalisation done (section 5); no other club's names, ids, inventory data or texts left.
2. D1 created, schema applied, `seed.sql` skipped or replaced.
3. Secrets set: `ADMIN_TOKEN`, `BGG_TOKEN`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET`.
4. `wrangler.toml` vars set for the **real** server (test on a separate test Discord server first, then swap ids: guild, channel, invite, member role, login role).
5. Discord: interactions endpoint, OAuth redirect, bot invited to the real server and able to see the bot channel.
6. Admin: "register Discord commands", member role and club nights saved, GeekList loaded, highlights picked.
7. `frame-ancestors` set to the homepage, embed snippet on the homepage, check on phone and desktop.
8. Test as a non-member and as a member: login, offer a round on a club night and on another day, join, log a play, `/party`, `/log`, `/code`, a bring request.
9. Privacy statement on the homepage mentions: Discord login data (id, name, roles), names of players in rounds and plays, short-term IP storage for rate limits, Cloudflare server logs.
10. Backups configured (section 9).

---

## 9. Operations and backups

- **D1 Time Travel**: Cloudflare keeps point-in-time restore for D1 (30 days on paid plans, 7 days on free, check current limits). `npx wrangler d1 time-travel restore <db> --timestamp=...`.
- **Manual export**: `npx wrangler d1 export <db> --remote --output backup.sql`.
- **Nightly backup**: a nightly automatic backup is being built for N3 in a separate piece of work (2026-11-13); check the repo for it before building your own.
- **Logs**: `npx wrangler tail` or the Worker's Observability tab (enabled in `wrangler.toml`).
- **Token rotation**: `wrangler secret put`. Rotate the QR key in the admin view if the poster link leaks; delete an event code to stop it.
- **Limits** (all in `src/index.js`/`src/membergames.js`): admin wrong-password 20/10 min/IP; writes (plays, rounds) 40/10 min/IP; joins 30/10 min/IP; QR plays 40/h/IP and 150/day total; event rounds 60/day per event; wrong keys/codes 15-20/10 min/IP; BGG search 60/min/IP; covers 120/min/IP; bring requests 5/day/person and 30/day in total; member games max 1000 per member; import body 400 KB.

---

## 10. Known limits and open ends

- No script in the repo regenerates `#gameData` from the GeekList (section 6). GeekList import adds max 40 games per run.
- Claude cloud sessions and many sandboxes cannot reach BGG (proxy 403). Test BGG code locally or via Remote Control on a real PC.
- `test/e2e.cjs` is stale.
- Discord bot texts are German only.
- Time zone and default club nights are hardcoded (Europe/Berlin, Tuesday 18:00, first Saturday).
- Club-specific values are spread over `index.html`, `src/*.js` and `wrangler.toml` instead of one config file. Collecting them into one `CLUB` object (page) and `[vars]` (Worker) is the first refactor to do before supporting several clubs.
- One deployment per club. Multi-tenant (several clubs in one Worker) would need a `club_id` column on every table and per-club Discord config; not designed for that.
- Data refresh is polling (15-20 s).
- The homepage events calendar of N3 (WordPress EventPrime) had no usable feed, so club nights are rules in the admin view, not imported. Another club with an iCal feed could import them.

### Ideas discussed but not built (N3 backlog)
- `/code` permanent only for members; non-members get a code valid 2 weeks, max 2 times.
- Installable PWA.
- Custom domain like `spiele.<club-domain>`.
- SEO: meta tags and sitemap in the app, plus text on the homepage page.

---

## 11. How an AI should work on this

- Read `README.md` (German, operations detail) and this file first.
- Work on a branch and open a pull request; with Cloudflare auto-deploy, a merge to `main` is a production deploy.
- Run `npm test` before each PR, plus the relevant `test/*.mjs` file when login, rights, booking or member games change.
- After changing slash commands, click "register Discord commands" in the admin view after deploy.
- Keep secrets in Cloudflare only, and keep full names, personal codes and private ids out of the repo, the page and chat logs.
