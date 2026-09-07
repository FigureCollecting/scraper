# Changelog

All notable changes to `@figurecollecting/scraper-plugin-contract` will be documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this
package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-09-07

Additive, backward-compatible: every existing `SearchFetch` still compiles unchanged — the new
fields are all optional and an undeclared store's fetches are byte-identical. Built for the residential
egress lane (Cloudflare-cohort stores whose gate is IP/ASN reputation) and for client-rendered
(PWA) storefronts the browser lane used to capture as an empty app shell.

### Added
- `SearchFetch.egress?: 'direct' | 'residential'` (and the `EgressMode` export) — which egress this
  store's fetches leave through. `residential` routes them through the engine's configured
  residential proxy (`RESIDENTIAL_PROXY_URL`) on the impit and browser lanes; undeclared (or
  `direct`) keeps today's node-IP path. The declaration is a REQUIREMENT, not a hint: with no proxy
  configured the engine REFUSES the fetch (a typed, non-retried config failure) rather than silently
  falling back to the node IP.
- `SearchFetch.access?: 'open' | 'cloudflare'` (and the `StoreAccess` export) — the store's edge
  gate. `cloudflare` tells the engine's browser lane to KEEP this host's browser context alive
  between fetches (Cloudflare binds a clearance to IP + user agent + context, so a fresh context
  re-runs the challenge every time) and makes `sessionPrime` apply to the browser lane as well as to
  impit. Undeclared (or `open`) ⇒ a fresh context per request, exactly as before; the engine still
  LEARNS the gate from a `cf-mitigated: challenge` response for stores that do not declare it.
- `SearchFetch.waitFor?: { selector?; networkIdle?; timeoutMs? }` (and the `WaitForReadiness`
  export) — browser-lane readiness for a client-rendered storefront: after `domcontentloaded`, wait
  for the selector and/or network idle, bounded by `timeoutMs` (engine default 15000, clamped to
  [1000, 60000]), before capturing. A timed-out wait captures whatever rendered and logs one
  warning — never an error. Undeclared ⇒ today's `domcontentloaded` behavior.

## [0.6.0] - 2026-09-06

Additive, backward-compatible: every existing `RetrievalCapability` and `ExtractionRuleset` still
compiles unchanged — the new axis and parser are optional. Built for the catalog feeder
(continuous recent/backfill enumeration crawls over each store's newest-first listing).

### Added
- `RetrievalCapability.byListing?: { urlTemplate; pageStart?; maxPerPage?; order: 'newest' }` —
  a newest-first PAGED catalog listing for ENUMERATION (as opposed to targeted retrieval). The
  engine fetches page N by substituting `{page}` (which the template MUST contain); `pageStart` is
  the first page (default 1), `maxPerPage` documents the store's page-size cap, and `order` is
  `newest` — the only order the feeder reasons about (page 1 = freshest).
- `ListingPage` — one parsed listing page: `items: [{ itemId, url? }]` (`itemId` feeds
  `retrieval.byId` like `SearchCandidate.itemId`; `url` is the product page link for stores without
  a byId axis, absolute or relative to the listing url), plus optional paging signals `hasMore` and
  `nextPage` (absent → the engine infers them: a non-empty page has more, next = page + 1).
- `ExtractionRuleset.extractListing?(body, url, ctx?)` — OPTIONAL, parses one catalog-listing
  page body (fetched from `retrieval.byListing`) into a `ListingPage`. Distinct from
  `extractCandidates` (one search query's results). Async-capable; the engine always awaits it.

## [0.5.0] - 2026-09-01

Additive, backward-compatible: every existing `ExtractionRuleset` still compiles unchanged — the
new field is optional and its absence keeps the safe default (a zero-record extraction stays an
error). Built for the emit honesty gate (valid-empty vs error-empty).

### Added
- `ExtractionRuleset.emptyResultIsValid?: boolean` — when `true`, the ruleset declares that a
  ZERO-RECORD extraction is a VALID outcome (a well-formed empty search/listing result, a delisted
  page with no claimable data): the engine records such an extraction as a SUCCESS (empty) instead
  of a failure. Applies ONLY to a genuinely empty return from `extractMany` (an `[]`) on a
  NON-challenge page. Omit (or `false`) to keep the safe default — a zero-record extraction is an
  error, so a ruleset that has NOT reasoned about empties never has its parse breaks silently pass.

## [0.4.1] - 2026-08-31

Additive, backward-compatible: every existing `bySearch` capability still compiles unchanged — the
new field is optional and its absence keeps today's token-match behavior. Built for cross-store
lookup against substring-match search stores (Ueeshop/gkloot).

### Added
- `RetrievalCapability.bySearch.queryMatch?: 'tokens' | 'substring'` — how the store's search
  interprets `{q}`: `tokens` (the default, today's behavior) matches the query WORDS against the
  product name; `substring` matches `{q}` as ONE contiguous case-insensitive substring of the
  product name (Ueeshop/gkloot), so a multi-term identity phrase matches nothing. For a `substring`
  store the engine issues the single most selective identity term as `{q}` and post-filters the
  candidates by the remaining identity terms.

## [0.4.0] - 2026-08-19

Additive, backward-compatible: every existing 2-argument ruleset and every existing
`ExtractContext` consumer still compiles unchanged. Built for orzgk Slice B (multi-record
extract, see the Slice B build-ready spec, §1/§3.1/§6 B1/§10 D9).

### Added
- `ExtractionRuleset.extractMany?(html, url, ctx?)` — OPTIONAL, extracts MULTIPLE records from
  one fetched page (`result[0]` = the page's own `extract()`-equivalent record, remaining
  records share `source.site` but carry distinct `source.itemId`s, target-first ordering for
  `fields.offerOf`/`fields.editionOf`). Engines that don't call it keep calling `extract()`.
- `ExtractContext.scraping.fetchBody?(url, opts?)` — OPTIONAL, a lightweight non-browser
  same-store follow-up GET through the engine's declared transport, raw-captured and
  courtesy-gapped by the engine against the primary fetch.

### Changed
- `ExtractContext.scraping.batchFetch` and `.officialApi` are now OPTIONAL (`?`). They were
  already documented as "a minimal engine may not yet provide" these; the type now matches
  that reality instead of forcing every `ExtractContext` builder to stub them.
