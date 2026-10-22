// Tracing must initialise before any instrumented module (express, http) is
// imported, so OpenTelemetry auto-instrumentation can patch them. Keep first.
import './tracing.js';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createRequire } from 'module';
import scraperRoutes from './routes/scraper.js';
import ingestRoutes from './routes/ingest.js';
import { createLookupRoute } from './routes/lookup.js';
import { createCatalogRoute } from './routes/catalog.js';
import { createHealthRoutes } from './routes/health.js';
import { getChallengeCooldown } from './services/challengeCooldown.js';
import { getCfCookieStore } from './services/cookieJar.js';
import { getHostClock, startHostClockSummary } from './services/hostClock.js';
import { getMaxPagesGuard } from './services/maxPagesGuard.js';
import { announcePoolDispatch, getPoolDispatch } from './services/poolDispatch.js';
import { LOOKUP_MIN_FETCH_MS, resolveLookupStoreTimeoutMs } from './driver/assembleLookup.js';
import { residentialEgressView } from './services/residentialEgress.js';
import { rawStoreView, flushRawCaptureSink } from './services/s3ObjectStore.js';
import { imageCaptureView } from './services/images/assembleImageCapture.js';
import { fetchFailureReportView } from './services/failureReporter.js';
import { captureReportView } from './services/captureReporter.js';
import { sessionCanaryView } from './services/sessionCanary.js';
import { cpuThrottlingView } from './services/cpuThrottling.js';
import { createEngineLookup, createEngineCatalog } from './services/engineLookup.js';
import { createResolveRoute } from './routes/resolve.js';
import { createEngineResolve } from './services/engineResolve.js';
import { createCapturingScrapingService } from './services/engineServices/capturingScrapingService.js';
import { scraperDebug } from './utils/logger.js';

// Import browser pool functionality
import { browserLaneView, initializeBrowserPool, BrowserPool } from './services/genericScraper.js';
import { bootstrapPlugins, pluginsView, settleDurableQueue, shutdownPlugins, type BootstrapPluginsResult } from './services/pluginBootstrap.js';
import type { ExtractionRegistryImpl } from './services/extractionRegistry.js';
import { getScrapeQueue } from './services/scrapeQueue.js';
import { createQueueStore } from './services/queueStore.js';
import { ScraperPlugin } from '@figurecollecting/scraper-plugin-contract';

dotenv.config();

// Read package.json for the version without a JSON import assertion (keeps the
// module graph pure ESM and sidesteps the experimental JSON-modules warning).
// Named `requireJson` (not `require`) so a CommonJS transpile of this file does
// not collide with the ambient module-level `require`.
const requireJson = createRequire(import.meta.url);
const packageJson = requireJson('../package.json') as { version: string };

