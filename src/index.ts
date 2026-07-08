// Tracing must initialise before any instrumented module (express, http) is
// imported, so OpenTelemetry auto-instrumentation can patch them. Keep first.
import './tracing.js';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createRequire } from 'module';
import scraperRoutes from './routes/scraper.js';
import syncRoutes from './routes/sync.js';
import { scraperDebug } from './utils/logger.js';

// Import browser pool functionality
import { initializeBrowserPool, BrowserPool } from './services/genericScraper.js';

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

// Health check endpoints
const healthResponse = () => ({
  service: 'scraper',
  version: packageJson.version,
  status: 'healthy'
});

// Root endpoint for health checks (Docker health checks hit this)
app.get('/', (req, res) => {
  res.json(healthResponse());
});

app.get('/health', (req, res) => {
  res.json(healthResponse());
});

// Detailed health endpoint with browser pool status (for debugging)
app.get('/health/detailed', async (req, res) => {
  try {
    const browserPoolHealth = await BrowserPool.getHealth();
    res.json({
      ...healthResponse(),
      browserPool: browserPoolHealth,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      ...healthResponse(),
      status: 'degraded',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Version endpoint
app.get('/version', (req, res) => {
  res.json({
    name: 'scraper',
    version: packageJson.version,
    status: 'ok'
  });
});

// Scraper routes (no /api prefix for consistency)
app.use('/', scraperRoutes);

// Sync routes for MFC collection synchronization
app.use('/sync', syncRoutes);

// Start server and initialize browser pool
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

// Graceful shutdown - properly close browser pool to prevent file descriptor leaks
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[PAGE-SCRAPER] Received ${signal}, shutting down gracefully...`);

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