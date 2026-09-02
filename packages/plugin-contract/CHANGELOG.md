# Changelog

All notable changes to `@figurecollecting/scraper-plugin-contract` will be documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this
package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
