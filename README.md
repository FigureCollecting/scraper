# Scraper Service

A web scraping microservice with browser automation, browser pooling, priority queuing, and full MFC collection sync. Designed to bypass Cloudflare protection and handle dynamic content. Features a 3-tier priority queue, HMAC-signed webhook callbacks, session management with pause/resume, and comprehensive test coverage across 26 test suites.

## Features

- **Generic Scraping**: Configurable selectors for any website
- **Browser Pool**: Pre-launched browsers for instant responses (3-5 second scraping vs 15+ seconds)
- **Site Configurations**: Pre-built configs for common sites (MFC, extensible to others)
- **Cloudflare Bypass**: A real, current Chrome launched clean (`BROWSER_LAUNCH_MODE=clean-headful`) — see **The browser lane** below
- **MFC NSFW Authentication**: Support for authenticated scraping with user's own session cookies
- **Challenge-Gated Hosts**: One long-lived browser per egress, gated stores fetched in its default context, so an earned Cloudflare clearance is reused, not re-earned
- **Full Collection Sync**: End-to-end workflow: validate cookies, export CSV, parse items, queue for scraping
- **3-Tier Priority Queue**: HOT/WARM/COLD priority lanes with deduplication and adaptive rate limiting
- **Session Management**: Cookie validation caching, automatic pause on failures, cooldown periods
- **HMAC Webhook Callbacks**: Signed callbacks to backend with SHA-256 authentication
- **Schema v3 Extraction**: Company/artist extraction, release date/price parsing, field auditing
- **Label Registry**: Regex-based MFC label pattern matching
- **Robust Error Handling**: Handles timeouts, challenges, and extraction failures
- **RESTful API**: HTTP interface with scraping, sync, and management endpoints
- **Docker Ready**: Optimized container with Chrome for Testing on Ubuntu 24.04
- **Comprehensive Testing**: 760+ tests across 26 suites with Jest, Supertest, and testcontainers

## Ethical Use & Legal Compliance

### Intended Use Cases

This scraper is designed for **personal data management** and **legitimate collection organization**:

✅ **Authorized Use Cases:**
- Scraping your own user data from websites where you have an account
- Managing personal figure collections with enhanced organization
- Aggregating content you own or have permission to access
- Educational research and personal archival
- Building better UIs for your own data

❌ **Prohibited Use Cases:**
- Scraping copyrighted content for redistribution
- Bypassing paywalls or authentication for unauthorized access
- Bulk data harvesting for competitive purposes
- Automated scraping that violates a site's Terms of Service
- Any use that could harm the target website or its users

### MFC NSFW Authentication

The NSFW authentication feature uses a **real browser session** (see **The browser lane**) to get past Cloudflare's bot check. This functionality is provided **exclusively for users to access their own authenticated content**:

- **User's Own Data**: Only scrape figures visible to the authenticated user
- **Personal Use**: For organizing and managing the user's own collection
- **Session Cookies**: User provides their own valid session cookies
- **No Credential Storage**: Cookies are time-limited bearer tokens, not permanent credentials
- **Respects Permissions**: User can only access content allowed by their MFC account settings

**Privacy Model**: Similar to how Plex manages your movie library or Calibre organizes your ebooks - this tool helps you better organize content you legitimately own or have access to.

### Legal Disclaimer

By using this service, you agree to:
1. Only scrape content you have permission to access
2. Comply with all applicable Terms of Service
3. Respect robots.txt and rate limiting
4. Use scraped data only for personal, non-commercial purposes
5. Not redistribute scraped copyrighted content

**This software is provided for legitimate personal use only. Users are solely responsible for ensuring their use complies with applicable laws and website terms of service.**

## Services Architecture

The scraper is composed of 12 service modules (6,897 total lines):

| Service | Lines | Purpose |
|---------|-------|---------|
| `genericScraper.ts` | 1,110 | Browser pool management, base scraping logic |
| `scrapeQueue.ts` | 1,050 | 3-tier priority queue (HOT/WARM/COLD), deduplication, rate limiting |
| `syncOrchestrator.ts` | 862 | Full sync workflow: validate → export → parse → queue |
| `sessionManager.ts` | 851 | Cookie validation caching, pause/cooldown management |
| `mfcListsFetcher.ts` | 843 | Fetch user lists and items from MFC |
| `mfcCsvExporter.ts` | 538 | CSV export from MFC Manager |
| `companyArtistExtractor.ts` | 461 | Schema v3 company/artist extraction |
| `cacheConfig.ts` | 326 | Cache TTL calculation |
| `releaseExtractor.ts` | 304 | Release date and price extraction |
| `webhookClient.ts` | 277 | HMAC-SHA256 signed callbacks to backend |
| `mfcLabelRegistry.ts` | 180 | Regex-based MFC label pattern registry |
| `fieldAuditCollector.ts` | 95 | Field completeness auditing |

## API Endpoints

### Scraper Routes

### POST /scrape
Generic scraping with custom configuration.

**Request Body:**
```json
{
  "url": "https://example.com/item/123",
  "config": {
    "imageSelector": ".product-image img",
    "manufacturerSelector": ".brand-name",
    "nameSelector": ".product-title",
    "scaleSelector": ".scale-info",
    "waitTime": 2000
  }
}
```

### POST /scrape/mfc
Convenience endpoint for MyFigureCollection (uses pre-built config).

**Request Body (Public Content):**
```json
{
  "url": "https://myfigurecollection.net/item/597971"
}
```

**Request Body (NSFW Content with Authentication):**
```json
{
  "url": "https://myfigurecollection.net/item/422432",
  "config": {
    "mfcAuth": {
      "sessionCookies": {
        "PHPSESSID": "your_session_id",
        "sesUID": "your_user_id",
        "TBv4_Iden": "your_user_id",
        "TBv4_Hash": "your_hash_value"
      }
    }
  }
}
```

**How to Get MFC Session Cookies:**
1. Log into MyFigureCollection in your browser
2. Open DevTools (F12) → Application/Storage → Cookies
3. Find `myfigurecollection.net` domain
4. Copy the four required cookie values
5. ⚠️ **Security**: Cookies expire (typically monthly), treat like passwords

**Note**: NSFW scraping runs through the browser lane (a real Chrome session) and requires valid authentication cookies from your own MFC account.

**Response (both endpoints):**
```json
{
  "success": true,
  "data": {
    "imageUrl": "https://images.goodsmile.info/...",
    "manufacturer": "Good Smile Company",
    "name": "Nendoroid Hatsune Miku",
    "scale": "1/1"
  }
}
```

### GET /configs
Get available pre-built site configurations.

**Response:**
```json
{
  "success": true,
  "data": {
    "mfc": {
      "imageSelector": ".item-picture .main img",
      "manufacturerSelector": "span[switch]",
      "nameSelector": "span[switch]:nth-of-type(2)",
      "scaleSelector": ".item-scale a[title=\"Scale\"]"
    }
  }
}
```

### GET /health
Health check endpoint for monitoring.

### GET /health/detailed
Detailed health check with browser pool status plus two operator views (additive, never cookie values):
- `challengeCooldowns`: `[{host, remainingMs, reason}]` — the per-host Cloudflare-challenge cooldowns currently open
- `cfCookies`: `[{host, cookieNames, userAgentPinned, loadedAt, mintedAt?, expiresAt?, stale, staleSince?, staleReason?}]` — the stored-cookie jar (`CF_COOKIE_FILE`) per host. `stale: true` means the host still served a challenge WITH its stored cookies: re-mint (see *Stored Cloudflare cookies* under Environment Variables). `[]` when the jar is disabled.
- `browserLane`: `{launchMode, residentialTimezone, directTimezone, processTimezone, gatedBrowsers}` — the lane's live configuration. `processTimezone` is the one that decides a Cloudflare challenge (`null` = a UTC container = gated stores silently never clear); `gatedBrowsers` is `[{egress, launchedAt, pagesOpen, primedHosts}]`, the live per-egress challenge browsers.
- `imageCapture`: `{enabled, attempted, stored, deduped, skipped{policyDeny, memo, thumbnailRole, userRole, cap, residentialBudget, notImage, tooLarge}, failed, residentialBytesToday}` — the image capture hook's counters. The lane never fails an item, so these are the ONLY signal it gives: the named skips are what separates "no store here publishes images" from "every plate is being denied", "the home line is spent", or "this CDN answers every image with a block page". `stored` counts captures handed to the asset lane; `rawStore.stats` says what actually landed.
- `residentialEgress`: `{configured, proxy?}` — whether a residential egress proxy (`RESIDENTIAL_PROXY_URL`) is wired. `proxy` (its `scheme://host:port`) appears only under `RESIDENTIAL_EGRESS_HEALTH_DETAIL=true`, since this endpoint is unauthenticated; credentials are stripped at the source either way, so a `user:password@` proxy never appears here. `{configured: false}` ⇒ every store declaring `egress: 'residential'` is refused (see *Residential egress* under Environment Variables).

### GET /version
Get service version information for version management.

**Response:**
```json
{
  "name": "scraper",
  "version": "2.2.0",
  "status": "healthy"
}
```

### GET /mfc/cookie-allowlist
Get the list of allowed MFC cookie names for authenticated scraping.

### GET /catalog
One page of a store's newest-first catalog listing — the enumeration feed the crawler walks
(mode *recent*: the first pages for fresh ids; mode *backfill*: a saved page cursor, deeper in).
A store serves it when its ruleset plugin declares a `retrieval.byListing` axis
(`{ urlTemplate /* contains {page} */, pageStart?, maxPerPage?, order: 'newest' }`) and an
`extractListing()` parser (plugin-contract 0.6.0). The page is fetched through the store's declared
search transport (`http` / `impersonate` / `browser`) under the per-host challenge cooldown.

