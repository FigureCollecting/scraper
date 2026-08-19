# Changelog

All notable changes to `@figurecollecting/scraper-plugin-contract` will be documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this
package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
