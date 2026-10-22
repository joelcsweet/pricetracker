# PriceTracker — CLAUDE.md

## Overview

PriceTracker is a personal price-tracking Progressive Web App. It lets one user (no auth/multi-user support) add products with one or more source URLs, a target price, and get notified by email when the lowest price across those URLs drops to or below the target. It runs an automatic check once a day (6am AEST) and supports on-demand individual checks per product. Price history is charted per product (sparkline).

**Audience**: built for a single personal user, not a multi-tenant product right now. No login system exists currently, but this is planned to be implemented

**Current state**: actively developed. Core functionality (add/edit/delete products, daily cron checks, manual checks, email alerts, price history charts, pause/resume) is built and deployed to production. Extraction reliability (especially for Amazon) is an ongoing area of iteration — it is not considered "stable" yet because scraping-based price extraction is inherently fragile and still being tuned.

**Currency**: AUD only, hardcoded in the UI and email templates.

## Tech stack

- **Frontend**: single static HTML file (`index.html`) — no framework, no build step, vanilla JS + inline `<style>`. Fonts from Google Fonts (`Anton`, `Comic Neue`, falling back to system Impact / Comic Sans). Icons from the Tabler webfont via jsDelivr (`@tabler/icons-webfont@3`). Hosted on **GitHub Pages** at `https://joelcsweet.github.io/pricetracker`.
- **PWA**: `manifest.json` + `sw.js` (service worker) for installability on Android/desktop. Cache name currently `pricetracker-v2`.
- **Backend**: **Cloudflare Workers** (serverless), plain JS (ES modules), no framework/router library — routing is done with manual regex matching on `url.pathname`.
- **Database**: **Cloudflare D1** (SQLite-based), binding name `DB`, database name `pricetracker-db`, database ID `53ce159e-fe08-465a-862b-9d90c3f9db4a`.
- **Scraping fallback**: **ScraperAPI** (JS-rendering proxy), used as a fallback only, called via plain `fetch` to `https://api.scraperapi.com`. The key is entered/edited from the app's Settings screen and stored in D1 (`settings` table), not hardcoded or Worker-secret-only — see Key Decisions.
- **Email**: **Resend** API, using the shared sender `onboarding@resend.dev` (no custom domain configured).
- **Deploy tooling**: `wrangler` (currently v3.114.17 — an update to v4 is available but not yet done; deploys emit an out-of-date warning every time).
- **Node/npm**: managed via `worker/package.json` and `worker/package-lock.json`.

## Architecture / general logic

### Repo layout
```
PriceTracker/
├── index.html              — entire frontend (HTML+CSS+JS in one file)
├── manifest.json            — PWA manifest (start_url/scope: "/pricetracker/")
├── sw.js                     — service worker (network-first HTML/manifest, cache-first assets)
├── icon-192.png, icon-512.png
└── worker/
    ├── index.js              — Worker entry point, HTTP routing, most DB logic, checkProduct()
    ├── extract.js             — price extraction cascade (the scraping logic)
    ├── email.js               — sendAlert() via Resend
    ├── checker.js             — runChecks() for the daily cron, calls checkProduct() per active product
    ├── schema.sql             — full DB schema (idempotent, CREATE TABLE IF NOT EXISTS)
    ├── migrate_url_results.sql, migrate_active.sql, migrate_url_check_log.sql
    │                          — one-off ALTER TABLE migrations, applied manually via wrangler
    ├── wrangler.toml          — Worker config: name "pricetracker", main "index.js", cron "0 20 * * *"
    └── package.json
```