**Query:** `store=<siteId>` (required), `page=<n>` (positive integer; default = the store's `pageStart`, else 1)

**Response (200):**
```json
{
  "siteId": "orzgk",
  "page": 1,
  "url": "https://www.orzgk.com/wp-json/wc/store/v1/products?orderby=date&order=desc&per_page=100&page=1",
  "items": [{ "itemId": "68064530", "collectUrl": "https://www.orzgk.com/wp-json/wc/store/v1/products/68064530" }],
  "collectUrls": ["https://www.orzgk.com/wp-json/wc/store/v1/products/68064530"],
  "hasMore": true,
  "nextPage": 2,
  "count": 1
}
```
Each item carries the store's `itemId`, the page `url` when the plugin emitted one (untouched), and
`collectUrl` — the URL to ingest: the store's `byId` endpoint where declared, else the page link
absolutized against the listing url (http(s) only). `hasMore`/`nextPage` come from the plugin when
it reports them, else a non-empty page implies more with `nextPage = page + 1`.

**Errors:** `400` missing/blank `store` or a non-positive-integer `page` · `422 { error: "unsupported", siteId, reason }`
(unknown store, no `byListing` axis, or no `extractListing` parser) · `503 { error: "cooldown", siteId, host, remainingMs }`
with `Retry-After` while the listing host cools from a Cloudflare challenge · `502 { error: "catalog failed", siteId, reason }`
(challenge page — which also opens the host cooldown — fetch error, timeout, or parser throw).

#### GET /catalog?range=1 — the id-range axis

A store whose ids are SEQUENTIAL (`retrieval.byRange: true` plus a `byId.urlTemplate` — mfc's ~3.6M
numeric item ids) needs no listing to be enumerated: its id space *is* the listing. This axis
SYNTHESIZES a descending window of that space and never fetches or parses anything. It does honour
the challenge cooldown of the host its item urls point at: a window handed out while that host is
cooling would be enqueued in full, ledgered as done and walked past while every item fast-failed.

**Query:** `store=<siteId>` (required), `range=1` (required, exactly `1`), `from=<id>` (required,
positive integer — the highest id in the window), `count=<n>` (optional, default `50`, clamped to
`[1, 200]`). `range` and `page` are mutually exclusive; a `from` without `range` is ignored.

**Response (200):**
```json
{
  "siteId": "mfc",
  "from": 3630000,
  "items": [{ "itemId": "3630000", "collectUrl": "https://myfigurecollection.net/item/3630000" }],
  "collectUrls": ["https://myfigurecollection.net/item/3630000"],
  "hasMore": true,
  "nextFrom": 3629999,
  "count": 1
}
```
The window walks DOWN from `from` and stops at id `1` (`hasMore: false`, no `nextFrom`). Ids in the
window that do not exist at the store are EXPECTED: this surface never probes them, so a gap surfaces
later as the ingest fetch's own 404 — a miss in the ingest lane, not an error here.

**Errors:** `400` bad input (blank `store`, `range` other than `1`, `range` with `page`, missing or
non-positive-integer `from`, non-positive-integer `count`) · `422 { error: "unsupported", siteId, reason }`
(unknown store, no `byRange` axis, or no `byId` template — or one without an `{id}` placeholder — to
build item urls from) · `503 { error: "cooldown", siteId, host, remainingMs }` with `Retry-After` while the item host cools
from a Cloudflare challenge · `502 { error: "catalog failed", siteId, reason }`.

#### GET /catalog?seed= — the declared seed-list axis

A **seed list** is one page a store publishes anyway — a shelf, a "what's new" panel, a featured
rail — that its plugin DECLARES in `retrieval.seedLists` (plugin-contract 0.9.0):
`[{ id, url, cadence: 'weekly' | 'daily', note? }]`. This axis fetches ONE of them by name and hands
it to the ruleset's `extractSeedList(body, listId)` parser.

It is not a cheaper way into a store and not a second enumeration axis. The lane is EXACTLY the
listing axis's — the store's own declared search transport, its egress and session-prime
declarations, the same per-host challenge cooldown, the same challenge detection and the same
stored-cookie stale/fresh signals. What differs is only the size of the target: `byListing` walks a
whole catalogue page after page, while the set of seed lists is finite, written down in advance, and
therefore has a cost that is knowable before it runs. That is what makes the axis safe to point at a
store which has to be treated gently.

**Query:** `store=<siteId>` (required), `seed=<listId>` (required, non-blank — a seed list is
addressed by NAME; there is no default list). `seed`, `seeds`, `page` and `range` are mutually
exclusive.

**Response (200):**
```json
{
  "siteId": "examplestore",
  "listId": "new-arrivals",
  "url": "https://example.test/new",
  "items": [{ "itemId": "11", "collectUrl": "https://example.test/item/11" }],
  "collectUrls": ["https://example.test/item/11"],
  "hasMore": false,
  "count": 1
}
```
`hasMore` is ALWAYS `false` and there is never a `nextPage`: a seed list is one whole page by
construction, so there is nothing to walk. A parser that returns `hasMore: true` is ignored rather
than believed — the engine has no second page it could fetch. `collectUrl` follows the same rule as
the listing axis: the store's `byId` endpoint where declared, else the item's page link absolutized
against the declared list url.

**Errors:** `400` blank `seed`, or `seed` combined with `page`/`range`/`seeds` ·
`422 { error: "unsupported", siteId, reason }` (unknown store, the store declares no seed lists, no
list with that id, a malformed declared url, or no `extractSeedList` parser) ·
`503 { error: "cooldown", siteId, host, remainingMs }` with `Retry-After` ·
`502 { error: "catalog failed", siteId, reason }` (challenge page — which also opens the host
cooldown — fetch error, timeout, or parser throw).

#### GET /catalog?seeds=1 — seed-list discovery

Which lists a store declares, in DECLARED order. Pure: it reads the store's profile and fetches
nothing upstream. A poller has to learn WHICH lists exist before it can ask for one, and the
declaration is the only place that is recorded — an operator env var naming them would be a second
copy, free to diverge from the plugin.

**Query:** `store=<siteId>` (required), `seeds=1` (required, exactly `1`; exclusive with `seed`,
`page` and `range`).

**Response (200):**
```json
{
  "siteId": "examplestore",
  "seedLists": [
    { "id": "new-arrivals", "url": "https://example.test/new", "cadence": "daily", "note": "front shelf" },
    { "id": "staff-picks", "url": "https://example.test/picks", "cadence": "weekly" }
  ],
  "count": 2
}
```
The url is reported so a poller can see when TWO declared ids resolve to the SAME page — an authoring
slip that would otherwise cost a store one wholly redundant fetch per pass, on the axis whose whole
point is a cost knowable in advance. Fetching a list is still this axis's job, never the caller's.
Malformed entries in an untrusted declaration (no id, no url, a cadence outside the contract's two,
a repeated id) are dropped rather than reported as lists that would never yield anything. Two entries
sharing one url are BOTH reported here: collapsing them is the caller's call, since dropping one
engine-side would make that id unaddressable.

**Errors:** `400` `seeds` other than `1`, or combined with another axis ·
`422 { error: "unsupported", siteId, reason }` (unknown store, or it declares no seed lists) ·
`502 { error: "catalog failed", siteId, reason }`.

### Search query encoding (`retrieval.bySearch.queryEncoding`)
`{q}` is url-encoded into the store's `bySearch.urlTemplate` by `encodeSearchQuery`
(`src/driver/retrievalPlanner.ts`), which every search caller goes through (`/lookup` fan-out,
single-store search, record mode). The default is one `encodeURIComponent` — unchanged for every
store that declares nothing. A plugin that declares `queryEncoding` (plugin-contract 0.8.0) gets
these steps applied, in this order and no other:

| field | effect |
|---|---|
| `strip: string[]` | delete each listed substring from the RAW query, before any escaping (matched literally) |
| — | `encodeURIComponent(query)`, always |
| `reEncodePercentOf: string[]` | re-encode the `%` of each listed percent-escape (`%2f` → `%252f`), one pass, matched case-insensitively and emitted in the DECLARED spelling |
| `spaces: 'percent' \| 'plus'` | `plus` rewrites every `%20` to `+`; `percent` (the default) leaves it |
| `lowercase: boolean` | lowercase the finished segment |

This exists for storefronts that carry `{q}` in a PATH SEGMENT: there a singly-escaped `/` is read
as path structure, so the route does not match and the store answers HTTP 404 rather than a
zero-result page — indistinguishable, from the caller's side, from "this store has nothing". A
store on `https://example.test/Search-{q}/list-r1.html` declaring
`{ reEncodePercentOf: ['%2f'], spaces: 'plus', lowercase: true }` gets `"star origin 1/6"` as
`star+origin+1%252f6` instead of `star%20origin%201%2F6`. It matters wherever records resolve by a
scale-bearing identity, which makes a query carrying "1/6" that store's normal shape.

Which escapes a store re-encodes, which substrings it strips and whether it folds case are the
store's own business: they are declared in that store's (private) plugin profile. The engine holds
no store's rules — it replays the declaration it is handed, and applies one `encodeURIComponent`
when there is none.

### POST /reset-pool (Test Environment Only)
**This endpoint is only available in non-production environments.**

Manually reset the browser pool for testing or emergency situations.

**Security:**
- **Environment Protection**: Only registered in non-production environments
- **Authentication Required**: Must provide valid `x-admin-token` header
- **Async Operation**: Properly closes all browsers before resetting

**Request Headers:**
```
x-admin-token: <admin-token-value>
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Browser pool reset successfully"
}
```

**Response (Unauthorized):**
```json
{
  "success": false,
  "message": "Forbidden"
}
```

**Features:**
- Clears all existing browser instances safely
- Recreates the browser pool
- Useful for manual browser pool management during testing
- Can be used to mitigate Cloudflare detection issues

**Use Cases:**
- Force browser pool refresh during testing
- Reset pool after detecting browser fingerprinting changes
- Emergency recovery from browser cache/session issues in test environments

### Sync Routes

### POST /sync/validate-cookies
Validate MFC session cookies before starting a sync operation.

### POST /sync/export-csv
Export user collection data from MFC as CSV.

### POST /sync/from-csv
Parse a CSV export and queue items for scraping.

### POST /sync/full
Full sync workflow: validates cookies, exports CSV, parses items, and queues them for scraping.

### GET /sync/status
Get the current status of the sync operation.

### GET /sync/queue-stats
Get detailed queue statistics for monitoring.

**Response:**
```json
{
  "success": true,
  "data": {
    "queues": { "hot": 10, "warm": 5, "cold": 100 },
    "total": 115,
    "processing": 1,
    "completed": 50,
    "failed": 2,
    "rateLimit": {
      "active": false,
      "currentDelayMs": 3000
    }
  }
}
```

### Session Management Endpoints

#### GET /sync/sessions
Get all active sessions with their status.

**Response:**
```json
{
  "success": true,
  "data": {
    "sessions": [
      {
        "sessionId": "abc12345...",
        "isPaused": true,
        "consecutiveFailures": 3,
        "failedMfcIds": ["123456", "789012"],
        "inCooldown": false,
        "cooldownRemainingMs": 0
      }
    ],
    "count": 1,
    "pausedCount": 1,
    "inCooldownCount": 0
  }
}
```

#### POST /sync/sessions/:sessionId/resume
Resume a paused session to continue processing.

**Response:**
```json
{
  "success": true,
  "message": "Session resumed, processing will continue"
}
```

#### POST /sync/sessions/:sessionId/cancel-failed
Cancel all failed items for a session (removes them from queue).

**Response:**
```json
{
  "success": true,
  "message": "Cancelled 3 failed items",
  "data": { "cancelledCount": 3 }
}
```

## Ingestion Initiator (interim discovery feeder)

`node dist/initiator/run.js` performs ONE bounded discovery pass and exits — recurrence is the
CronJob's schedule, stop is the CronJob's `suspend: true`. It is a thin HTTP client of this
service's own `GET /lookup?q=&mode=&stores=` (search) and `POST /ingest/scrape`; it imports
nothing from `src/driver/*`.

- **One lookup per term x store.** Each call carries a SINGLE siteId in `&stores=`. The engine
  bounds each store's search by `LOOKUP_STORE_TIMEOUT_MS` (15 s default), so a shared fan-out
  made the slowest store the whole term's latency: on 2026-09-07 09:00Z amiami hit that bound,
  the initiator's own `INITIATOR_REQUEST_TIMEOUT_MS` abort fired, and EVERY store reported
  `discovered=0` for the hour. Scoped per store, a slow or failing store costs only its own
  lookup. Only candidates for the store the call asked for are consumed.
- **Stores run in parallel, a store's terms run in sequence.** Store-major submission put every
  concurrent gate slot on the SAME store, so one hung store delayed every other store's first
  lookup by a whole request timeout. One term at a time per store keeps the in-flight set on
  distinct stores, and a term whose store has already filled `INITIATOR_MAX_URLS_PER_STORE` is
  skipped entirely — its results could only be discarded. (`0` = the discovery-only dry run:
  every term is still looked up.)
- **Retry once, on transient faults only.** An abort/timeout, a network error, an HTTP 5xx, a
  `429` or a `408` is retried ONE more time after `INITIATOR_LOOKUP_RETRY_DELAY_MS`. Any other
  **4xx is never retried** (the same request would be refused the same way), and neither is a 2xx
  body that will not parse. A store gets **one retry for the whole pass**, not one per term: a
  store already failing would otherwise double both the discovery budget and the wall clock. The
  retry is a normal request: same gate, same budget.
- Discovered URLs are deduped per store ACROSS terms and capped at `INITIATOR_MAX_URLS_PER_STORE`;
  each is POSTed to `/ingest/scrape`, which dedups by URL (re-running a pass is idempotent). The
  initiator prefers a candidate's engine-derived `collectUrl` over its page `url`. The POSTs are
  interleaved **round-robin across stores**, so a budget that runs out costs every store its Nth
  URL instead of erasing the tail of `INITIATOR_STORES` on every pass.
- Every request — lookups (retries included) and ingest POSTs — passes through ONE global gate
  (concurrency, total budget, spacing) over the single egress IP, and the whole pass is bounded by
  `INITIATOR_PASS_DEADLINE_MS` so an over-running pass cannot overlap the next CronJob tick.
- **Size the budget**: `stores x terms` lookups `+ stores` retries `+ stores x maxUrlsPerStore`
  ingests. Discovery spends the shared budget FIRST, so an under-sized budget silently drops
  discovered URLs; the pass logs an `[ERROR]` at start when `INITIATOR_MAX_REQUESTS` is below that
  figure, and another at the end naming how many URLs a spent budget dropped.
- Each lookup call logs one INFO line whose HEADER carries its identity —
  `[INITIATOR] lookup store=amiami term=lucy status=200 ms=812 candidates=12 kept=5` (`candidates`
  = what the store returned, `kept` = what the per-store cap let through) — and every retry,
  failure, or dropped ingest logs a WARN naming `store=` and `term=`. A terminal lookup failure
  also counts toward that store's `errors`, so a store whose lookups all failed is not reported as
  a healthy store with no matches. The run ends with an `[INITIATOR] pass complete` JSON summary
  plus a per-store line: discovered, enqueued, deduplicated, errors, skipped, lookupAttempts,
  lookupRetries, lookupFailures. The pass-level `lookupFailures` is the per-store sum.

| Variable | Default | Meaning |
|---|---|---|
| `SCRAPER_SERVICE_URL` | `http://localhost:3050` | The scraper's HTTP surface (the only thing the initiator talks to) |
| `INITIATOR_STORES` | 7 proven-GO siteIds | csv of siteIds; explicitly empty = no work (kill switch) |
| `INITIATOR_TERMS` | `nendoroid` | csv of discovery terms; explicitly empty = no work |
| `INITIATOR_LOOKUP_MODE` | `listed` | `listed` (all, incl. sold-out) or `orderable` (in-stock only) |
| `INITIATOR_MAX_CONCURRENCY` | `2` | Global max in-flight requests across all stores |
| `INITIATOR_MAX_REQUESTS` | `60` | Global request budget (lookups + retries + ingest POSTs); size it as `stores x terms + stores + stores x maxUrlsPerStore`; `0` = kill switch |
| `INITIATOR_MAX_URLS_PER_STORE` | `5` | Max distinct URLs enqueued per store per run, across terms; `0` = discovery-only dry run |
| `INITIATOR_REQUEST_SPACING_MS` | `1000` | Minimum spacing between consecutive dispatches |
| `INITIATOR_REQUEST_TIMEOUT_MS` | `20000` | Per-request abort timeout — keep it ABOVE the engine's `LOOKUP_STORE_TIMEOUT_MS` (15 s) plus assembly, or the client abort always wins and the engine's bounded answer is never seen |
| `INITIATOR_LOOKUP_RETRY_DELAY_MS` | `5000` | Delay before the ONE retry a transiently-failed lookup gets; `0` = retry immediately |
| `INITIATOR_PASS_DEADLINE_MS` | `2700000` | Wall-clock ceiling on one pass (45 min); past it nothing further is dispatched; `0` = no deadline |

## Catalog Crawler (ingestion feeder)

`node dist/crawler/run.js` performs ONE bounded catalog-crawl pass and exits — recurrence is
the CronJob's schedule, stop is the CronJob's `suspend: true`. It is a thin HTTP client of this
service's own `GET /catalog?store=&page=` (a store's newest-first listing) and
`POST /ingest/scrape`; it imports nothing from `src/driver/*`.

