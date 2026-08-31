/**
 * assembleResolve — the byId CONFIRM runtime (the matcher's pass-2 bridge, and /resolve's engine).
 * Given a store + item ids (e.g. the `resolveTargets` a record-mode lookup surfaced, or a candidate
 * the caller picked), it fetches each item's DETAIL page and dispatches the store's ruleset through
 * `extractRecords` (extractMany > extractAsync > extract — the SAME dispatch the ingest queue and
 * crawl worker use, engineServices/extractRecords.ts) → full `ExtractedData` (whose `fields.gtin14`
 * the private byId ruleset populates). `records[0]` (the page's own record) is the confirm's `data`;
 * an extractMany ruleset's EXTRA records (editions/offers) ride the additive `ResolveItem.records`.
 * Unlike the crawl worker, it RETURNS the data and NEVER emits to the spine or touches a ledger.
 *
 * Composed from existing primitives — `resolveByIdUrl` + an injected detail fetch + the shared
 * `extractRecords` dispatch (fed an `ExtractContext` via the optional `resolveContext` seam, the
 * crawlWorker pattern) — so it reuses the same substrate the crawl worker is built from, one layer
 * down, without the spine/ledger coupling. Everything injected → deterministic in tests.
 *
 * PACING (H1 parity): ids are processed SEQUENTIALLY, and one per-call, per-host last-fetch map
 * (shared with every id's ExtractContext) floors each fetch — primary or follow-up — at the
 * store's `rateLimit.baseDelayMs` against the call's previous fetch to the same host. This is the
 * queue's `hostLastDispatch` semantic for the resolve leg: a multi-id confirm never fires
 * synchronized same-host bursts, at the price of response time scaling with ids × gap.
 */
