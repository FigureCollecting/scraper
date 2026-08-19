/**
 * extractRecords — folds a ruleset's extraction dispatch (extractMany > extractAsync > extract,
 * see plugin-contract's E1/extractMany doc) into ONE always-array result, so every caller (the
 * live ingest queue, the crawl driver) can treat "one record" and "N records" identically:
 *
 *   - `extractMany` present  → `await ruleset.extractMany(html, url, ctx)` verbatim.
 *   - `extractMany` absent   → `[await (extractAsync ?? extract)(html, url, ctx)]` — the exact
 *     duck-typed fallback the engine already runs today (scrapeQueue.ts's pre-B3
 *     `extractAsync`-then-`extract` dispatch), just wrapped in a one-element array. A
 *     single-record ruleset's OWN extraction call is therefore byte-for-byte what it is today;
 *     only the caller-facing shape (array vs bare object) changes.
 *
 * Guards (spec.md orzgk Slice B, D11) run on every dispatch, single-record included, so a
 * multi-record ruleset's ordering bug surfaces loudly as a thrown content failure — NOTHING is
 * emitted, nothing is silently reordered or dropped:
 *   - empty result (a ruleset returning `[]` from `extractMany`) → throw.
 *   - two records sharing `source.itemId` → throw.
 *   - a record's `fields.editionOf` / `fields.offerOf` naming another record's `itemId` that is
 *     NOT a STRICTLY EARLIER record in the array (self-reference or forward/missing reference)
 *     → throw. This is what lets the wire step (D2: N sequential unary `Ingest` calls, parent
 *     first) trust array order == dependency order without re-deriving it.
 *
 * Deliberately NOT run here: `ruleset.validate()`. Neither the live queue's `processViaIngest`
 * nor the crawl driver's `crawlWorker` call `validate()` today (grep confirms zero call sites) —
 * this helper mirrors that, so wiring it in changes nothing about when/whether validation runs.
 */
import type { ExtractContext, ExtractedData, ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';

/**
 * The duck-typed async-extraction path some rulesets exposed before E1 made `extract()` itself
 * async-capable (VNDB, AmiAmi-era plugins). Kept for exactly those; the contract has no such
 * member, hence the local shape.
 */
type RulesetWithExtractAsync = ExtractionRuleset & {
  extractAsync?: (html: string, url: string, ctx?: ExtractContext) => Promise<ExtractedData>;
};

/** Which multi-record target field a record carries (mutually exclusive in practice). */
type TargetRef = { field: 'editionOf' | 'offerOf'; itemId: string };

function readTargetRef(record: ExtractedData): TargetRef | undefined {
  const fields = (record?.fields ?? {}) as Record<string, unknown>;
  if (typeof fields.editionOf === 'string') return { field: 'editionOf', itemId: fields.editionOf };
  if (typeof fields.offerOf === 'string') return { field: 'offerOf', itemId: fields.offerOf };
  return undefined;
}

function validateRecordSet(ruleset: ExtractionRuleset, records: ExtractedData[]): void {
  const label = `${ruleset.siteId}@${ruleset.version}`;

  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`[EXTRACT RECORDS] ${label}: extraction produced no records (empty result)`);
  }

  const seenIds = new Set<string>();
  records.forEach((record, index) => {
    const itemId = record?.source?.itemId;
    if (!itemId) {
      throw new Error(`[EXTRACT RECORDS] ${label}: record[${index}] has no source.itemId`);
    }
    if (seenIds.has(itemId)) {
      throw new Error(
        `[EXTRACT RECORDS] ${label}: duplicate source.itemId '${itemId}' at record[${index}] — every record must be a distinct entity`
      );
    }

    const target = readTargetRef(record);
    if (target) {
      if (target.itemId === itemId) {
        throw new Error(
          `[EXTRACT RECORDS] ${label}: record[${index}] (itemId '${itemId}') targets itself via fields.${target.field}`
        );
      }
      if (!seenIds.has(target.itemId)) {
        throw new Error(
          `[EXTRACT RECORDS] ${label}: record[${index}] (itemId '${itemId}') targets '${target.itemId}' via fields.${target.field}, ` +
            `but no earlier record in the array carries that itemId — target-first ordering violated`
        );
      }
    }

    // Added AFTER the target check so target-first ordering means STRICTLY earlier, never self.
    seenIds.add(itemId);
  });
}

/**
 * Dispatch a ruleset's extraction and return it as an array, guarded per D11. Always resolves to
 * a non-empty array or throws — never returns `undefined`/partial.
 */
export async function extractRecords(
  ruleset: ExtractionRuleset,
  html: string,
  url: string,
  ctx?: ExtractContext,
): Promise<ExtractedData[]> {
  let records: ExtractedData[];

  if (typeof ruleset.extractMany === 'function') {
    records = await ruleset.extractMany(html, url, ctx);
  } else {
    const withAsync = ruleset as RulesetWithExtractAsync;
    const record =
      typeof withAsync.extractAsync === 'function'
        ? await withAsync.extractAsync(html, url, ctx)
        : await ruleset.extract(html, url, ctx);
    records = [record];
  }

  validateRecordSet(ruleset, records);
  return records;
}