const app = express();
const PORT = process.env.PORT || 3080;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoints — root/health/version, plus /health/detailed (browser-pool status, the
// per-host Cloudflare-challenge cooldowns currently open, and the stored-cookie jar's per-host view —
// names and stale flags, never values). Extracted to a route factory so the surface is unit-testable
// without booting the server.
app.use('/', createHealthRoutes({
  version: packageJson.version,
  getBrowserPoolHealth: () => BrowserPool.getHealth(),
  listChallengeCooldowns: () => getChallengeCooldown().list(),
  listCfCookies: () => getCfCookieStore().view(),
  getResidentialEgress: () => residentialEgressView(),
  getBrowserLane: () => browserLaneView(),
  getRawStore: () => rawStoreView(),
  getImageCapture: () => imageCaptureView(),
  getFailureLedger: () => fetchFailureReportView(),
  getCaptureLedger: () => captureReportView(),
  getSessionCanary: () => sessionCanaryView(),
  getCpuThrottling: () => cpuThrottlingView(),
  getQueueStore: () => getScrapeQueue().getQueueStoreView(),
  // The registry exists once the plugins have loaded; until then (and with no plugin) the list is [].
  listHandsOff: () => pluginRegistry?.handsOffView() ?? [],
  // Which plugins loaded and which were refused; both empty until the bootstrap has run.
  listPlugins: () => pluginsView(pluginBootstrap),
  // The shared host clock's send-time observer (QB-U30a): reads the same with the clock off.
  getHostClock: () => getHostClock().view(Date.now()),
  // The engine's maxPages guard (QB-U24): the /catalog pages it answered without a store fetch.
  getMaxPagesGuard: () => getMaxPagesGuard().view(Date.now()),
  // The queue's POOL-SELECT dispatch per host (QB-U19): zeros while SCRAPE_POOL_SELECT is off.
  getPool: () => getScrapeQueue().getPoolView(Date.now()),
}));

// Scraper routes (no /api prefix for consistency)
app.use('/', scraperRoutes);

// Ingest trigger route: POST /ingest/scrape enqueues a URL into the queue's
// plugin-extraction ingest path (registry -> fetch -> extract -> spine emit)
app.use('/', ingestRoutes);

// Plugins loaded at boot (populated by startServer, read by gracefulShutdown)
let loadedPlugins: ScraperPlugin[] = [];
// The plugin registry (populated by startServer, read by /health/detailed's handsOff)
let pluginRegistry: ExtractionRegistryImpl | undefined;
// The bootstrap's loaded and refused plugins (populated by startServer, read by /health/detailed's plugins)
let pluginBootstrap: BootstrapPluginsResult | undefined;

// Discover + register plugins (mounting their routes) before accepting
// connections, then start the server and initialize the browser pool.
async function startServer(): Promise<void> {
  // DURABLE SCRAPE QUEUE (SCRAPE_QUEUE_DIR, default /var/lib/scraper): open the backing store first,
  // so nothing can be enqueued before there is somewhere to write it. The RECONCILE deliberately
  // happens later — see the comment at settleDurableQueue() below.
  // Without a writable directory createQueueStore logs one warning and returns the in-memory
  // fallback: the engine then runs exactly as it did before, minus the durability.
  const queue = getScrapeQueue();
  queue.setQueueStore(createQueueStore());
  // POOL-SELECT DISPATCH (SCRAPE_POOL_SELECT, default off; QB-U19): a pooled host's next item is picked
  // from its whole class (resident and parked rows) instead of FIFO. Each refused knob value is a WARN,
  // and the boot line names the scope, the caps and this process's seed (picks replay from it). Logged
  // before anything can be dispatched, whatever the plugin bootstrap does next.
  announcePoolDispatch(getPoolDispatch());

  // STORED COOKIES (CF_COOKIE_FILE): load the hand-minted per-host cookie jar BEFORE any fetch can
  // run, and start its mtime poller so a re-minted file (a refreshed Secret) goes live without a
  // restart. Unset env ⇒ the store is disabled and this is a no-op. Never throws.
  getCfCookieStore().start();
  // The bootstrap whose registry reached the scrape queue; it stays undefined if bootstrapPlugins (or
  // threading its registry into the queue) threw, and the durable queue is then held below.
  let queueBootstrap: BootstrapPluginsResult | undefined;
  try {
    const bootstrap = await bootstrapPlugins(app);
    const { registry, plugins } = bootstrap;
    loadedPlugins = plugins;
    pluginRegistry = registry;
    pluginBootstrap = bootstrap;
    // Thread the plugin registry into the scrape queue so items whose URLs
    // resolve to a plugin ruleset take the ingest path (when INGEST_BASE_URL
    // is configured). The engine carries no extraction fallback — items with
    // no matching ruleset fail cleanly through the queue's failure handling.
    queue.setPluginRegistry(registry);
    queueBootstrap = bootstrap;
    // SHARED HOST CLOCK (SCRAPE_HOST_CLOCK, default off): a covered store host's own images are paced
    // on the clock its records book, at the floor the queue paces that host by (QB-U30a). Unbound, the
    // image lane leaves every host on its own limiter. The boot line names each covered host's floor,
    // a WARN names each listed entry the scope ignores, and the send-time observer (which reads the
    // same floor source, clock on or off) logs a summary line per host every 10 minutes.
    const hostClock = getHostClock();
    hostClock.setFloorSource(host => queue.storeHostFloorMs(host));
    for (const warning of hostClock.warnings()) console.warn(warning);
    console.log(hostClock.describe());
    // QB-U30b: the jitter per host with the process seed, and the store hosts blocking callers (and
    // /lookup, on its own budget) record rather than wait for (floor + jitter above the ceiling).
    const lookupBudget = { budgetMs: resolveLookupStoreTimeoutMs(process.env), minFetchMs: LOOKUP_MIN_FETCH_MS };
    for (const line of hostClock.bootLines(registry.allStores().flatMap(store => store.domains ?? []), lookupBudget)) console.log(line);
    startHostClockSummary(hostClock);
    // Mount the cross-store buy-decision search (GET /lookup) now that the registry is populated.
    // Each store fetches via the transport its `searchFetch` declares (http / impersonate / browser);
    // http + impersonate use the engine defaults, and the `browser` transport is backed here by the
    // pooled ScrapingService (wraps the static BrowserPool → shares the queue's pool). The surface
    // is RAW-CAPTURE-SINK backed (queue parity): /resolve's primary detail fetches and browser-lane
    // follow-ups navigate through it, and their wire+dom bytes must land in the raw store — a bare
    // createScrapingService() would default to a Noop sink and silently drop them.
    const lookupScraping = createCapturingScrapingService();
    app.use('/', createLookupRoute(createEngineLookup(registry, {
      browser: (url, opts) => lookupScraping.browserFetch(url, opts),
    })));
    // GET /catalog — one page of a store's newest-first catalog listing (the crawler's enumeration
    // feed). Same registry and transports as /lookup: the browser lane rides the same pooled,
    // capture-sink-backed ScrapingService. The maxPages guard (SCRAPE_CATALOG_MAX_PAGES_GUARD, default
    // off) names its scope at boot, with a WARN per listed entry it ignores.
    const pagesGuard = getMaxPagesGuard();
    for (const warning of pagesGuard.warnings()) console.warn(warning);
    console.log(pagesGuard.describe());
    app.use('/', createCatalogRoute(createEngineCatalog(registry, {
      browser: (url, opts) => lookupScraping.browserFetch(url, opts),
    })));
    // POST /resolve — byId confirm (detail fetch + extractRecords dispatch → full ExtractedData incl
    // gtin14), the matcher pass-2 bridge. Detail fetch shares the same pooled ScrapingService as
    // /lookup; that service also backs the ExtractContext (extractAsync/extractMany follow-ups ride
    // the store's declared transport — impit/http default inside createEngineResolve — into the
    // capture sink, courtesy-gapped, exactly like the ingest queue's extraction).
    // The detail fetch takes the browser-lane options createEngineResolve resolved from the store's
    // own `searchFetch` — residential `proxyServer` and client-rendered `waitFor`; a store declaring
    // neither is called with the url alone, and a residential store with no proxy configured never
    // reaches this lambda at all (the gate refuses it upstream).
    app.use('/', createResolveRoute(createEngineResolve(registry, (url, options) => lookupScraping.scrapePage(url, options), {
      scraping: lookupScraping,
    })));
    if (plugins.length > 0) {
      console.log(`[PAGE-SCRAPER] Loaded ${plugins.length} plugin(s): ${plugins.map(p => `${p.name}@${p.version}`).join(', ')}`);
    }
  } catch (error) {
    console.error('[PAGE-SCRAPER] Plugin bootstrap failed:', error);
  }
  // RECONCILE ONLY NOW, and only into a registry that came up WHOLE. A restored item is dispatched as
  // soon as it lands in a tier, and an item whose store has no ruleset fails EXTRACTION_UNAVAILABLE —
  // which is TERMINAL, not retryable — so restoring ahead of the registry, or into one missing a refused
  // plugin's stores, would delete the very batch it had just recovered. Otherwise (a plugin was refused
  // or failed to load, no store registered, or the bootstrap threw) settleDurableQueue HOLDS the queue:
  // the file is closed without being restored, for the next start, rather than burned against an engine
  // that cannot extract. A restore that throws holds it too, so it never stops the server listening.
  // The decision and its paths are unit-tested in pluginBootstrap.test.ts.
  settleDurableQueue(queue, queueBootstrap);

  app.listen(PORT, async () => {
    console.log(`[PAGE-SCRAPER] Server running on port ${PORT}`);
    console.log(`[PAGE-SCRAPER] Health check: http://localhost:${PORT}/health`);

    // Initialize browser pool in background
    console.log('[PAGE-SCRAPER] Initializing browser pool...');
    try {
      await initializeBrowserPool();
      console.log('[PAGE-SCRAPER] Browser pool ready!');
    } catch (error) {
      console.error('[PAGE-SCRAPER] Failed to initialize browser pool:', error);
    }
  });
}

startServer();

// Graceful shutdown - shut down plugins, then close browser pool to prevent file descriptor leaks
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[PAGE-SCRAPER] Received ${signal}, shutting down gracefully...`);

  try {
    console.log('[PAGE-SCRAPER] Shutting down plugins...');
    await shutdownPlugins(loadedPlugins);
    console.log('[PAGE-SCRAPER] Plugins shut down successfully');
  } catch (error) {
    console.error('[PAGE-SCRAPER] Error shutting down plugins:', error);
  }

  // Stop the queue and hand every LEASED row back as pending, so a PLANNED rollout loses nothing:
  // the next process finds the in-flight items ready and re-drives them immediately instead of
  // waiting out a lease whose holder no longer exists. Then close the store.
  try {
    const queue = getScrapeQueue();
    queue.stop();
    queue.releaseLeasesForShutdown();
    queue.closeQueueStore();
  } catch (error) {
    console.error('[PAGE-SCRAPER] Error closing the durable scrape queue:', error);
  }

  // Stop the stored-cookie file poller (an unref'd timer — this is hygiene, not a shutdown blocker).
  getCfCookieStore().stop();

  // Drain whatever the raw-capture queue is still holding. Those captures were
  // ACCEPTED, and they are write-once bytes with nothing anywhere that would fetch
  // them again — but the wait is bounded, and what we cannot flush is named.
  const flushed = await flushRawCaptureSink();
  if (!flushed.drained) {
    console.warn(`[PAGE-SCRAPER] Raw-capture queue not fully drained — ${flushed.abandoned} capture(s) abandoned`);
  }

  try {
    console.log('[PAGE-SCRAPER] Closing browser pool...');
    await BrowserPool.closeAll();
    console.log('[PAGE-SCRAPER] Browser pool closed successfully');
  } catch (error) {
    console.error('[PAGE-SCRAPER] Error closing browser pool:', error);
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Export app for testing
export default app;