import { resolveByIdUrl } from './retrievalPlanner.js';
import { extractRecords } from '../services/engineServices/extractRecords.js';
import { DEFAULT_FETCH_BODY_GAP_MS, safeHostname } from '../services/engineServices/extractContext.js';
import { isCloudflareChallenge } from '../services/engineServices/challengeDetect.js';
import { getChallengeCooldown, type ChallengeCooldown } from '../services/challengeCooldown.js';
import { sanitizeForLog } from '../utils/security.js';
import type { ProfileRegistry } from './profileRegistry.js';
import type { ExtractContext, ExtractedData, ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';

export interface ResolveServices {
  /** The store registry (built from the engine's registered capabilities). */
  profiles: ProfileRegistry;
  /** URL → ruleset (engine ExtractionRegistryImpl.getRulesetForUrl); the ruleset's extract() confirms. */
  getRulesetForUrl: (url: string) => ExtractionRuleset | undefined;
  /** Fetch a detail page's body (the pooled ScrapingService's scrapePage at the mount). */
  fetchDetail: (url: string) => Promise<{ html: string; statusCode?: number }>;
  /**
   * OPTIONAL per-id `ExtractContext` resolver (the crawlWorker `resolveContext` seam): the wiring
   * (engineResolve) builds it via `buildExtractContext`, so an extractAsync/extractMany ruleset's
   * follow-up fetches ride the store's declared transport into the capture sink, courtesy-gapped
   * against `primaryFetchedAt` (epoch ms when THIS id's detail fetch completed).
   */
  resolveContext?: (
    ruleset: ExtractionRuleset,
    url: string,
    primaryFetchedAt: number,
    /** The call's SHARED per-host last-fetch map — thread it into the ctx so follow-ups re-gap across sibling ids too. */
    lastFetchedAt: Map<string, number>,
  ) => ExtractContext | undefined;
  /** Injectable clock anchoring `primaryFetchedAt` and the pacing floor (default `Date.now`). */
  now?: () => number;
  /** Injectable sleep for the cross-id courtesy gap (default: a real `setTimeout` promise). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Per-host Cloudflare-challenge cooldown register (shared with the ingest queue, the lookup
   * fan-out, and /health/detailed). Optional — defaults to the process-wide singleton; tests inject
   * a clock-controlled instance. An id whose host is cooling is SKIPPED without fetching (→ the
   * additive `cooldown` list); a detail body that IS a challenge OPENS its host's cooldown so the
   * other lanes leave it alone. This is the CONFIRM leg's equivalent of the queue's fast-fail gate.
   */
  challengeCooldown?: ChallengeCooldown;
}

export interface ResolveItem {
  itemId: string;
  url: string;
  /** The confirmed record when fetch + extract succeeded. */
  data?: ExtractedData;
  /**
   * ADDITIVE (multi-record rulesets only): the records BEYOND the page's own — extractMany's
   * children (editions/offers), in the same target-first order the ingest path emits them. ABSENT
   * when extraction yielded exactly one record, so single-record confirms keep today's shape
   * byte-for-byte. `data` above is always `records[0]` of the full extraction (the listing/parent).
   */
  records?: ExtractedData[];
  /**
   * The gtin14 the byId extract recovered, surfaced for the matcher. UNDEFINED means the confirm did
   * NOT yield a barcode (a no-JAN statue, OR an SPA/CF page the browser fetch under-extracted) — so
   * "confirmed but unanchored" is visible rather than a silent empty success.
   */
  gtin14?: string;
}

export interface ResolveResult {
  site: string;
  results: ResolveItem[];
  /** The site has no byId axis (or is unknown) — none of the ids can be resolved. */
  unsupported: boolean;
  /** Item ids whose detail fetch or extract errored (transparency, not silent drop). */
  failed: string[];
  /**
   * Item ids SKIPPED without fetching because the host is cooling from a recent Cloudflare challenge
   * (additive — distinct from `failed`: the id is fine, we are deliberately leaving its host alone
   * until the cooldown expires). Mirrors LookupResult.cooldown for the CONFIRM leg.
   */
  cooldown: string[];
}

export interface Resolve {
  resolve(site: string, ids: string[]): Promise<ResolveResult>;
}

export function assembleResolve(services: ResolveServices): Resolve {
  return {
    async resolve(site, ids) {
      const caps = services.profiles.forSite(site);
      if (!caps?.retrieval?.byId) {
        return { site, results: [], unsupported: true, failed: [], cooldown: [] };
      }

      const now = services.now ?? Date.now;
      const sleep = services.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const cd = services.challengeCooldown ?? getChallengeCooldown();
      const gapMs = caps.rateLimit?.baseDelayMs ?? DEFAULT_FETCH_BODY_GAP_MS;
      // ONE per-host last-fetch map for the WHOLE call (H1 parity, cross-id): every id in a call
      // targets the same store, so the queue would space them by the store's baseDelayMs — this
      // map (shared with each id's ExtractContext below) is the resolve leg's equivalent floor.
      const lastFetchedAt = new Map<string, number>();

      const results: ResolveItem[] = [];
      const failed: string[] = [];
      const cooldown: string[] = [];
      // SEQUENTIAL by design, not Promise.all: concurrent ids would fire same-host bursts the
      // check-then-sleep gap cannot prevent (all readers see the same stale timestamp). The queue
      // is sequential per host for the same reason; per-id failure isolation is unchanged.
      for (const itemId of ids) {
        try {
          // INSIDE the try: resolveByIdUrl's encodeURIComponent throws on a lone-surrogate id,
          // and getRulesetForUrl deliberately propagates new URL() errors — either must fail
          // ONLY this id (failed[]), never reject the whole batch into the route's 502.
          const url = resolveByIdUrl(caps.retrieval, itemId);
          const ruleset = url ? services.getRulesetForUrl(url) : undefined;
          if (!url || !ruleset) {
            failed.push(itemId);
            continue;
          }
          const host = safeHostname(url);
          // CHALLENGE COOLDOWN (before any fetch): the host is cooling from a recent CF challenge —
          // do NOT fetch it (every challenge fetch degrades the egress IP's CF reputation). Skip the
          // id to the additive `cooldown` list; once the window passes isOpen is false and the fetch
          // proceeds normally. The CONFIRM leg's equivalent of the queue's fast-fail gate.
          if (host !== undefined && cd.isOpen(host)) {
            const minsLeft = Math.max(1, Math.ceil(cd.remaining(host) / 60_000));
            // eslint-disable-next-line no-console
            console.warn(`[COOLDOWN] skipped ${sanitizeForLog(url)} (${host} cooling, ${minsLeft} min left)`);
            cooldown.push(itemId);
            continue;
          }
          // Cross-id courtesy floor on the PRIMARY fetch: wait out the store's gap against the
          // call's last fetch to this host (a sibling's primary, or its same-host follow-up).
          const last = host === undefined ? undefined : lastFetchedAt.get(host);
          if (last !== undefined) {
            const remaining = last + gapMs - now();
            if (remaining > 0) await sleep(remaining);
          }
          // Record the attempt win or lose (the host was contacted either way — H1 records at
          // dispatch), completion-anchored like D8 so one map carries one consistent semantic.
          const { html, statusCode } = await services.fetchDetail(url).finally(() => {
            if (host !== undefined) lastFetchedAt.set(host, now());
          });
          // A detail body that IS a Cloudflare challenge is NOT a confirm — the browser lane never
          // sets a `challenge` flag, so detect it on the body here: OPEN the host's cooldown (so the
          // queue and the lookup fan-out then leave it alone) and fail THIS id. Checked BEFORE the
          // status gate so a 200 interstitial that rendered opens the cooldown too, not only a 5xx.
          if (isCloudflareChallenge(html)) {
            if (host !== undefined) cd.open(host, 'detail challenge page');
            throw new Error('detail fetch returned a Cloudflare challenge page');
          }
          // A 4xx/5xx page (gone / error) is NOT a confirm — extract would happily parse the error
          // body into empty fields WITHOUT throwing, so gate on status explicitly.
          if (statusCode !== undefined && statusCode >= 400) {
            throw new Error(`detail fetch returned HTTP ${statusCode}`);
          }
          // The courtesy-gap anchor: the instant the PRIMARY detail fetch completed (D8), so a
          // same-host ctx.scraping.fetchBody follow-up waits the store's gap against THIS fetch.
          const primaryFetchedAt = now();
          // Same dispatch as ingest/crawl: extractMany > extractAsync > extract, D11-guarded —
          // a guard violation throws into this id's OWN failure handling below, same as ingest.
          const records = await extractRecords(
            ruleset,
            html,
            url,
            services.resolveContext?.(ruleset, url, primaryFetchedAt, lastFetchedAt),
          );
          const data = records[0];
          const gtin14 = typeof data.fields.gtin14 === 'string' ? data.fields.gtin14 : undefined;
          results.push({ itemId, url, data, ...(records.length > 1 ? { records: records.slice(1) } : {}), gtin14 });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[resolve] ${sanitizeForLog(site)}/${sanitizeForLog(itemId)} failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
          failed.push(itemId);
        }
      }

      return { site, results, unsupported: false, failed, cooldown };
    },
  };
}
