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
import { residentialEgressView } from './services/residentialEgress.js';
import { rawStoreView } from './services/s3ObjectStore.js';
import { fetchFailureReportView } from './services/failureReporter.js';
import { createEngineLookup, createEngineCatalog } from './services/engineLookup.js';
import { createResolveRoute } from './routes/resolve.js';
import { createEngineResolve } from './services/engineResolve.js';
import { createCapturingScrapingService } from './services/engineServices/capturingScrapingService.js';
import { scraperDebug } from './utils/logger.js';

// Import browser pool functionality
import { browserLaneView, initializeBrowserPool, BrowserPool } from './services/genericScraper.js';
import { bootstrapPlugins, shutdownPlugins } from './services/pluginBootstrap.js';
import { getScrapeQueue } from './services/scrapeQueue.js';
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
  getFailureLedger: () => fetchFailureReportView(),
}));

// Scraper routes (no /api prefix for consistency)
app.use('/', scraperRoutes);

// Ingest trigger route: POST /ingest/scrape enqueues a URL into the queue's
// plugin-extraction ingest path (registry -> fetch -> extract -> spine emit)
app.use('/', ingestRoutes);

// Plugins loaded at boot (populated by startServer, read by gracefulShutdown)
let loadedPlugins: ScraperPlugin[] = [];

// Discover + register plugins (mounting their routes) before accepting
// connections, then start the server and initialize the browser pool.
async function startServer(): Promise<void> {
  // STORED COOKIES (CF_COOKIE_FILE): load the hand-minted per-host cookie jar BEFORE any fetch can
  // run, and start its mtime poller so a re-minted file (a refreshed Secret) goes live without a
  // restart. Unset env ⇒ the store is disabled and this is a no-op. Never throws.
  getCfCookieStore().start();
  try {
    const { registry, plugins } = await bootstrapPlugins(app);
    loadedPlugins = plugins;
    // Thread the plugin registry into the scrape queue so items whose URLs
    // resolve to a plugin ruleset take the ingest path (when INGEST_BASE_URL
    // is configured). The engine carries no extraction fallback — items with
    // no matching ruleset fail cleanly through the queue's failure handling.
    getScrapeQueue().setPluginRegistry(registry);
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
    // capture-sink-backed ScrapingService.
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

  // Stop the stored-cookie file poller (an unref'd timer — this is hygiene, not a shutdown blocker).
  getCfCookieStore().stop();

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