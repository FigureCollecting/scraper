/**
 * crawlWorker — the crawl driver's I2 worker: the `(task) => Promise<Outcome>` function the
 * CrawlLoop launches per dispatch. It composes the injected engine ports into one item pipeline:
 *
 *   resolveUrl(task) → fetch(url) → extractRecords(lookupRuleset(url), html, url, ctx) → emit(each)
 *
 * and records the item's fate on the CoverageLedger. Everything is injected (no ScrapingService /
 * ExtractionRegistry / IngestEmitter imports here) so the worker is a pure composition unit,
 * deterministically testable with fakes; the real services wire in at I3.
 *
 * TWO INDEPENDENT AXES (do not conflate):
 *   - Outcome ('success' | 'rate-limited') is the HOST's mood, fed back to the scheduler:
 *     'success' recovers the host delay, 'rate-limited' backs it off. It is NOT item success.
 *   - The ledger carries the ITEM's coverage fate: markDone (covered) / markFailed (won't cover
 *     this pass). Left untouched = still pending, so a resume retries it.
 *
 *   no URL / no ruleset      → markFailed + 'success'      config/coverage gap; host not contacted
 *   fetch throws / 429 / 503 → (pending)  + 'rate-limited' host throttled/blocked → back off, retry
 *   extract throws           → markFailed + 'success'      page fetched OK; CONTENT failed (see note)
 *   emit throws              → (pending)  + 'rate-limited' delivery failed → backpressure, retry
 *   emit OK (every record)   → markDone   + 'success'      covered
 *
 * LAYERING NOTE — why "extract throws" is a content failure, not a block: Cloudflare / throttle
 * detection is the FETCH port's contract (it throws or returns a 429/503). So by the time control
 * reaches extract, the page is real content; an extract throw is a genuine coverage-gate/parse
 * failure (the plugin wraps extract with the coverage gate), which backing off the host would not
 * fix. Spine-down backpressure via 'rate-limited' on emit failure is deliberately crude — a
 * spine-health circuit breaker belongs at the loop/driver level (I3), not per item.
 *
 * B3 DRIVER PARITY (spec.md orzgk Slice B D7): extraction is dispatched through `extractRecords`
 * (engineServices/extractRecords.ts — the SAME helper the live ingest queue uses), which folds
 * `extractMany` (if the ruleset has it) into an always-array result and enforces the D11
 * ordering/uniqueness guards; a violation throws, landing in the SAME "extract throws → markFailed
 * + success" bucket as any other content failure. `emit` then runs sequentially over EVERY record
 * in array order (D2: parent-first, each awaited) — the first emit failure stops the loop (later,
 * dependent records are never sent) and lands in the SAME "emit throws → pending + rate-limited"
 * bucket as today's single-record path. A single-record ruleset (no `extractMany`) is therefore
 * byte-for-byte unaffected: `extractRecords` wraps its one record in a 1-element array, so the
 * `emit` loop runs exactly once, exactly as it does today. Dormant until A3 (no non-test importer
 * of `src/driver/` yet).
 */
import type { CrawlTask, Outcome } from './dispatchScheduler.js';
import type { CoverageLedger } from './coverageLedger.js';
import type { ExtractContext, ExtractedData, ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';
import { extractRecords } from '../services/engineServices/extractRecords.js';

/** What the fetch port yields. It MUST throw on CF-block / network error (→ treated as throttle). */
export interface FetchResult {
  html: string;
  statusCode?: number;
}

/** Only the two ledger mutations the worker performs — keeps it loosely coupled + easy to fake. */
export type CoverageSink = Pick<CoverageLedger, 'markDone' | 'markFailed'>;

export interface CrawlWorkerDeps {
  /** Turn a task ({ host, id }) into the item URL via the host's `retrieval.byId` template. */
  resolveUrl: (task: CrawlTask) => string | undefined;
  /** Fetch the page. Contract: THROW on CF-block / network error; return a 429/503 status to throttle. */
  fetch: (url: string) => Promise<FetchResult>;
  /** Find the ruleset that extracts this URL's store (undefined → no coverage for it). */
  lookupRuleset: (url: string) => ExtractionRuleset | undefined;
  /** Deliver the extraction to the spine (reuses IngestEmitter.send at I3). */
  emit: (extracted: ExtractedData) => Promise<unknown>;
  /** Per-store coverage record: markDone on cover, markFailed on a permanent item failure. */
  ledger: CoverageSink;
  /** Optional per-extraction context for multi-query rulesets (I3 supplies it; omit → 2-arg extract). */
  resolveContext?: (task: CrawlTask, url: string) => ExtractContext | undefined;
  /** HTTP statuses meaning "throttled, back off" (default 429, 503). */
  throttleStatuses?: number[];
}

const DEFAULT_THROTTLE_STATUSES = [429, 503];

export function makeCrawlWorker(deps: CrawlWorkerDeps): (task: CrawlTask) => Promise<Outcome> {
  const throttle = new Set(deps.throttleStatuses ?? DEFAULT_THROTTLE_STATUSES);

  return async (task: CrawlTask): Promise<Outcome> => {
    const url = deps.resolveUrl(task);
    if (!url) {
      deps.ledger.markFailed(task.id); // no targeted-retrieval URL for this host — coverage gap
      return 'success';
    }

    const ruleset = deps.lookupRuleset(url);
    if (!ruleset) {
      deps.ledger.markFailed(task.id); // no ruleset registered for this store — coverage gap
      return 'success';
    }

    let page: FetchResult;
    try {
      page = await deps.fetch(url);
    } catch {
      return 'rate-limited'; // network error / CF block → back off, leave the item pending
    }
    if (page.statusCode !== undefined && throttle.has(page.statusCode)) {
      return 'rate-limited'; // host throttled → back off, leave the item pending
    }

    let records: ExtractedData[];
    try {
      records = await extractRecords(ruleset, page.html, url, deps.resolveContext?.(task, url));
    } catch {
      deps.ledger.markFailed(task.id); // page came back fine; content/coverage failed — not a throttle
      return 'success';
    }

    try {
      // D2: sequential unary emit, array order (parent-first), each awaited — stop at the first
      // failure so a dependent (editionOf/offerOf) record is never sent ahead of a target that
      // never landed. A single-record ruleset's one-element array runs this loop exactly once.
      for (const record of records) {
        await deps.emit(record);
      }
    } catch {
      return 'rate-limited'; // delivery failed (spine) → backpressure; item stays pending for retry
    }

    deps.ledger.markDone(task.id); // delivered → this ID is covered
    return 'success';
  };
}