- **recent** — from page 1 of the listing, up to `CRAWLER_RECENT_MAX_PAGES`: POST every new
  item's `collectUrl`, and stop at the first page that yields nothing new. A known item counts
  as new again once its ledger entry is older than `CRAWLER_REOBSERVE_AFTER_MS` (0 = never).
- **backfill** — resume the store's saved page cursor for up to `CRAWLER_BACKFILL_PAGES_PER_RUN`
  pages, new ids only. The cursor advances only when the page reported `hasMore: true` AND every
  new item on it was attempted (`nextPage` is ignored); a page cut short by the per-store cap, the
  global budget, or a 5xx from `/ingest/scrape` is re-fetched next run.
- **id-range backfill** — for the stores named in `CRAWLER_RANGE_STORES` only: walk the store's
  SEQUENTIAL id space downward through `GET /catalog?store=&range=1&from=&count=`, up to
  `CRAWLER_RANGE_IDS_PER_RUN` ids per run. See *Id-range backfill* below.
- **seed** (`CRAWLER_MODE=seed`) — an EXCLUSIVE pass that runs the seed phase and nothing else. See
  *Seed pass* below.
- `both` (default) runs recent for every store, THEN backfill, THEN the id-range walk. Stores run in parallel under one
  global request gate (concurrency, total budget over catalog GETs + ingest POSTs, spacing);
  pages within a store are sequential; the ledger is saved after every page.
- Per catalog page: `503 cooldown` → the store is skipped for this run (no state change);
  `422 unsupported` → error, that AXIS stopped (a config or coverage gap, not exhaustion — a
  `422` on the listing axis still leaves the id-range walk to run); any other non-2xx or a
  malformed body → error, store stopped, cursor untouched.
- Every store runs under an enqueue ceiling: its `CRAWLER_STORE_ENQUEUE_CAPS` entry when it has
  one, else the global `CRAWLER_MAX_ENQUEUE_PER_STORE`. The ceiling is reported per store as
  `capApplied`, and the overrides that actually applied are listed on the run summary as
  `enqueueCapOverrides`. An explicit per-store cap of `0` pulls that store OUT of the run (no
  requests, its ledger is not even opened) — the lever for a store that has to rest, such as a
  Cloudflare-gated one that stalls above ~15 items/hour. A GLOBAL `0` keeps its other meaning:
  a discovery-only dry run for every unnamed store (pages fetched, nothing POSTed).
- The run ends with a `[CRAWLER] pass complete` JSON summary (per store: pagesFetched,
  discovered, known, enqueued, deduplicated, reobserved, errors, skipped, backfillCursor,
  exhaustCandidate, exhausted, capApplied, rangeWalked, rangeCursor, rangeFrontier, rangeSkipped,
  seedLists, seedStopped; plus totals, requestsIssued, budgetExhausted, enqueueCapOverrides,
  totalRangeWalked, durationMs). A `seed` pass logs `[CRAWLER] seed pass complete` instead.
- A `CRAWLER_STORE_ENQUEUE_CAPS` entry or a `CRAWLER_RANGE_STORES` entry naming a store that is not
  in `CRAWLER_STORES` does nothing, and is WARNed about by siteId at the start of the run — a range
  store must be named in BOTH.