### Data flow
1. **Frontend (`index.html`)** talks to the Worker over HTTPS with every request carrying `Authorization: Bearer <API_SECRET>`. Config constants `WORKER_URL` and `API_SECRET` are hardcoded near the top of the `<script>` block (not in a build-time env — this is a static file with no build step).
2. **Worker (`worker/index.js`)** is the single entry point (`export default { fetch, scheduled }`). `fetch()` does auth check then manual route matching; `scheduled()` (the cron handler) calls `runChecks(env)` from `checker.js`.
3. **Checking a product** (`checkProduct()` in `index.js`, exported and used by both the manual `/products/:id/check` route and `checker.js`'s `runChecks`):
   - Splits `product.url` on newlines into a list of URLs.
   - Calls `extract(url, env.SCRAPERAPI_KEY)` from `extract.js` for each URL.
   - If extraction fails for a URL, checks for a same-day manual price to carry forward (see "manual carry-forward" below).
   - Takes the **lowest** successfully-found price across all URLs as the product's price.
   - Writes a diagnostic row per URL to `url_check_log` (price/method/timestamp, even on failure) — added specifically for debugging wrong-price incidents.
   - Only writes a `price_history` row once *every* URL has resolved (no partial/incomplete-price history rows).
   - Sends an email via `sendAlert()` if price ≤ target, deduped via the `alerts_sent` table (won't re-alert for a price already alerted-on-or-below).
   - Sets `status` to one of: `pending` | `ok` | `target_hit` | `needs_attention` | `error`.
4. **Extraction cascade** (`extract.js`, `extract(url, apiKey)`):
   - **Pass 1 — direct fetch** (free): spoofed desktop Chrome User-Agent, `Accept-Language: en-AU`. If the URL is `amazon.*`, tries `tryAmazonBuyBox()` (parses the `corePrice`/`apex_desktop`/`apex_mobile` DOM section for a `a-offscreen` price span) and `tryAmazonOtherSellers()` (regex for "New (N) from $X" teaser text), taking whichever price is lower. For non-Amazon URLs (or Amazon methods failing), tries `tryJsonLd()` → `tryMicrodata()` → `tryMetaTags()` → `tryHeuristic()` (generic text-based scan) in that order — **except** for Amazon URLs on the direct-fetch pass, where the heuristic step is deliberately skipped (see Known Issues).
   - **Pass 2 — ScraperAPI fallback** (costs credits): only invoked if Pass 1 found no price and `SCRAPERAPI_KEY` is set. Fetches via ScraperAPI with `render=true` (JS rendering). Runs the same cascade, but this time the heuristic *is* allowed as a last resort for Amazon too.
5. **Frontend rendering**: `products` is a plain in-memory JS array, re-fetched via `GET /products` on load. `render()` builds all card HTML via `cardHtml()`/`urlPriceRows()`/`badgeHtml()`. Paused products are sorted to the bottom of the display (but not reordered in the underlying array) via a stable sort in `render()`, and card reordering is animated with a hand-rolled FLIP technique (`captureCardRects()` + `playFlipAnimation()`).

### Key DB tables (see `worker/schema.sql`)
- **`products`**: `id` (UUID), `name`, `url` (newline-separated multi-URL string), `target_price`, `currency`, `last_price`, `last_checked_at`, `status`, `extraction_method`, `active` (0/1, pause flag), `created_at`. Also has a JSON-string column `url_results` (added via `migrate_url_results.sql`) storing an array of `{ url, price, method, checked_at? }` per URL — this is the source of truth for per-URL manual entry state and carry-forward logic.
- **`price_history`**: per-product price/timestamp rows, used for the sparkline chart. Only written once a check is "complete" (no missing URLs).
- **`alerts_sent`**: dedup log for email alerts (product_id, price, sent_at).
- **`url_check_log`**: per-URL diagnostic log (url, price, method, checked_at) written on *every* check regardless of success/failure — added specifically to debug wrong-price incidents (e.g. the Amazon $239.25 bug). Pruned to the last 90 days automatically inside `runChecks()`.
- **`settings`**: generic key/value store (`key TEXT PRIMARY KEY, value TEXT`), added via `migrate_settings.sql`. Currently holds one row, `key = 'scraperapi_key'`, editable from the app's Settings screen. `getScraperApiKey(env)` in `index.js` reads this first and falls back to the `SCRAPERAPI_KEY` Worker secret if no row exists yet.

### Key REST endpoints (all require `Authorization: Bearer <API_SECRET>`)
- `GET /products`, `POST /products`, `PATCH /products/:id`, `DELETE /products/:id`
- `POST /products/:id/check` — individual check (`individualCheck: true`)
- `GET /products/:id/history` — price history for the chart
- `GET /products/:id/url-history` — per-URL diagnostic log (last 100 rows)
- `POST /products/:id/manual-price` — save a manual price for one URL
- `GET /settings/scraperapi-key` — `{ saved: bool, last4: string|null }`, never returns the raw key
- `PUT /settings/scraperapi-key` — body `{ key }`, saves/replaces it in the `settings` table
- `DELETE /settings/scraperapi-key` — clears the saved key (falls back to the `SCRAPERAPI_KEY` secret again)

Note: `POST /check-all` and the "Check all" UI button were **intentionally removed** (see Key Decisions) — only individual checks + the daily cron remain.

## Key decisions and rationale

- **Cloudflare Worker + D1 over a traditional server/DB**: chosen for the recommended low-maintenance serverless pairing with built-in cron triggers, no server to keep running.
- **ScraperAPI as fallback-only, not primary**: direct `fetch()` is tried first and is free; ScraperAPI only fires when direct fetch fails or returns no price, specifically to conserve limited free-tier credits.
- **Multi-URL support via newline-separated text column** rather than a separate `urls` table: kept the existing `url` TEXT column and just split on `\n`, storing per-URL extraction results in a new JSON `url_results` column rather than redesigning the schema.
- **"Check all" removed entirely** (both the UI button and `/check-all` endpoint) at the user's explicit request, to force all bulk checking through the daily cron only and avoid burning ScraperAPI credits on-demand. Individual per-product checks remain.
- **Pause/active toggle added** (`active` column, default 1) specifically to let the user skip specific products from the daily cron to save ScraperAPI credits, without deleting them. UI is an iOS-style toggle switch (not the original ⏸/▶ icon button, which was explicitly replaced per user request).
- **Price history only written once a check is fully resolved** (no URL still missing a price): originally, a history row was written using the best price found so far even if other URLs in the same product hadn't resolved yet, which could plot a wrong/incomplete "best price" on the chart. Changed so `price_history` inserts are deferred until every URL has a value.
- **Manual price carry-forward logic**: if a URL's manual price was entered *today*, subsequent checks that day (individual or cron) reuse it instead of re-prompting — but only if there are other URLs (a single-URL product being checked individually always re-prompts). The `checked_at` stamp on each `url_results` entry is what "today" is compared against; carrying the price forward also carries the stamp forward, so it survives further checks within the same day.
- **Amazon-specific extraction methods added after repeated wrong-price incidents**: Amazon's cluttered pages (RRP text in `aria-hidden`/`a-offscreen` spans, "Products related to this item" carousels showing other products' prices, buy-box seller rotation) repeatedly broke the generic heuristic. Rather than trying to patch the generic heuristic further, dedicated `tryAmazonBuyBox()` and `tryAmazonOtherSellers()` methods were added that target Amazon's actual DOM structure.
- **Heuristic explicitly skipped for Amazon on the direct-fetch pass** (kept only for the ScraperAPI-rendered pass as a last resort): when Amazon serves a bot-check/altered page to the Worker's direct fetch, the generic heuristic would confidently return a wrong price scraped from that altered page instead of failing loudly. Skipping it forces escalation to ScraperAPI (JS-rendered, less likely to be blocked) rather than trusting a low-confidence guess.
- **Carousel-heading text scoping was tried and explicitly reverted**: added a `CAROUSEL_MARKERS` list (regexes for headings like "Products related to this item") to truncate HTML before scanning for prices, to stop the heuristic picking up unrelated carousel prices. The user asked to remove this because its reliability was unproven and untested — reverted in favor of relying on the Amazon buy-box/other-sellers methods plus the "skip heuristic on direct fetch" escalation logic instead.
- **Amazon Buy Box vs "Other sellers" price comparison**: added after discovering Amazon shows two legitimately different prices on the same page — the default Buy Box offer, and a cheaper third-party "New (N) from $X" offer. The extractor now checks both and takes whichever is lower.
- **ScraperAPI key moved from a Worker secret to a D1-backed setting, editable in-app**: previously the key only existed via `wrangler secret put SCRAPERAPI_KEY`, meaning any rotation required terminal access. Added a `settings` key/value table and a Settings screen (⚙ button in the topbar) so the key can be viewed (masked, last 4 chars only) and replaced from the app itself. `getScraperApiKey(env)` checks the D1 setting first and falls back to the old secret if nothing's been saved yet, so existing deployments kept working without any forced migration step.
- **No LLM-based extraction fallback**: explicitly deferred/declined early in the project (kept the extraction cascade rule-based).
- **Diagnostic per-URL log (`url_check_log`) added** specifically to stop guessing about wrong-price incidents after the fact — records exactly what price/method every URL produced on every check, so future "why did this price change overnight" questions can be answered from data instead of re-deriving the page state after the fact.
- **Octoparse and "Amazon Creators API" (likely Amazon Product Advertising API) were discussed but not adopted.** Product Advertising API requires an active Amazon Associates account with 3 qualifying sales per 180 days to retain access — not feasible for personal use. Octoparse would improve extraction reliability via visual element selection but wouldn't fix Amazon's per-session/geo price personalization, and would require restructuring `checkProduct`'s synchronous extraction flow into an async poll/webhook model. Neither has been implemented.
- **Decision NOT to always use AU-geo-targeted ScraperAPI for Amazon**: this was proposed (routing every Amazon check through ScraperAPI with `country_code=au` to better match what an AU browser sees) but the user backed out mid-implementation ("nevermind") — not implemented. Current behavior still fetches Amazon directly first, with no geo-targeting parameter ever added to `fetchWithScraper()`.

## Conventions

- **No build step, no bundler, no framework** — `index.html` is a single self-contained file (inline `<style>` and `<script>`), and the Worker is plain ES modules deployed as-is via `wrangler deploy`.
- **Single GeoCities-style look** (a Windows 95 alternative existed briefly and was removed at the user's request — do not reintroduce a theme switcher unless asked): starfield background, red banner with rainbow rule, Impact/Comic Sans type, bevelled grey buttons and borders, a "Hit!" starburst on target-hit cards. Bevels are drawn with border colour pairs (no `box-shadow`). Chart lines/grid/dot are styled by class (`.c-line`, `.c-grid`, `.c-target`, `.chart-dot`) so the SVG has no hardcoded colours. Paused cards are dimmed and dashed. `boot()` removes the old `pt-theme` localStorage key.
- **Status-driven styling**: product cards get a CSS class `status-${p.status}` that sets the card colour (white = hit, yellow = above target, pink = needs price); badges follow the same status vocabulary (`ok`, `target_hit`, `needs_attention`, `error`, `pending`).
- **Store rows show hostnames, not URLs** (`hostOf()`), with the full URL in the link's `title`; the cheapest store is flagged when more than one price exists. The extraction method is still shown per row (user asked for this early on).
- **Extraction method naming convention**: `json-ld`, `microdata`, `meta-tags`, `heuristic`, `manual`, `amazon-buybox`, `amazon-other-sellers` — and any of these get a `scraperapi-` prefix when the HTML came from the ScraperAPI pass rather than direct fetch (e.g. `scraperapi-json-ld`).
- **Comments are used sparingly and only to explain *why*, not *what***, particularly around fragile scraping logic and non-obvious carry-forward/status-priority rules (this matches the user's general working style throughout the project).
- **Secrets are never committed** — always set via `wrangler secret put <NAME>` and referenced only as `env.X` in code. Secret names: `RESEND_API_KEY`, `RESEND_TO_EMAIL`, `API_SECRET`. `SCRAPERAPI_KEY` is a legacy fallback secret only — the live key is normally stored in the `settings` D1 table via the Settings screen (see Key Decisions).
- **Migrations are separate one-off `.sql` files** (`migrate_*.sql`), applied manually via `wrangler d1 execute pricetracker-db --remote --file=...` — `schema.sql` itself is idempotent (`CREATE TABLE IF NOT EXISTS`) but is not re-run automatically when columns are added later; each new column gets its own migration file that must be applied by hand.
- **Deploys are manual**: after any `worker/*.js` change, run `npx wrangler deploy` from `worker/`. Frontend changes just need `git push` (GitHub Pages serves directly from the repo, no build).
- **Windows/PowerShell environment**: `npx` sometimes fails with an execution-policy error requiring `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first — this is a per-session workaround, not a permanent fix.

## Known issues / gotchas

- **Amazon serves different prices to different requesters** (personalization/geo-targeting): a direct server-side fetch from Cloudflare's network can see a materially different Buy Box or "Other sellers" price than the user's own logged-in Australian browser session. Confirmed directly by re-fetching the live page and comparing — this is not a caching or extraction bug, it's inherent to scraping without matching the user's real session/location. No fix is currently implemented (AU geo-targeting via ScraperAPI was proposed but explicitly not built — see Key Decisions).
- **Amazon buy-box seller rotation**: even without personalization concerns, the featured Buy Box seller/price can change between requests (observed $215 vs $239.25 vs eventually matching $187.95 "other sellers" price on the same listing across different checks).
- **Wrong prices from hidden/screen-reader-only text**: Amazon (and possibly other sites) embed duplicate price text in `aria-hidden="..."` attribute values and in visually-hidden elements (`class="a-offscreen"`, `sr-only`, `screen-reader`, `visually-hidden`). The generic heuristic (`tryHeuristic()`) strips these out before scanning, but this fix is heuristic-based itself — a differently-marked-up hidden element could still slip through.
- **The generic heuristic is inherently fragile**: it picks the *most frequently occurring* dollar amount near context words like "price"/"rrp"/"sale" in the plain-text page. This can be fooled by "was" prices, bundle prices, or (previously) unrelated carousel items. It is now the last-resort method for Amazon specifically, but is still the primary method for all non-Amazon, non-structured-data sites.
- **Confirmed non-Amazon example of heuristic failure: Cotton On socks returned $10 instead of $29.99.** The page's site-wide loyalty-program blurb ("100 points = $10 reward") and a "$10 Tops" category promo banner repeated more often than the real price, so the mode-based heuristic picked the wrong one. Fixed by adding `tryDataLayer()` in `extract.js`, which reads the Google Tag Manager "ecommerce dataLayer" JSON (`"products":[{"price":"29.99",...}]`) present on many retail sites (Salesforce Commerce Cloud, Shopify+GTM, etc.) — this is the site's own analytics-reported price, far more reliable than text-scanning, and is now tried before the heuristic for every site (not Amazon-specific). This is the same *class* of bug as the Amazon carousel issue and is expected to recur on other sites with different boilerplate patterns — treat any repeated site-wide promo/loyalty text as a plausible false-positive source when investigating a wrong-price report.
- **Fixed: `getHistory()` returned the OLDEST 90 rows instead of the most recent 90, permanently freezing charts.** The query was `ORDER BY checked_at ASC LIMIT 90` — once a product passed 90 total `price_history` rows, this locked onto whatever the 90th-oldest row was and never advanced, silently excluding all newer checks from the chart. This is a systemic bug that affected **every** product that had accumulated more than 90 checks (e.g. from frequent testing early on), not just one — discovered via the Cotton On socks product, whose chart had been frozen at 2026-08-23 despite daily checks continuing. Fixed to `ORDER BY checked_at DESC LIMIT 90` then reverse in JS. If other long-tracked products' charts look stale, this is the likely explanation and should already be resolved by this fix.
- **Manual-entry carry-forward is per-URL and timestamp-stamped, not global**: relies on the `checked_at` field inside each `url_results` entry, not the product's `last_checked_at`. An earlier version of this logic used the product-level timestamp and had a bug where switching between check types (individual vs. what used to be "check all") caused it to forget the manual entry and re-prompt — fixed by moving the stamp to the per-URL level and ensuring it's preserved (not dropped) when a price is carried forward.
- **Carry-forward window is a true rolling 24 hours, not a calendar-day comparison**: originally compared `YYYY-MM-DD` calendar dates (first raw UTC, briefly AEST-adjusted), which meant the effective carry-forward duration varied depending on what time of day the entry was made (anywhere from ~16 to ~40 hours) or was tied to the 6am AEST cron boundary rather than the entry time. Fixed to compare elapsed milliseconds (`Date.parse(now) - Date.parse(prev.checked_at) < 24 * 3600 * 1000`) in `checkProduct()` — a manual entry now always carries forward for exactly 24 hours from when it was entered, independent of check timing or timezone.
- **Subtitle "N products need attention" can undercount**: a product with status `target_hit` (one URL hit target) but another URL still missing a price shows a manual-entry box on the card, but wasn't originally counted in the `needs_attention` tally (which only checked `status === 'needs_attention'`). Fixed via a `needsManualEntry(p)` helper in the frontend that also checks `url_results` for any null price — but this is the kind of status-vs-per-URL-state mismatch that could recur if new status logic is added without updating both places.
- **ScraperAPI free-tier credits are limited** — this is the whole reason the fallback-only architecture exists. Credits are consumed only when direct fetch fails, but heavy Amazon blocking could burn through them faster than expected once AU-geo-targeting or "always ScraperAPI for Amazon" is (if ever) implemented.
- **PWA install path required careful cache/manifest handling**: `start_url`/`scope` must be `/pricetracker/` (not `/`) to match GitHub Pages' subpath, and the service worker must treat `manifest.json` and HTML navigations as network-first (not cache-first) or an old cached manifest/HTML gets stuck on the installed home-screen app, causing a 404. This was hit twice before being fixed by bumping the cache name (`pricetracker-v2`) and changing the SW's fetch strategy.
- **`wrangler.toml`'s `main` must be `"index.js"`, not `"worker/index.js"`** — wrangler runs from inside the `worker/` folder, so a path including `worker/` fails.
- **D1 writes require `--remote`** — running a migration without it applies to the local dev DB instead of production, silently.

## Open questions / unfinished work

- **No resolution on how to make Amazon prices match what the user actually sees in their browser.** Buy-box + other-sellers comparison is implemented, but the deeper personalization/geo mismatch is unresolved and was left as "monitor and use manual entry as needed" rather than fixed. 
- **No decision made yet on rotating User-Agents, request delay/throttling, or ScraperAPI's premium/residential proxy or session-stickiness features** — these were discussed as possible reliability improvements after a previously-working site started blocking requests, but nothing was implemented.
- **wrangler is on v3 with a v4 upgrade available** and not yet performed.
- **Diagnostic log (`url_check_log`) is new** (added same session as the Amazon buy-box fix) — not yet battle-tested across a full daily cron cycle at the time of most recent work; the "wait and see what tomorrow's 6am run shows" step was in progress at various points in this project's history.

## Things I should never do

- **Never add the "Check all" bulk-check feature back** (UI button or `/check-all` endpoint) — explicitly removed at the user's request specifically to limit bulk checking to the daily cron only and control ScraperAPI credit usage. If bulk checking is needed again, confirm with the user first rather than assuming it should be restored.
- **Never assume Amazon's server-side scraped price matches what the user sees in their own browser.** Treat mismatches as expected personalization/geo behavior, not automatically as extraction bugs — investigate via `url_check_log` / a fresh direct fetch before concluding the code is wrong.
- **Never trust the generic heuristic as authoritative for Amazon on a direct (non-ScraperAPI) fetch.** This is enforced in code (`runCascade` bails to `null` for Amazon direct-fetch if buy-box/structured methods fail) — do not "helpfully" re-enable the heuristic there without addressing the underlying bot-block-page risk.
- **Never commit secrets to any file in this repo.** All four secrets (`SCRAPERAPI_KEY`, `RESEND_API_KEY`, `RESEND_TO_EMAIL`, `API_SECRET`) must only exist via `wrangler secret put`. Treat any exposed key as compromised and prompt the user to rotate it.
- **Never re-run `schema.sql` as a substitute for a proper migration** when adding a new column to an existing table — `schema.sql` is `CREATE TABLE IF NOT EXISTS` only and will not alter existing tables. Always write a dedicated `migrate_*.sql` and apply it with `--remote`.
- **Never apply a D1 migration without `--remote`** without explicitly telling the user it only touched the local dev database.