| Variable | Default | Meaning |
|---|---|---|
| `SCRAPER_SERVICE_URL` | `http://localhost:3050` | The scraper's HTTP surface (the only thing the crawler talks to) |
| `CRAWLER_MODE` | `both` | `recent`, `backfill`, `both` (recent then backfill), or `seed` (the declared seed lists ONLY) |
| `CRAWLER_STORES` | `orzgk` | csv of siteIds; explicitly empty = no work (kill switch) |
| `CRAWLER_LEDGER_DIR` | `/var/lib/ingest-crawler` | Directory of per-store ledger files |
| `CRAWLER_RECENT_MAX_PAGES` | `3` | Max listing pages walked from page 1 per store per run |
| `CRAWLER_BACKFILL_PAGES_PER_RUN` | `5` | Max pages the backfill cursor advances per store per run |
| `CRAWLER_MAX_REQUESTS` | `100` | Global request budget (catalog GETs + ingest POSTs); `0` = kill switch |
| `CRAWLER_MAX_ENQUEUE_PER_STORE` | `50` | Max ingest POSTs per store per run; `0` = discovery-only dry run |
| `CRAWLER_STORE_ENQUEUE_CAPS` | *(none)* | csv of `siteId:cap` overriding the global cap for those stores (`anitoys:15,mfc:30`); an explicit `0` pulls the store out of the run. A malformed entry is ignored with a WARN naming it; the rest still apply |
| `CRAWLER_MAX_CONCURRENCY` | `2` | Global max in-flight requests across all stores |
| `CRAWLER_SEED_SPACING_MS` | `10000` | `seed` mode: min wait between ONE store's consecutive seed fetches (independent of the global spacing); `0` disables |
| `CRAWLER_REQUEST_SPACING_MS` | `1000` | Minimum spacing between consecutive dispatches |
| `CRAWLER_REQUEST_TIMEOUT_MS` | `45000` | Per-request abort timeout (keep above the engine's `CATALOG_STORE_TIMEOUT_MS`) |
| `CRAWLER_REOBSERVE_AFTER_MS` | `604800000` (7d) | Recent only: re-POST a known item once its entry is this old; `0` = never |
| `CRAWLER_EXHAUSTED_RECHECK_MS` | `604800000` (7d) | Re-check an exhausted store's last cursor after this long |
| `CRAWLER_RANGE_STORES` | *(none)* | csv of siteIds that walk their sequential id space; empty = no id-range walking at all |
| `CRAWLER_RANGE_IDS_PER_RUN` | `50` | Max ids walked per store per run (the window asked of `/catalog?range=1`); clamped to the engine's `200`-id ceiling with a WARN |
| `CRAWLER_RANGE_FRONTIER_<SITEID>` | *(none)* | Seed frontier for a store whose ledger has no numeric itemId yet; CHANGING it later re-seeds the walk from the new top. `<SITEID>` = the siteId uppercased with every non-alphanumeric character replaced by `_` |

**Ledger** — one file per store, `<CRAWLER_LEDGER_DIR>/<siteId>.json`, written as
`<siteId>.json.tmp-<pid>` and renamed into place (a crash never leaves a torn file):

```json
{
  "version": 1,
  "siteId": "orzgk",
  "enqueued": { "<itemId>": { "at": "2026-09-06T12:00:00.000Z", "collectUrl": "https://..." } },
  "backfill": {
    "cursor": 12,
    "exhaustCandidateCursor": 12, "exhaustCandidateAt": "...",
    "exhaustedAt": "...",
    "updatedAt": "..."
  },
  "recent": { "lastRunAt": "...", "lastNewCount": 3 },
  "range": { "cursor": 3629950, "frontier": 3630000, "seed": 3630000, "updatedAt": "..." },
  "updatedAt": "..."
}
```

`range` is OPTIONAL: a ledger written before the axis existed, or for a store that never walks one,
simply has no `range` and is neither corrupt nor migrated (the file stays `version: 1`). A `range`
that IS present must be well formed — a malformed cursor or frontier is **corrupt**, never a silent
reset that would re-walk the whole id space nor a non-number reported as one.

A missing file is a fresh ledger. Unparseable JSON, a wrong `version`, a wrong `siteId`, or a
malformed section is **corrupt**: the store is refused for the run (counted as an error) and the
file is never overwritten — inspect or delete it by hand.

**Exhaustion rule** — end-of-catalog is confirmed, never inferred from one page. The engine's
upstream fetch is status-blind (a Shopify page-cap `400` or a transient `5xx` parses as an empty
listing), so a page with `hasMore: false` or zero items only records an exhaustion *candidate*
at that cursor (`exhaustCandidateCursor`/`exhaustCandidateAt`) and ends the run without
advancing. Only when the NEXT run sees the SAME cursor empty again is the store marked
`exhaustedAt` (the cursor is kept); items reappearing clear the candidate. A last page that was
CUT SHORT (per-store cap, global budget, or a 5xx from `/ingest/scrape`) is neither a candidate
nor a confirmation: its unattempted items say nothing about the end of the catalog, so the
accepted marks are saved, the cursor and any existing candidate/exhausted marks are left as they
were, and the same page is re-fetched next run. An exhausted store makes no backfill requests
until `CRAWLER_EXHAUSTED_RECHECK_MS` has elapsed, then re-checks its last cursor: still empty
re-stamps `exhaustedAt`, items resume the backfill (a re-check cut short keeps the stale
`exhaustedAt`, so the store stays due and drains a cap's worth per run until fully seen).

**Id-range backfill** — a store whose ids are sequential (`retrieval.byRange` + `byId`) can be
collected continuously without any listing at all: the id space *is* the listing. Only the stores
named in `CRAWLER_RANGE_STORES` walk it, so the crawler never spends a request discovering that a
store has no such axis; the walk runs LAST (after every store's recent and listing-backfill passes),
because the newest ids always outrank the deep id space for the run's budget.

- **Frontier** — the highest itemId in the store's ledger that reads as a positive integer, else the
  operator's `CRAWLER_RANGE_FRONTIER_<SITEID>` seed. With neither, the walk is skipped with a WARN
  (it is never started from a guess). The seed in force is recorded in the ledger as `range.seed`.
- **Re-seeding** — the walk only ever descends, so ids minted ABOVE the frontier (and a seed set too
  high or too low) are not something the walk corrects on its own. CHANGING
  `CRAWLER_RANGE_FRONTIER_<SITEID>` restarts the walk from the new top, with a WARN: it is the
  operator's lever, and it needs no PVC surgery. Ids already in the ledger are skipped without a POST,
  so re-entering a band already walked costs windows, not fetches. On a store that HAS a listing axis,
  new ids arrive through the recent phase and the frontier need never move.
- **Window** — one `GET /catalog?store=&range=1&from=<cursor>&count=<CRAWLER_RANGE_IDS_PER_RUN>` per
  store per run. The engine synthesizes the `{ itemId, collectUrl }` pairs from the store's `byId`
  template, so every id flows through exactly the same ledger dedup, enqueue cap and global request
  budget as a listing item — the ledger semantics are untouched, only the source of the ids differs.
  Ids already in the ledger are skipped without a POST but still consume the walk, so they are never
  looked at twice. The window must BE the descending run that was asked for (`from`, `from-1`, …); a
  SHORTER one is fine (the engine clamps at 200 ids, and the walk bottoms out at id 1), but a
  reordered, gapped or short-of-the-top one is refused as a malformed body — counted as an error,
  nothing POSTed, cursor untouched — because the cursor moves by position within the window.
- **Cursor** — `range.cursor` in the ledger is the next id to walk, and it moves DOWN only by the
  number of ids actually HANDLED (POSTed, skipped as known, or deterministically 4xx-rejected). An id
  the per-store cap, the global budget or a 5xx from `/ingest/scrape` cut off is left above the
  cursor and picked up next run: nothing is stranded, and nothing is ever re-walked. The walk ends at
  id 1, leaving `cursor: 0`; further runs make no request. A window `/ingest/scrape` rejected
  ENTIRELY (4xx for every id — typically no ruleset matches the store's `byId` url, an engine/ruleset
  skew) leaves the cursor exactly where it was, with a WARN: that band would otherwise be spent
  collecting nothing and is never walked again.
- **Durability** — the listing phases save the ledger after every page; the id-range walk saves once
  per WINDOW (its ids are one bounded batch). A pod killed mid-window (`activeDeadlineSeconds`, OOM,
  eviction) therefore re-walks that window on the next run: the POSTs it already made are coalesced
  by the ingest queue's own dedup, and no id is lost or skipped.
- **Misses** — an id in the window that does not exist at the store is EXPECTED and is not an error
  here: `/catalog?range=1` never probes it, so the gap surfaces downstream as the ingest fetch's own
  404, recorded in the ingest lane. The crawler counts `rangeWalked` (ids walked), not hits.
- A `422` on the LISTING axis (`no byListing` — mfc today) stops the listing walk only; the id-range
  walk still runs. A cooldown, an exhausted budget, a sick scraper or a ledger failure stops every
  axis, because they are properties of the host or the run, not of one axis.
- **Budget** — the walk runs LAST and shares both the store's enqueue cap and the global
  `CRAWLER_MAX_REQUESTS`, so a store whose listing already spent its cap, or a run whose budget is
  already gone, does not walk at all. Size them for it: `CRAWLER_MAX_REQUESTS` must cover the listing
  phases plus, per range store, one window GET and up to `CRAWLER_RANGE_IDS_PER_RUN` POSTs, and the
  store's cap must have that much headroom left. When it does not, `rangeSkipped` on the store
  summary says which — `cap`, `budget`, `no-frontier`, `floor`, `cooldown`, `unsupported`, `failed`,
  `window-malformed`, `store-stopped`, `not-run`, `not-configured` — and it is `null` on a run that
  actually asked for a window. The window GET itself is synthesized (no upstream fetch) but is still
  charged one slot of the global budget and one spacing interval.
- **Throughput** — one window per run, at most `CRAWLER_RANGE_IDS_PER_RUN` (ceiling 200) ids. On an
  hourly CronJob that is at most 4,800 ids/day, so an id space the size of mfc's ~3.6M takes ~756
  days to walk once at the ceiling — and ~8 years at the `50`/run default. Size the knobs (and the
  expectations) accordingly: this axis is a slow continuous backfill, not a bulk import.

**Seed pass** (`CRAWLER_MODE=seed`) — a slow, bounded poll of the pages a store DECLARES, and the
only phase that runs in this mode.

- **What it does** — for each store in `CRAWLER_STORES`: one `GET /catalog?store=&seeds=1` to learn
  which seed lists the store declares, then one `GET /catalog?store=&seed=<listId>` per declared
  list, in DECLARED order, enqueuing the ids the ledger has never seen. No cursor, no paging, no id
  space: a seed list is one whole page by construction.
- **Why it is worth a pass of its own** — the cost is knowable before it runs. A store's declared
  set is finite, so one seed pass is `1 + <declared lists>` catalog GETs plus at most the store's
  enqueue cap in ingest POSTs. That is what makes it defensible against a store whose catalogue must
  not be walked, and it is exactly the property that would be lost by folding the phase into an
  unbounded walk — which is why `seed` is EXCLUSIVE. A `seed` pass runs no recent, backfill or
  id-range phase, and those modes run no seed phase.
- **Same machinery** — the same durable ledger for dedup (a shelf shows the same items for weeks;
  the ledger is what stops the poll from re-POSTing them), the same per-store enqueue cap, the same
  global `CRAWLER_MAX_REQUESTS`, and the same request gate for `CRAWLER_REQUEST_SPACING_MS` and
  concurrency.
- **The engine applies NO per-host floor on this lane** — and none on the listing lane either. A
  store's declared `rateLimit` (`baseDelayMs` and friends) governs the INGEST/record queue's
  dispatch, not a `/catalog` or `/lookup` fetch: those ride the plain body-returning transports with
  a timeout and the challenge cooldown, and nothing else. The crawler's own knobs are therefore the
  ONLY pacing the seed axis has, which is why it carries a floor of its own.
- **Per-store seed floor** — `CRAWLER_SEED_SPACING_MS` (default `10000`) is the minimum wait between
  one store's consecutive seed fetches, applied by the crawler and INDEPENDENT of the global
  `CRAWLER_REQUEST_SPACING_MS` (which spaces every dispatch across every store and axis). It is not
  applied before a store's first list, there being nothing yet to space from. `0` disables it. This
  is the operational floor for the axis: set it to what polling that store looks defensible at, and
  remember that the store's declared cadence is `weekly` or `daily`, never per-run.
- **Never re-observes** — a known id is skipped however old its ledger entry is, whatever
  `CRAWLER_REOBSERVE_AFTER_MS` says. Re-observation belongs to the recent phase; here it would turn a
  bounded poll into a periodic re-collection of a whole shelf.
- **One list once** — a list id repeated in a declaration is polled once, and so is a repeated URL:
  two ids resolving to the same page cost ONE fetch, the losing ids are credited on the polled list's
  stats as `alsoDeclaredAs`, and the authoring slip is WARNed by siteId. The ledger is saved after
  EVERY list, so a pass killed between two lists never re-POSTs what the first one enqueued.
- **Cap-aware** — once the store's enqueue ceiling is spent, the remaining lists are NOT fetched
  (`seedStopped: "cap"`). On an axis justified by a knowable cost, a fetch guaranteed to enqueue
  nothing is exactly the request not to make.
- **Stop on the first refusal** — a challenge, a cooldown or any 4xx on a list STOPS that store for
  the run and the remaining lists are left alone; `seedStopped` on the store summary says why
  (`cooldown`, `unsupported`, `failed`, `budget`, `cap`). Pushing on to the next list after a
  challenge is precisely what burns the egress IP's reputation for every other store sharing it. The
  reason is the REAL one: a `/ingest/scrape` 5xx or a thrown POST reports `failed`, and only a
  genuinely spent `CRAWLER_MAX_REQUESTS` reports `budget`.
- **KNOWN LIMIT: the seed lane is status-blind.** Like the listing lane, it rides the
  string-returning search transports, so the engine sees a body and never an HTTP status or a
  post-redirect final url. A store answering `404`, a page-cap `400` or a transient `5xx` with a body
  the ruleset parses to zero items is therefore indistinguishable here from a list that genuinely has
  nothing new — it reports as a clean, empty poll. (Cloudflare challenge bodies ARE detected and do
  stop the store; that check is on the body, not the status.) The record/ingest lane no longer has
  this blind spot, but giving it to the catalog lane would mean widening the injected `fetchSearch`
  seam to carry `{status, finalUrl}` on all three transports — a change to the shared lookup/catalog
  wiring, not to this axis — so it is recorded here rather than worked around. On a WEEKLY or DAILY
  cadence a silently empty list is a silence worth checking for by hand: watch `seedLists[].discovered`
  going to zero for a list that used to yield.
- **Reporting** — `seedLists` on the store summary carries `{ listId, discovered, known, enqueued }`
  per list, in the order they were polled: the numbers an operator reads to decide whether a list
  still earns its cadence. It is empty in every other mode.

## Testing

The scraper includes comprehensive test coverage with 26 test suites and containerized test execution.

### Test Coverage Overview

- **Total Test Suites**: 26 suites
- **Total Tests**: ~760 passing tests
- **Code Coverage**: 80%+ (Codecov quality gate)
- **Testing Framework**: Jest 30 + TypeScript + Supertest 7 + testcontainers
- **Mocking Strategy**: Complete Puppeteer API mocking
- **Containerized Testing**: Docker-based test execution with coverage extraction

### Test Structure

```
src/__tests__/
├── unit/
│   ├── browserPool.test.ts                    # Browser pool management
│   ├── cacheConfig.test.ts                    # Cache TTL calculation
│   ├── cacheConfigExtended.test.ts            # Extended cache scenarios
│   ├── companyArtistExtraction.test.ts        # Company/artist extraction
│   ├── companyArtistExtractorExtended.test.ts # Extended extraction scenarios
│   ├── fieldAuditCollector.test.ts            # Field completeness auditing
│   ├── genericScraperExtended.test.ts         # Extended scraper scenarios
│   ├── mfcCookieRetry.test.ts                 # MFC cookie retry logic
│   ├── mfcCsvExporter.test.ts                 # CSV export logic
│   ├── mfcLabelRegistry.test.ts               # Label pattern matching
│   ├── mfcListsFetcher.test.ts                # MFC list fetching
│   ├── performance.test.ts                    # Performance benchmarks
│   ├── releaseExtraction.test.ts              # Release date/price extraction
│   ├── releaseExtractorExtended.test.ts       # Extended release extraction
│   ├── scrapeQueue.test.ts                    # Priority queue logic
│   ├── scrapeQueueExtended.test.ts            # Extended queue scenarios
│   ├── scrapeQueueProcessing.test.ts          # Queue processing logic
│   ├── security.test.ts                       # Security and auth tests
│   ├── sessionManager.test.ts                 # Session management
│   ├── stringComparison.test.ts               # String comparison utilities
│   ├── syncOrchestrator.test.ts               # Sync workflow orchestration
│   ├── syncOrchestratorExtended.test.ts       # Extended sync scenarios
│   ├── syncRoutes.test.ts                     # Sync route handlers
│   └── webhookClient.test.ts                  # HMAC webhook callbacks
├── integration/
│   ├── scraperRoutes.test.ts                  # Scraper API endpoint tests
│   ├── syncRoutes.test.ts                     # Sync API endpoint tests
│   ├── setup.ts                               # Test environment setup
│   └── inter-service/
│       └── backendCommunication.test.ts       # Cross-service communication
```

### Running Tests

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Run in watch mode (development)
npm run test:watch

# Run CI tests (no watch)
npm run test:ci

# Run containerized tests with coverage extraction
./test-container-coverage.sh

# Run specific test suite
npx jest src/__tests__/unit/scrapeQueue.test.ts

# Run tests matching pattern
npx jest --testNamePattern="sync orchestrator"
```

### Test Configuration

**TypeScript Test Configuration (`tsconfig.test.json`):**
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "strict": false,
    "noImplicitAny": false,
    "strictNullChecks": false,
    "skipLibCheck": true,
    "types": ["jest", "node"]
  },
  "include": [
    "src/**/__tests__/**/*",
    "src/**/__mocks__/**/*"
  ]
}
```

**Jest Configuration (`jest.config.js`):**
```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/__mocks__/',
    '/__tests__/fixtures/',
    '/__tests__/setup.ts'
  ],
  transform: {
    '^.+\.ts$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.test.json',
      diagnostics: { warnOnly: true }
    }]
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  testTimeout: 30000,
  maxWorkers: 4,

  moduleNameMapper: {
    '^puppeteer$': '<rootDir>/src/__tests__/__mocks__/puppeteer.ts'
  },

  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  bail: false,
  verbose: true
};
```

### Performance Benchmarks

**Target Metrics:**
- Response Time: 3-5 seconds per scraping operation
- Concurrent Capacity: 10+ simultaneous requests
- Browser Pool Efficiency: <1 second pool operations
- Memory Management: Proper cleanup after each operation

### Containerized Testing

The service includes a containerized testing script that runs all tests in a Docker environment:

```bash
# Run tests in isolated Docker container
./test-container-coverage.sh
```

**Features:**
- Isolated test environment with all dependencies
- Automated coverage report extraction
- Cross-platform compatibility
- Automatic browser opening of coverage reports (when available)
- Test results exported to `./test-results/` directory

**Output:**
- Coverage reports: `./test-results/coverage/lcov-report/index.html`
- Test results: `./test-results/reports/`

### CI/CD Integration

```bash
# CI test command
NODE_ENV=test npm run test:ci

# Coverage reporting for CI
NODE_ENV=test npm run test:coverage

# Containerized testing (isolates dependencies)
./test-container-coverage.sh
```

### CI on forks (shift-left)

Development happens on personal forks; pull requests go to `FigureCollecting/*`.
CI on a fork follows one rule. The push gate (its four cases are documented in
a comment block) sits at the top of `build.yml`, `security-scan.yml` and
`codeql.yml`; the publishing workflows (`docker-publish.yml`,
`publish-plugin-contract.yml`, `release.yml`, `sbom-security-scan.yml`,
`scheduled-security-scan.yml`) carry an org-only gate.

- **Feature branches on your fork run the core CI on every push**: unit tests +
  build, dependency/container/npm-audit scans (the container scan builds the
  production image) and CodeQL, so problems surface before the PR is opened.
  `docker-publish.yml` does not run there (it only publishes), and Dependabot
  branches (`dependabot/**`) get their CI from their pull request instead.
- **Set a fork secret `NODE_AUTH_TOKEN`** (repo Settings > Secrets and variables >
  Actions) to a classic GitHub PAT with **only** the `read:packages` scope, so
  `npm ci` can read the private `@figurecollecting/*` packages. Without it the
  install falls back to the fork's `GITHUB_TOKEN` and fails with `npm error 403`.
  Upstream needs no such secret. The secret reaches your own pushes and PRs from
  branches of your fork, never a PR opened from someone else's fork.
- **`develop` and `main` on your fork are mirrors of upstream: pushes to them
  run no jobs.** The workflows still trigger, so each sync leaves grey
  `skipped` runs in the Actions tab; that is the gate working, not a failure.
  Manual `workflow_dispatch` runs (`security-scan.yml`; `docker-publish.yml`, which
  then builds with `push: false`) are not gated and still run there, and so do
  scheduled runs if you enable schedules on the fork.
  The gate compares branch names case-insensitively, so do not name a feature
  branch `Develop` or `MAIN`.
- **Publishing (GHCR images, the npm plugin-contract package, GitHub releases,
  image SBOM/attestations) and Codecov uploads happen only from the org**; those
  jobs and steps are skipped on forks.

### Testing Documentation

See `TESTING.md` for comprehensive testing documentation including:
- Complete test strategy and methodology
- Detailed coverage breakdown
- Performance benchmarking
- Mock data and fixtures
- Maintenance guidelines

## Development

### Environment Setup

**Configuration Files:**
- `.env.example` - Template showing all environment variables
- `.env` - Your local configuration (gitignored, never commit this!)

**Quick Start:**
```bash
# Copy example (optional - defaults work for most cases)
cp .env.example .env

# Scraper typically works with defaults - no secrets required!
```

See `.env.example` for all configuration options including:
- Server port configuration
- Puppeteer Chrome path (for CI/CD)
- Admin token (for /reset-pool endpoint)
- Debug logging settings

### Local Development

```bash
# Install dependencies
npm install

# Start development server (uses tsx for fast startup)
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run tests in development
npm run test:watch
```

### Build Output

The build process generates JavaScript files and source maps:
- `routes/` - Compiled route handlers
- `services/` - Compiled service modules
- `index.js` - Main application entry point
- Source maps (`.js.map`) for debugging compiled code

### Testing in Development

```bash
# Watch mode for continuous testing
npm run test:watch

# Test specific functionality
npx jest browserPool --watch

# Performance testing
npx jest performance.test.ts
```

## Deployment

### Docker

The service uses a multi-stage Dockerfile with Ubuntu 24.04 base and Chrome for Testing 146:

```bash
# Development (with hot reload, port 3080)
docker build --target development -t scraper:dev .
docker run -p 3080:3080 -e PORT=3080 --shm-size=2gb scraper:dev

# Test environment (port 3070)
docker build --target test -t scraper:test .
docker run -p 3070:3070 -e PORT=3070 --shm-size=2gb scraper:test

# Production (default, port 3050)
docker build -t scraper:prod .
docker run -p 3050:3050 -e PORT=3050 --shm-size=2gb scraper:prod
```

**Available stages:**
- `base`: Ubuntu 24.04 with Chrome for Testing 146 and Puppeteer dependencies
- `development`: Includes devDependencies and tsx for hot reload
- `test`: Test environment for CI/CD
- `builder`: Compiles TypeScript to JavaScript
- `production`: Optimized image with production dependencies only (default)

**Note**: `--shm-size=2gb` is required for Puppeteer to avoid memory issues with Chrome.

### Environment Variables

See `.env.example` for complete configuration template.

**Required:**
- `PORT`: Server port (prod: 3050, local dev: 3080, test: 3070, Coolify dev: 3090)
- `NODE_ENV`: Environment mode (development, test, production)

**Required in Docker/Production:**
- `BACKEND_URL`: Backend service URL for webhook callbacks during MFC sync
  - Docker prod: `http://backend:5050`
  - Docker Coolify dev: `http://backend:5090`
  - Local dev: `http://localhost:5080`
  - (Must be reachable from the scraper container; used by the webhook client to send sync progress to backend)

**Optional:**
- `PUPPETEER_EXECUTABLE_PATH`: Custom Chrome/Chromium executable path
  - Useful for CI/CD environments or custom browser installations
  - Example: `/usr/bin/chromium-browser`
- `ADMIN_TOKEN`: Authentication token for admin endpoints
  - Required for `/reset-pool` endpoint in non-production environments
  - Simple string token for basic protection
- `PLUGIN_DIR`: Directory scanned for ruleset plugin packages at boot
  - Default: the service's own `node_modules`
  - Use when plugins are injected at runtime (e.g. a mounted volume in a container) instead of being installed as dependencies
  - Example: `/plugins/node_modules`
  - An explicit `nodeModulesDir` option passed to the plugin bootstrap takes precedence
- `INGEST_BASE_URL`: Base URL of the fc-aggregation SpineIngest gRPC server (h2c/HTTP2)
  - Example: `http://fc-aggregation:50051`
  - When set AND a plugin ruleset matches an item's URL, the scrape queue takes the new ingest path: raw page fetch → plugin extraction → gRPC emit to the aggregation spine (no webhook leg on that path)
  - Unset (default): the new path is disabled and every item uses the legacy scrape+webhook path
- `INGEST_TIMEOUT_MS`: Per-call deadline in milliseconds for spine ingest RPCs
  - Default: `30000`
- `IMPIT_TIMEOUT_MS`: Per-request timeout (ms) for the impit browser-TLS transport
  - Applies to each impit GET independently — a session-gated store's homepage prime and the target fetch each get the full budget
  - Raise for slow session-gated stores (e.g. Ueeshop) whose prime/search can take 15–30 s
  - Unset/invalid → default; any value is clamped to `[5000, 120000]`
  - Default: `30000`
- `HTTP_FETCH_TIMEOUT_MS`: Abort ceiling (ms) for the plain-HTTP (`http`) transport — one signal bounds headers AND body
  - Serves the synchronous `/lookup`, `/catalog`, and `/resolve` callers as well as the ingest queue, so it stays tight by default
  - Raise for large listings (the orzgk 100-item catalog page takes ~15 s; ops set `30000`)
  - Unset/invalid → default; any value is clamped to `[5000, 120000]`
  - Default: `15000`
- `CHALLENGE_COOLDOWN_MS`: Per-host cooldown window (ms) after a store serves a Cloudflare challenge/block
  - While a host is cooling, the scrape queue and lookup fan-out skip it without fetching, so repeat challenges don't degrade the egress IP's CF reputation
  - Unset/invalid → default; any finite value is clamped to `[60000 (1 min), 86400000 (24 h)]`
  - Default: `1800000` (30 min)
- `CF_COOKIE_FILE`: Path to the stored-cookie file (hand-minted Cloudflare clearance / session cookies, keyed by host) — see **Stored Cloudflare cookies** below
  - Unset/blank (default): the jar is disabled and every lane behaves exactly as before
  - Example: `/var/run/fc/cf-cookies/cf-cookies.json` (a Secret mounted as a directory, so a refresh changes the file's mtime)
- `RESIDENTIAL_PROXY_URL`: Proxy for stores that declare `searchFetch.egress: 'residential'` (contract 0.7.0) — see **Residential egress** below
  - Accepts `socks5://host:port` (or `socks5h://`, which is folded to `socks5://` — Chromium's socks5 already resolves DNS at the proxy) and `http(s)://host:port`, with **no embedded credentials**
  - Credentialed and `socks4://` URLs are REJECTED, not stripped: Chromium's `--proxy-server` cannot carry credentials and rejects `socks5h://` outright (`net::ERR_NO_SUPPORTED_PROXIES`), so a value only impit could use would leave the browser lane dead for the same cohort. One accepted shape, every lane
  - Example: `socks5://egress-proxy.fc.svc.cluster.local:1055` (the in-cluster userspace Tailscale proxy whose exit node is a residential line)
  - Unset/invalid → no residential egress: the value is ignored with ONE boot warning naming the reason (never the value — it may carry credentials), and every residential store's fetch is REFUSED rather than sent from the node IP
  - Default: unset (no store is proxied; every other store is unaffected)

- `RESIDENTIAL_EGRESS_HEALTH_DETAIL`: `true` adds the proxy's `scheme://host:port` to `GET /health/detailed`'s `residentialEgress` block
  - `/health/detailed` is unauthenticated, so the endpoint's address is opt-in; `configured` (always present) is what an operator needs to see
  - Default: unset (only `{ configured }` is published)

- `BROWSER_LAUNCH_MODE`: `clean-headful` selects the proven Cloudflare-passing launch profile (real Chrome, headful on the Ozone headless platform, no automation switch, minimal flags) — see **The browser lane** below
  - Unset or any other value → the historical headless profile (what CI and the tests use)
  - Default: unset
- `TZ`: the CONTAINER's timezone, and the one that decides whether a Cloudflare-gated store clears at all
  - The challenge's cross-origin frame reads the browser PROCESS's zone, so a UTC container never clears — silently, with no error (measured 2026-09-07; `page.emulateTimezone` cannot substitute for it)
  - Set it to a real named zone, ideally the egress IP's: the deployment uses `America/Chicago` (the residential exit's)
  - Default: unset, which in a container means UTC — gated stores will not pass
- `RESIDENTIAL_EGRESS_TIMEZONE` / `DIRECT_EGRESS_TIMEZONE`: OPTIONAL IANA timezone each egress emulates per page on top of `TZ` (`page.emulateTimezone`), so a page's own reported zone matches the exit it leaves through
  - These do NOT clear a challenge — only `TZ` does. They are post-challenge cosmetics, and the deployment leaves them EMPTY
  - Unset → emulate nothing (the page keeps the process zone)
  - Default: unset

- `CATALOG_STORE_TIMEOUT_MS`: Timeout (ms) for one `GET /catalog` listing-page fetch
  - A catalog page is far larger than a search hit (orzgk pages run 1.5–2 MB), so it gets its own window
  - Unset/invalid → default; any value is clamped to `[1000, 120000]`
  - Default: `30000`

- `IMAGE_HOST_POLICY_JSON`: Inline `{ host: rule }` table saying how each IMAGE host is fetched — see **Image bytes lanes** below
  - Unset/blank (default): the built-in table, which is the permaban alone
  - Unparseable or not an object → ONE warning, and `IMAGE_HOST_POLICY_FILE` is consulted instead (a malformed inline edit never stands in for the file an operator also mounted)
- `IMAGE_HOST_POLICY_FILE`: Path to a file holding that same table (consulted when `IMAGE_HOST_POLICY_JSON` is unset **or unusable**)
- `IMAGE_ACCEPT`: The `Accept` all three image lanes send (default `image/jpeg, image/png, image/gif, image/*;q=0.9, */*;q=0.8` — the ARCHIVAL header, which names no webp and no avif). Must be a plain header value; anything with CR/LF or outside printable ASCII is refused with one warning and the default stands — see **Image bytes lanes** below
- `IMAGE_MAX_PER_ITEM`: Images captured per item (default `12`, clamped to 100) — see **Image capture** below
- `IMAGE_MEMO_SIZE`: Urls the capture memo holds (default `50000`) — see **Image capture** below
- `IMAGE_RESIDENTIAL_BYTES_PER_DAY`: Rolling-24-hour byte ceiling on the residential exit for images (default `1073741824`; `0` closes it) — see **Image capture** below
- `IMAGE_FETCH_CONCURRENCY`: Image fetches open at once (default `6`, clamped to 32) — see **Image capture** below
- `IMAGE_INFLIGHT_MAX`: Items allowed to be waiting for the image lane before new requests are dropped (default `500`) — see **Image capture** below
  - Unreadable → ignored with ONE warning; the default table stands
  - Example: `/etc/fc/image-host-policy.json`. The table is read ONCE, when the policy is loaded — unlike the cf-cookie store there is no mtime poll, so **an edit needs a pod restart**

**Residential egress (`RESIDENTIAL_PROXY_URL`):**

A few Cloudflare-fronted stores gate on IP/ASN REPUTATION, not on browser fingerprint: the very same impit `chrome142` client that is challenged from the datacenter node gets a plain 200 from a residential IP, and their challenge-passage windows are far shorter than a hand-minted `cf_clearance` can survive. Those stores declare `searchFetch.egress: 'residential'` in their profile and the engine routes ONLY their fetches through the configured proxy; every other store keeps leaving through the node as before.

Per lane:

| Lane | Residential egress | How |
|---|---|---|
| `impersonate` (impit) | **Supported** | `proxyUrl` on the Impit instance (SOCKS5/HTTP; HTTP/3 stays off — impit cannot proxy with it on). The session cache is keyed by (profile, proxy), so a proxied session never shares its cookie jar with the direct one. |
| `browser` (puppeteer) | **Supported** | Two paths. An ungated store gets a per-request `createBrowserContext({ proxyServer })`, so one pooled browser serves proxied and direct stores side by side. A CHALLENGE-GATED store gets a tab in the dedicated browser for its egress, which was LAUNCHED with `--proxy-server` — a created context never clears the challenge (see **The browser lane**). Cookie injection is unchanged on both. |
| `http` (plain GET) | **Refused** | Node's global `fetch` has no proxy support, and undici's `ProxyAgent` speaks only HTTP(S), never the SOCKS proxy this deployment uses. A residential store on this lane raises the same typed refusal — put it on `impersonate`. |

The gate covers every door a STORE's own fetch goes through: both search dispatchers (`fetchSearch`, `capturingFetch`), `POST /resolve`'s primary detail fetch, and the `ExtractContext` seams a ruleset uses — `ctx.scraping.scrapePage` / `scrapePageStealth` / `fetchBody` — all resolve the store's declared egress the same way (proxy or refusal, never a direct fetch of a declared store).

On the BROWSER lane those doors resolve the WHOLE per-request wiring together, from one place (`resolveBrowserLaneOptions`): the challenge gate (`access: 'cloudflare'`), the session prime (`sessionPrime`), residential egress and `waitFor` readiness. That matters because the pieces are not independent — a gated store routed with its proxy but without its gate leaves through the right IP onto a per-request context, which never clears the challenge. The ingest raw fetch (`POST /ingest/scrape`) built its options from egress + readiness alone until 2026-09-07 and did exactly that: it logged a Cloudflare body for anitoysgk.com while `/health/detailed`'s `gatedBrowsers` stayed empty. It resolves the same options as every other door now.

Two paths deliberately sit OUTSIDE it, because neither has a declaring store to resolve: the legacy `POST /scrape` route (a caller-supplied URL and selectors, no store profile) and the raw `ScrapingService` a plugin receives through `PluginContext.services` (its contract type carries no egress). Both leave from the node IP. A store that needs residential egress must be reached through a dispatcher, not through those.

The proxy is scoped to the DECLARING store's own hosts (its domain and subdomains). A ruleset follow-up to some other host — an image CDN, a third-party API — is fetched directly rather than inheriting the residential exit: that exit is a home line, and handing its IP to a host that never declared it both exposes it and spends its reputation on unrelated traffic.

The refusal is deliberate and load-bearing: **a residential store is never silently fetched from the node IP.** With `RESIDENTIAL_PROXY_URL` unset (or unusable), the fetch raises `ResidentialEgressUnavailableError`, which the scrape queue classifies as `extraction_unavailable` — one attempt, no retry, no global rate-limit backoff, and never a cookie/auth session pause. Falling back would burn the datacenter path's remaining reputation and tell the store we tried.

**Image bytes lanes (`IMAGE_HOST_POLICY_JSON` / `IMAGE_HOST_POLICY_FILE`):**

Every transport described above returns a STRING — `res.text()`, impit's `.text()`, the rendered DOM. That is right for a document and destructive for an image: JPEG/PNG bytes decoded as utf-8 are gone. The image lanes are SIBLINGS of those transports, identical in egress rules and pacing, differing in that they hand back a `Buffer` and answer every expected outcome with a typed result (`{ ok: true, bytes, contentType, status, finalUrl, headers }`, or `{ ok: false, reason, bytesRead? }` where reason is `http-status` | `not-image` | `timeout` | `too-large` | `unsupported` | `refused`; `bytesRead` reports what actually crossed the wire before the refusal was decided, and is ABSENT — never zero — when nothing was read, so the residential byte budget charges a line only for traffic it really carried). Nothing on the page path changes. What decides to fetch an image at all, and hands the bytes to the raw store, is the **image capture hook** documented below.

| Lane | Used for | Residential egress |
|---|---|---|
| `http` | The default for a third-party CDN. Plain GET, archival `Accept`, abort-bounded | **Refused** — same rule and same wording as the string lane: Node's fetch cannot proxy. Refused on the DECLARED egress too, so a residential fetch whose proxy never resolved does not degrade into a direct one |
| `impit` | A CDN behind a TLS-fingerprint gate, and every residential image that is not on the browser lane. Seeds the host's stored cf cookies and lets the pinned mint UA win, as the string lane does | Supported (`proxyUrl` on the session; one session per profile+proxy). A fetch declared residential with no proxy is REFUSED |
| `browser` | A CDN behind the same Cloudflare gate as its store: a TAB of that store's gated browser, navigated at the image, read with the page lane's own document-only main-frame guard **and its challenge wait** (`domcontentloaded` fires on the interstitial, and leaving then cancels the challenge script). The gate itself comes from the store's declared `access: 'cloudflare'`, so an ungated store's images ride the ordinary ephemeral context | Supported (the gated browser for that egress) |

On the `impit` lane the body is read through a feature-detected binary capability (`bytes()`, else `arrayBuffer()`). An impit build exposing only `text()` returns `unsupported` and the body is left unread — a silently corrupted image is worse than a visible refusal.

**The `Accept` these lanes send is ARCHIVAL, and it is the single highest-impact setting in the image policy.** A browser's image `Accept` (`image/avif,image/webp,image/apng,…`) is a downgrade switch: eight of the nineteen image hosts in the 2026-09-08 lane matrix content-negotiate off it — Cloudflare Polish, Shopify, BigCommerce, hpoi and the rest — and on one of them it turned a 1 227 923-byte PNG master into a 111 240-byte webp at identical pixels. What comes back then is a DERIVATIVE the CDN re-encoded, and an archive of derivatives answers none of the questions the originals were kept for. So the default names the lossless/original families first and mentions neither webp nor avif:

```
image/jpeg, image/png, image/gif, image/*;q=0.9, */*;q=0.8
```

It is deliberately not `*/*`: a few hotlink guards check that an image request looks like one, and the trailing `image/*;q=0.9` still takes a webp-only host's bytes rather than refusing them. `IMAGE_ACCEPT` replaces it process-wide; a policy row's `accept` replaces it for one host and beats the env. On the browser lane the header is set on the IMAGE TAB alone (`setExtraHTTPHeaders` inside that navigation) — never on the gated browser's defaults, which would put an image `Accept` on every storefront document the same session fetches.

A negotiated response is RECORDED rather than refused: the asset's object metadata carries `declared-content-type` (what the server said) beside `content-encoding` and `vary` (present only when the server sent them), so an object that turned out to be a rendition says so.

**Which lane an image takes** is decided by the policy table first, then by the engine's existing suffix rule. An image on the DECLARING store's own hosts inherits that store's transport and egress; anything else has the declared egress DROPPED (the residential exit is a home line — it is not spent on a host that never declared it) and takes the plain lane. The table OVERRIDES both directions. Two pairings are refused outright rather than resolved, and neither is silently downgraded — a downgrade answers a misconfigured row with a different symptom somewhere else:

- **`lane: http` + `egress: residential`** (`http-lane-residential`) — Node's fetch cannot proxy, so that pairing has no transport at all.
- **`egress: residential` on a host that is NOT the declaring store's** (`off-store-residential`) — the exit is scoped to the declaring store's own hosts, and the final-url guard re-asserts that on whatever the bytes came from. Such a fetch would leave through the home line, download the body and then throw it away: every cost of the residential exit paid, nothing kept. This cannot be caught when the table is loaded, because whether a host is off-store is a fact about the page an image was found on, which no table knows — so it is refused at the decision, named, and logged once per host. Every other row still stands and the engine boots normally.

The table is `{ host: rule }`, matched by LONGEST host suffix (`cdn.example.com` beats `example.com`; a host that merely ends with the same string does not match — the dot is load-bearing). Keys are normalized (lowercased, leading `.` and `www.` stripped).

| Field | Values | Meaning |
|---|---|---|
| `lane` | `http` \| `impit` \| `browser` | Force the lane, overriding what the store declared |
| `egress` | `direct` \| `residential` | Force the egress, overriding the suffix rule in either direction |
| `referer` | `true` \| `false` | Send the declaring page as `Referer` (hotlink-protected CDNs need it). Default: `true` — hotlink guards live on third-party CDNs, so defaulting it off there is the one place it hurts |
| `accept` | a header value | The `Accept` to send THIS host instead of the archival default — for a CDN that needs the ask narrowed further, or widened for one that answers nothing else. Validated as a plain header value: a row carrying CR/LF is header injection, not a preference, and is dropped with a warning |
| `ua` | `chrome` \| `default` | User-agent profile, resolved to a header by `resolveImageUserAgent` (`chrome` = the desktop Chrome string, whose major tracks the engine's impersonation profile; `default` = whatever the lane already sends). Default: `chrome` on the impit/browser lanes, `default` on `http` |
| `deny` | `true` | Never fetch this host |

```json
{
  "cdn11.bigcommerce.com": { "lane": "http", "referer": true },
  "cdn.anitoysgk.com":     { "lane": "browser", "egress": "residential" },
  "images.example.test":   { "deny": true }
}
```

An unknown or wrongly-typed field is dropped with a warning and the rest of the rule stands — with two exceptions, both of which fail CLOSED: an entry that is not an object at all is SKIPPED entirely (so it cannot mask the valid parent rule its subtree would otherwise inherit), and a `deny` that is present but not a boolean reads as `deny: true`. Host keys are canonicalized, including the root-anchored trailing dot: `otakumode.com.` is the same host as `otakumode.com` and is denied identically. A URL whose scheme is not `http(s)` is refused outright. **otakumode.com and every host under it are permanently DENIED**, and that is answered before the table is consulted at all — no entry can re-enable it, not even one naming a subdomain (which would otherwise win the longest-suffix match).

**Pacing** is keyed on the IMAGE host, not the store's: a shared CDN (`cdn.shopify.com`, `cdn11.bigcommerce.com`) serves many of these stores, so it gets ONE budget that every store draws from, on the same `HostRateLimiter` the driver uses. The wait and the dispatch record are serialized per host, so N concurrent images off one PDP are spread across N budgets rather than arriving in one burst. What backs a host off is what actually signals a throttle: `429`/`503`, a timeout, and a 2xx body that is not an image (the shape of a managed challenge). A bare `403` does NOT — it is normally a per-URL hotlink or signed-URL verdict, and booking it on a shared CDN would spend every other store's budget on one store's misconfiguration; a `403` carrying `cf-mitigated` or `retry-after` does. A host with an open **challenge cooldown** is not fetched at all.

**Image capture (`PERSIST_RAW_IMAGES`, `IMAGE_MAX_PER_ITEM`, `IMAGE_MEMO_SIZE`, `IMAGE_RESIDENTIAL_BYTES_PER_DAY`):**

The hook runs after a successful extraction and BESIDE the emit, on the ingest queue, the crawl worker and the byId confirm alike. It is best-effort in the strict sense: the item's fate was already decided by the extraction and the emit, so a CDN that 403s, a lane that times out, a bucket that is unreachable and a ruleset whose `describeImages` throws are each **counted and logged at most once per host per hour** — and none of them can fail, delay or retry the item. It is not awaited.

Only what the STORE actually did reaches the fetch-failure ledger (as `kind: image`, targeting the image url): a status, a timeout, a transport fault. Outcomes that are OUR OWN decision are counted as skips and filed nowhere — `refused` (an image host inside a challenge cooldown, a redirect off the declaring store, a residential fetch whose proxy did not resolve) and `unsupported` (this build's lane cannot carry bytes, or no browser is available). A ledger full of our own policy is a triage queue nobody can act on, and it would misattribute our configuration to their site. `notImage` and `tooLarge` are likewise verdicts about a body rather than failures, so they are skips too.

**This first landing is capture-only: it writes no spine rows.** The bytes land in the content-addressed bucket with the provenance that says which item page referenced them and where in that page's list they sat (`source-item`, `source-url`, `position`, `role`); the rows that turn them into a queryable gallery are a later step. Separating them means the corpus can accumulate while that shape is still being decided, and nothing is lost if it changes — the objects are addressed by their content.

**The engine never learns a store's image fields.** The ruleset implements the contract's `describeImages(fields): ImageRef[]` (contract 0.10.0) and translates its own private field shapes into `{ url, role, position }`, where `role` is `gallery` | `thumbnail` | `user` | `other`. The engine applies ONE capture rule to the result:

| Role | Captured | Why |
|---|---|---|
| `gallery` | yes | a product plate the store published — the corpus worth keeping |
| `other` | yes | a store image that is none of the others (a box shot, a scale diagram); still the store's own |
| `thumbnail` | **no** | a downscaled derivative of a plate available at full size — storing it spends a fetch on a worse copy of something already held |
| `user` | **no** | a community upload: a rights question about someone else's photograph, which this lane declines rather than answers |

A ref's `url` may be relative (it is resolved against the page it was found on) and a ref whose role is outside that vocabulary is refused before the network. The decisions run cheapest-first, and the two that protect something outside the process — the permaban and the home line's daily budget — sit BEFORE any request:

0. **plan**, synchronously in the caller's own stack — the ruleset is asked and the capture rule applied before anything is queued, so a job waiting in the backlog holds a handful of urls rather than a whole extraction's `fields`. Past `IMAGE_INFLIGHT_MAX` waiting items the request is DROPPED here (`skipped.inFlight`) rather than queued
1. **role filter → dedupe by url → cap** at `IMAGE_MAX_PER_ITEM`, in the store's own presentation order (so the cap keeps the first plates, which are the ones that matter)
2. **memo** — a process-local LRU of url → content hash; a url already fetched and stored is skipped without a request. It also recognizes bytes arriving under a SECOND url (a store that versions its urls serves one file under many names), so those are deduped without a second write. A FAILED fetch is deliberately not memoized
3. **lane + policy**, deny list first (see *Image bytes lanes* above)
4. **residential budget** — a rolling 24-hour ceiling on bytes carried by the residential exit
5. **fetch**, under a global `IMAGE_FETCH_CONCURRENCY` gate and paced per image host, with the deny list and the on-store rule re-asserted on the url the bytes actually came from (a redirect can land somewhere the decision did not allow)
6. **classify → content dedupe → sink** (`lane: 'asset'`)

| Variable | Default | Meaning |
|---|---|---|
| `PERSIST_RAW_IMAGES` | off | The kill switch, shared with the sink's asset lane. Not `true` ⇒ the hook is inert and nothing is fetched. **It is only half the configuration**: with the switch on but the `RAW_STORE_S3_*` variables incomplete the sink loader returns a `NoopCaptureSink`, so capture would fetch every image of every item — at real cost to the store and to our egress reputation — and then drop the bytes. The lane therefore requires a REAL sink too, and stays off with one warning naming the missing half. `/health/detailed` carries that as `imageCapture.reason` |
| `IMAGE_MAX_PER_ITEM` | `12` | Images captured per item, all roles counted after filtering. Clamped to 100: this multiplies against every item of every store, so a mistyped extra zero would turn a gallery walk into an undecided crawl |
| `IMAGE_MEMO_SIZE` | `50000` | Urls the memo holds. Process-local and purely an optimization — a restart re-fetches a little and the content-addressed store dedups it |
| `IMAGE_FETCH_CONCURRENCY` | `6` | Image fetches open at once, across every item and every host. Capture is fire-and-forget precisely so an item never waits on a CDN, which means nothing upstream applies backpressure — 200 concurrent items would otherwise open 200 fetches, and per-host pacing does not bound that (its budget is per CDN, and a catalogue sweep spans many). Clamped to 32 |
| `IMAGE_INFLIGHT_MAX` | `500` | Items allowed to be WAITING for the lane before new requests are dropped. The concurrency bound limits open sockets; the backlog behind it would still grow one job per item for as long as ingest outruns the lane. A drop is counted as `skipped.inFlight` and is not a loss — the item's outcome is already decided, the plates are still there next pass, and the memo means the pass that catches them pays once |
| `IMAGE_RESIDENTIAL_BYTES_PER_DAY` | `1073741824` (1 GiB) | Rolling-24-hour byte ceiling on the residential exit. The ceiling is on the LINE, not on any one store, because the line is somebody's house. `0` closes it to images entirely. A rolling window rather than a calendar day, so a run starting at 23:50 cannot spend the allowance twice in ten minutes. Checked before a fetch and booked after it, so the day's last image may overshoot by one body. **Rejected bodies are booked too** (`bytesRead` on a failed result): a hotlink interstitial, a challenge page, an oversized file and a redirect off the declaring store were each downloaded in full before anything could tell, and a store answering every image with a block page would otherwise run all day against a counter reading zero |

The counters are published on `GET /health/detailed` as `imageCapture`.

Every lane refuses a body past a size cap (32 MB), re-checks the deny list against the URL the bytes actually came from (all three follow redirects), and rejects `image/svg+xml` — an `image/*` type whose body is active content. The gated browser lane holds at most one image tab per store host, so a burst of images can never take both of that store's page-lane tab slots; curry it through `asImageBytesFetcher` to pace it like the other two.

**The browser lane (launch profile, timezone, gated browsers):**

The lane's anti-detection strategy is the launch profile itself. There is **no stealth plugin** — `puppeteer-extra` and `puppeteer-extra-plugin-stealth` were removed on 2026-09-07 because they do not work here: measured against the gated cohort (anitoysgk.com, hobby-genki.com, sugotoys.com.au), the stealth plugin on an older Chrome FAILS the non-interactive JS challenge that a plain, current Chrome passes.

What passes, with no human, no clicking and no solver:

| Ingredient | Why |
|---|---|
| `BROWSER_LAUNCH_MODE=clean-headful` → `headless: false` | `headless: true` fails with any user agent |
| `--ozone-platform=headless` | renders headful with no X server and no Xvfb — the pod needs no display |
| `ignoreDefaultArgs: ['--enable-automation']` + `--disable-blink-features=AutomationControlled` | removes the automation switch the challenge scores on |
| a minimal flag list, `defaultViewport: null` | every extra flag and every device-metrics override is one more thing that can disagree with a real browser |
| a non-UTC **process** timezone (the container's `TZ`) | the challenge runs in a CROSS-ORIGIN frame that reads the BROWSER PROCESS's zone, so this cannot be done per page. Measured 2026-09-07: `TZ=UTC` + `page.emulateTimezone('America/Chicago')` stays stuck on the interstitial; `TZ=America/Chicago` with no emulation passes in ~8 s; `TZ=America/Chicago` emulating `America/New_York` also passes. UTC fails **silently** — nothing errors, the page just never leaves "Just a moment". `RESIDENTIAL_EGRESS_TIMEZONE` / `DIRECT_EGRESS_TIMEZONE` remain as optional per-page cosmetics and are left EMPTY by the deployment |
| no cosmetic UA/viewport overrides | the lane does not rewrite a Chrome 152's UA to the historical `Chrome/127` string (client hints contradict it, and Cloudflare binds the clearance to the UA that earned it), does not override the device metrics of a window that already has the size the flags asked for, and does not CDP-set `Accept-Encoding`/`Connection`. A store that DECLARES a UA still gets it; the cookie jar's pinned MINT UA is not applied in this mode (see below) |
| no replayed `cf_clearance` | a stored clearance was minted by another client, from another exit, and Cloudflare binds it to (IP, UA). In clean-headful mode the browser lane drops it from the jar and earns its own in-context; the jar's other cookies (sessions) still pass through |
| gated fetches in the browser's DEFAULT context | a `createBrowserContext` page **never clears the challenge**, even with its traffic demonstrably leaving the right residential IP (measured 2026-09-07: stuck past 40 s, while a plain tab in the same browser cleared in 8 s). A DevTools-created context is itself the tell |
| a warm pool of 2 (not 3) | the profile is process-wide, so the pooled browsers are headful too, and the challenge browsers are additional. Three full Chromes is what fits the pod's 3 Gi limit |

The gated cohort is also an **IP** gate: a clean browser from the datacenter node still fails, so those stores must declare `egress: 'residential'` as well.

A store that DECLARES the gate (`access: 'cloudflare'`) is REFUSED outright when `BROWSER_LAUNCH_MODE` is not `clean-headful` — `ChallengeLaneUnavailableError`, classified `extraction_unavailable` (one attempt, no retry), the same rule the residential lane applies to a missing proxy. The headless profile cannot clear a challenge and fails silently, and every doomed attempt still spends the egress IP's Cloudflare reputation. A set-but-unrecognised `BROWSER_LAUNCH_MODE` (a typo, a stray space) logs one boot warning and falls back to headless. A gate that was only LEARNED from a `cf-mitigated` response is not refused — one such response is a weaker signal than a declaration.

Once a challenge is passed, the clearance is bound to (IP, user agent, browser profile) and is good for roughly 30 minutes. So a gated fetch is a **tab in a long-lived browser**, one per egress — `residential` launched with `--proxy-server=$RESIDENTIAL_PROXY_URL`, `direct` launched without one — opened with `browser.newPage()` in that browser's DEFAULT context, exactly like a person with several tabs open. Every gated host on an egress shares that browser and therefore its clearances; the same host on two egresses is two browsers, because the clearance is bound to the exit IP.

`searchFetch.access: 'cloudflare'` declares the gate, and the engine also LEARNS it from a `cf-mitigated: challenge` response — a learned host moves onto the gated browser from its next fetch. The bounds: a browser is recycled after 2 h (the replacement is launched first, the old one drains its tabs and then closes), tabs are closed with their fetch, at most 2 concurrent tabs per gated host, a tab that will not close retires the whole browser, and both browsers close on shutdown. A host is session-primed once per browser instance when the store declares `sessionPrime` (anitoys' search results 404 without a same-session homepage visit). Reuse is the difference between a ~8 s first fetch and a sub-second second one (measured live, anitoysgk.com, 2026-09-07).

Ungated stores are untouched by all of this: they keep the per-request `createBrowserContext` on a pooled (or the stealth) browser, closed with the request.

A navigation that lands on the interstitial is waited out (bounded, 30 s — the CALLER's own budget can be shorter and then bounds it first: `/lookup` gives each store `LOOKUP_STORE_TIMEOUT_MS`, 15 s by default) and then waited on until the document that REPLACED it has parsed — `domcontentloaded` fires on the challenge page, and the title flips before the real document is readable. What ENDS that wait is four signals TOGETHER, never any one of them: no challenge title or markers, no `__cf_chl_rt_tk` round-trip token in the URL, a document parsed past `loading`, and a `cf_clearance` cookie for the fetched host in the jar of the context the page runs in. Measured against www.suruga-ya.jp from the production pod on 2026-09-07: `goto` resolves at t+1.07 s on a 403 `cf-mitigated: challenge`; the interstitial answers it by navigating to `…?__cf_chl_rt_tk=…` and straight back, so the token is gone by t+1.40 s with 8 s still to run; the `#challenge-running` / `#challenge-stage` containers are NEVER rendered on this variant; the clearance cookie lands at t+9.31 s while the page still reads "Just a moment..."; and the store's own document arrives only after the reload that follows. So a wait keyed on markers left on its first poll and captured the interstitial (the other gated stores were passing on timing luck), and a wait keyed on the cookie alone would leave ~0.3 s early, mid-reload. A page that cannot report cookies (a test double) has no positive evidence to offer, so for it the URL token and the parse state are the whole grace. A wait that runs out its budget still captures whatever rendered, with one `[CHALLENGE]` warning. Landing on the real page also means landing on the referrer it came from, so a cleared page carries `__cf_chl_tk` inside a URL-encoded `ref=` parameter; the body-level challenge detector keys on Cloudflare's script GLOBALS (`_cf_chl_opt`, `__cf_chl_ctx`, `__cf_chl_managed_tk__`) and no longer on that bare token, which would otherwise fail the ingest of every gated store's first fetch. The session-priming navigation is waited out the same way — it is the one that MEETS the challenge on a fresh context, and navigating to the target before it clears cancels it. `GET /health/detailed` reports the lane's live configuration as `browserLane: { launchMode, residentialTimezone, directTimezone, processTimezone, gatedBrowsers }`. Each gated fetch also logs one line — `[GATED] <egress> tab for <host> (primed=<bool>, tabs=<n>)` — under the pool's own `[BROWSER POOL] Launching the <egress> challenge-lane browser...`. Together they answer the question the lane is otherwise silent about: whether a fetch actually reached the gated browser, or quietly took a per-request context instead.

**Client-rendered storefronts (`searchFetch.waitFor`):**

A PWA storefront renders its product client-side, so a browser-lane fetch that returns at `domcontentloaded` captures an empty app shell. Such a store declares `waitFor: { selector?, networkIdle?, timeoutMs? }` and the browser lane waits for the selector and/or network idle before reading the body. `timeoutMs` defaults to `15000` and is clamped to `[1000, 60000]`; a wait that times out is NOT an error — the lane captures whatever rendered and logs one `[WAITFOR]` warning, so a slow store degrades to today's behavior instead of failing the fetch. Undeclared stores never wait.

**Stored Cloudflare cookies (`CF_COOKIE_FILE`):**

`cf_clearance` is bound to the egress IP and the User-Agent it was minted under, and it cannot be minted from the pod. An operator mints it out-of-band, lands the file, and the engine injects it into all three fetch lanes for that host — impit (seeded into the session jar), plain http (`cookie` header), and browser (puppeteer `setCookie`, `httpOnly` + `secure`) — with the mint User-Agent pinned for the host on every lane. EXCEPT the browser lane in `clean-headful` mode: there the stored `cf_clearance` and the pinned mint UA are both skipped (a clearance minted by another client from another exit cannot be replayed by this browser, and presenting it under contradicting client hints is worse than presenting nothing). The jar's other cookies still ride that lane, and the impit/http lanes are unchanged. Every caller inherits it (ingest queue, `/lookup`, `/catalog`, `/resolve`, ruleset follow-up fetches); no ruleset or contract change is needed.

File format — a JSON object keyed by host; keys are normalized (lower-cased, leading `www.` stripped) and a url matches its exact host first, then a parent domain (`shop.example.com` → `example.com`), so subdomains of a minted apex are covered:

```json
{
  "myfigurecollection.net": {
    "cookies": { "cf_clearance": "<value>", "PHPSESSID": "<value>" },
    "userAgent": "<the exact User-Agent the cookies were minted under>",
    "mintedAt": "2026-09-06T00:00:00.000Z",
    "expiresAt": "2026-09-07T00:00:00.000Z"
  },
  "anitoysgk.com": { "cookies": { "cf_clearance": "<value>" } }
}
```

- `cookies` (required, non-empty): name → value. A cookie with an empty / non-string / unsendable value is dropped; a host left with no cookies is skipped (named in one warn).
- `userAgent` (recommended): pinned for the host on every lane — it wins over the store's declared UA and the impit profile's. Without it the lane's default UA is sent, which usually voids `cf_clearance`.
- `mintedAt` / `expiresAt` (optional, informational): surfaced on `/health/detailed` only.
- Hot reload: the file's mtime is polled every 30 s (unref'd timer). A rewrite goes live without a restart and RESETS every stale mark. A malformed file keeps the last-good set (one warn); a missing file reads as empty.
- Stale semantics: the engine never refreshes or retries a cookie. When a host the jar has cookies for STILL serves a challenge — at any of the existing cooldown sites (ingest honesty gate / extraction-throw door, `/lookup` search, `/catalog` listing, on any lane) — the host is marked `stale` once (`[CF-COOKIE] STALE <host> via <lane>: …` naming cookie NAMES only) and `/health/detailed` → `cfCookies[].stale` flips true with `staleSince` / `staleReason`. The existing storm protection is unchanged: one probe fetch per host per cooldown window, then the host cooldown fast-fails everything else. A clean body for that host marks it fresh again. A host the jar knows nothing about is never marked — its challenge is an egress matter, not a cookie one.
- Logs and the health view carry cookie NAMES only, never a value.

**Fetch-failure ledger (`REPORT_FETCH_FAILURES`):**

Every TERMINAL fetch failure the engine gives up on — the scrape queue's give-up branch, the crawler's axis stop, the lookup fan-out's per-store catch — is reported to the spine as one durable, classified row (`ingest.v1.SpineIngest/ReportFetchFailure`), so a dead item, a blocked store or a stale cookie survives the pod that saw it. One row per give-up, never one per internal retry: the row's `attempts` drives the spine's own backoff.

- `REPORT_FETCH_FAILURES`: the kill switch, **ON by default**. Unset, empty, or whitespace all mean "not configured" and leave reporting ON; only an explicit `false` / `0` / `no` / `off` (any case) turns it off. Off = every emit point is a no-op with no client built.
- Reporting rides the SAME `INGEST_BASE_URL` as the ingest emitter (one spine, one hop). With `INGEST_BASE_URL` unset there is nothing to report to and the ledger is off regardless of this switch.
- `REPORT_FAILURE_TIMEOUT_MS`: per-call deadline for a ledger RPC. Unset/invalid → default. Default: `10000`
- Reporting is best effort in every direction: a report never rejects, never throws, and never changes an item's outcome. Failures are counted and surfaced on `/health/detailed` (`fetchFailureLedger`), not propagated.
- Each row carries the store's `siteId` (or the reserved `unmatched` when no ruleset claimed the URL), the target URL, the reason class (`gone_404`, `http_429`, `challenge`, `redirect_home`, `ruleset`, …), the upstream HTTP status when a lane surfaced one, and the transport that served the fetch.
- **Stores where a 404 is ambiguous.** `gone_404` is the class that CLOSES a target as removed, so it is only used where a 404 is unambiguous. On `myfigurecollection.net` it is not: an NSFW / NSFW+ item answers 404 to a session that is not entitled (age gate, or scrape-account cookies gone stale), indistinguishably from an item that never existed. Such a row is booked `http_403` with a `denied-or-gone … session may need re-minting` message, is never retried (no retry re-mints a cookie), and goes to review instead of being auto-closed. The store list lives in one table in `src/services/recordFetchGate.ts`.
- `MFC_SESSION_CANARY_ITEM`: the item id of a KNOWN NSFW+ mfc item, used to tell those two cases apart. One 404 proves nothing; a PAIR does — a 404 on the canary item together with a 200 on ANY other mfc item within the same hour means the session has lost its entitlement. Both halves are ordinary ingest fetches, so the canary costs no extra request: the queue feeds every mfc fetch's status to it. On that pair the session is flagged stale on `/health/detailed` (`sessionCanary: {site, configured, stale, staleSince, staleReason}`, mirrored by the flat `mfcSessionStale` boolean an alert rule can key on) and one `[MFC SESSION]` line is logged — on the transition only, never per observation. The canary answering 200 clears the flag; everything else (a 404 on an ordinary item, two halves an hour apart, another store, no configured id) is inconclusive and leaves a standing flag exactly as it was. Unset/blank = the canary is off.

**Raw capture store (`PERSIST_RAW_HTML`, `PERSIST_RAW_IMAGES`):**

Captured bytes are written to a content-addressed S3-compatible bucket under the ratified `sha256-v1` key scheme — `<prefix>sha256/<aa>/<sha256hex><ext>`, where the digest is of the UNCOMPRESSED bytes and `aa` is its first two hex characters. Writes are HEAD-then-PUT and write-once; nothing is ever deleted, every op is timeout-bounded, and a store failure is swallowed-but-counted so a slow or broken bucket can never break or stall a scrape.

Two lanes, two switches, two prefixes:

| Lane | Switch | Prefix | Object |
|---|---|---|---|
| page bodies (`wire`, `dom`) | `PERSIST_RAW_HTML` | `RAW_STORE_S3_PREFIX` (`raw-html/`) | `gzip(body)`, `.html.gz`, `Content-Type: application/gzip` |
| API responses (`api`) | `PERSIST_RAW_HTML` | `RAW_STORE_S3_JSON_PREFIX` (`raw-json/`) | `gzip(body)`, `.json.gz`, `Content-Type: application/gzip` |
| images (`asset`) | `PERSIST_RAW_IMAGES` | `RAW_STORE_S3_IMAGE_PREFIX` (`raw-img/`) | the ORIGINAL bytes, unaltered — no gzip, real image `Content-Type`, extension from the magic bytes. Metadata carries `declared-content-type` plus the negotiation witnesses `content-encoding` and `vary`, so a re-encoded or transfer-encoded response is visible on the object |

- `PERSIST_RAW_HTML`: `true` enables page/API capture. Anything else (including unset) disables it silently. Enabled but incompletely configured is never a silent no-op — it logs one loud warning naming the missing variable and stays disabled.
- `PERSIST_RAW_IMAGES`: **a separate kill switch for the asset lane**, `true` (exactly) to enable, default OFF. It is independent of `PERSIST_RAW_HTML` in both directions: images are a different corpus with different volume and different rights, so turning page capture on must never start pulling binaries, and an images-only wiring (`PERSIST_RAW_IMAGES=true` with page capture off) is a supported configuration — **either** switch alone builds the real sink, and only the lane whose switch is off is refused. The refusal is at the WRITE boundary, not by convention: a lane whose switch is off is a counted skip (`skippedDisabled` / `assetSkipped.disabled`) that reaches no bucket, so a caller that forgets to consult `isImagePersistenceEnabled()` still cannot store an image. With **both** switches off the loader returns null and the process gets a `NoopCaptureSink` (intended silence); with either on but the store config incomplete, one loud warning names the switch and every missing variable.
- `RAW_STORE_S3_IMAGE_PREFIX`: bucket prefix for the asset lane. Default: `raw-img/`
- `RAW_STORE_IMAGE_MAX_BYTES`: hard ceiling on ONE **stored** image. A larger body is skipped, not truncated and not stored. It does **not** bound what is *downloaded*: by the time the sink sees a capture the body is already a Buffer and already hashed, so the fetcher that pulls an image is the layer that must reject on `Content-Length` and abort the read — this ceiling is the last line, not the first. Unset/invalid → the default; clamped to 64 MiB so a typo cannot remove the ceiling. Default: `10485760` (10 MiB)
- `RAW_STORE_S3_ENDPOINT` / `_REGION` / `_BUCKET` / `_PREFIX` / `_JSON_PREFIX` / `_PATH_STYLE`, `RAW_STORE_KEY_SCHEME` (only `sha256-v1` is understood — an unknown scheme fails fast at boot), `RAW_STORE_PUT_TIMEOUT_MS` (default `5000`, page lanes only), `RAW_STORE_IMAGE_PUT_TIMEOUT_MS` (default `30000` — the asset lane's own HEAD/PUT budget: an original image is up to 10 MiB against a page body's ~30 KB gzipped, so it cannot share the page budget), and the credential pair `RAW_STORE_S3_ACCESS_KEY_ID` / `RAW_STORE_S3_SECRET_ACCESS_KEY`.

On the asset lane the store's declared `Content-Type` is **advisory only** — CDNs mislabel images as `application/octet-stream`, and a challenge or error page is routinely served under the image's own content type. The MAGIC BYTES decide: `jpg`, `png`, `webp`, `gif`, `avif` (AVIF is matched on its major brand *and* its compatible-brand list, since real AVIF is commonly emitted as `mif1`/`miaf`). Sniffing types the **prefix**, not the whole body: a polyglot that is a valid GIF/JPEG header *and* a valid script is stored — which is why originals are private, never served and never shown. Both types are recorded (the sniffed one as the object's `Content-Type`, the declared one as `x-amz-meta-declared-content-type`). Anything else is a typed SKIP — counted, never stored, never thrown:

| Skip | When |
|---|---|
| `notImage` | the bytes are not one of the five formats (html, json, svg, text — an error or challenge page) |
| `tooLarge` | over `RAW_STORE_IMAGE_MAX_BYTES` |
| `empty` | a zero-length body |
| `disabled` | `PERSIST_RAW_IMAGES` is not `true` — the lane refuses the write regardless of the caller |

Asset objects carry their provenance as user metadata: `url` (the image URL), `fetched-at`, `site` (the DECLARING store, since the image usually lives on a CDN host that says nothing about whose catalogue it belongs to), `source-item` (`<site>/<itemId>`), `source-url` (the page that referenced it), `position` (its index in that page's image list), `role` (what the referencing page said the image IS, in the contract's vocabulary — the bytes cannot say whether a JPEG is a product plate or a box shot), `lane`, `declared-content-type` and `bytes`. The set is BUDGETED as a whole (S3 caps user metadata at ~2 KB of header bytes for the whole set, not per value, and both the image URL and the declared Content-Type are store-controlled): over budget, `declared-content-type`, `source-url`, `position` and `bytes` are shed in that order and the longest survivor is truncated — a degraded tag, never a lost object. Originals are stored unaltered and are **never shown** — any surfaced image is a sanitized derivative produced downstream.

Because the key is the content address, provenance metadata describes the **first** capture of those bytes only: the same press photo reused across items, variants or stores is stored once, and the second capture dedupes without rewriting the tags. The spine's capture event log — one row per *reference*, written by the caller that fetches the image — is the authoritative record of which items use an image; the bucket metadata is a convenience tag, not an index.

Op timeouts are a race, not a cancellation (the minio client takes no `AbortSignal`): a timed-out PUT is counted as a failure but may still land in the bucket, after which the next capture of those bytes dedupes. Sizing the asset budget to the payload is what keeps that from being routine.

The sink's counters (`stored` / `deduped` / `failed` / `skippedDisabled`, plus `assetStored` / `assetDeduped` / `assetSkipped` / `assetFailed`) are exposed by `ObjectStoreCaptureSink.stats()` and published on `GET /health/detailed` as `rawStore: { configured, stats? }`. `configured:false` means no sink was built at all (both switches off, or an incomplete store config) — the distinction an operator needs, since an asset lane whose every body is refused as `notImage` (a CDN answering image requests with a challenge page) otherwise looks exactly like an idle one.

**MFC Cookie Security:**
- `MFC_ALLOWED_COOKIES`: Whitelist of cookie names allowed during authenticated MFC scraping
  - **Default**: `PHPSESSID,sesUID,sesDID,cf_clearance`
  - **Purpose**: Security filter that only allows known MFC session cookies
  - **Format**: Comma-separated list of cookie names (case-sensitive)
  - **Why needed**: Prevents users from accidentally or maliciously injecting arbitrary cookies
  - Users provide session cookies via the API; this env var controls which ones are actually used

**Debug Logging:**
- `DEBUG`: Enable debug namespaces (e.g., `scraper:*`, `scraper:mfc`, `scraper:browser`)
- `SERVICE_AUTH_TOKEN_DEBUG`: Show partial tokens in logs for debugging (default: false)

## Integration

Update your main application to call this service instead of direct scraping:

```javascript
// MFC scraping (use environment-specific URL)
const scraperUrl = process.env.SCRAPER_SERVICE_URL || 'http://scraper:3000';
const response = await fetch(`${scraperUrl}/scrape/mfc`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: mfcLink })
});

// Generic scraping
const response = await fetch(`${scraperUrl}/scrape`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://example.com/item/123',
    config: { imageSelector: '.product img' }
  })
});
```

## Architecture

This service runs separately from your main application to:
- Isolate browser automation resource usage
- Prevent main app crashes from scraping failures
- Allow independent scaling and updates
- Provide better browser fingerprinting

### Data Flow

```
Sync Workflow:
  validate-cookies → export-csv → parse CSV → queue items
       ↓                                          ↓
  sessionManager                          scrapeQueue (HOT/WARM/COLD)
                                                  ↓
                                          genericScraper (browser pool)
                                                  ↓
                                          extractors (company, artist, release, price)
                                                  ↓
                                          webhookClient → backend (HMAC-signed)
```

### Key Design Decisions

- **3-Tier Priority Queue**: HOT items (recently updated) are scraped first, WARM next, COLD last. Deduplication prevents redundant scrapes.
- **Session Pause/Resume**: Automatic pause after consecutive failures with configurable cooldown, plus manual resume via API.
- **HMAC Webhooks**: All callbacks to backend are signed with SHA-256 HMAC for authentication.
- **Browser Pool**: Pre-launched browsers eliminate startup delay. Fresh sessions per request prevent fingerprint accumulation.

## Performance

- **Browser Pool**: Pre-launched browsers eliminate 2-3 second startup delay
- **Fresh Sessions**: Each request gets clean browser to bypass anti-bot detection
- **Auto-Replenishment**: Pool automatically replaces used browsers in background
- **Optimized Chrome**: Container-optimized flags for minimal resource usage
- **Graceful Shutdown**: Proper browser cleanup on service termination
- **Adaptive Rate Limiting**: Queue automatically adjusts delay based on failure rates

## Adding New Sites

To add support for a new site, update `SITE_CONFIGS` in `src/services/genericScraper.ts`:

```javascript
export const SITE_CONFIGS = {
  mfc: { /* existing config */ },
  hobbylink: {
    imageSelector: '.product-main-image img',
    manufacturerSelector: '.maker-name',
    nameSelector: '.product-name h1',
    scaleSelector: '.scale-info .value',
    waitTime: 1500
  }
};
```
