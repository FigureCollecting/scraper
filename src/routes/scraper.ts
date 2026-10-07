import express from 'express';
import { scrapeGeneric, BrowserPool } from '../services/genericScraper.js';
import { sanitizeForLog, sanitizeObjectForLog } from '../utils/security.js';
import { sendOnHostClock, type ClockedSendDeps, type ClockedSendResult } from '../services/hostClockSend.js';

/**
 * The legacy /scrape route's in-process fetch on the shared per-host clock (QB-U30b caller 'scrape'):
 * on a clocked store host it waits for the host's next slot and runs the send block; a slot past the
 * wait cap is refused (nothing fetched). Any other host is fetched at once, as before.
 */
export function scrapeOnHostClock(url: string, config: unknown, deps: ClockedSendDeps = {}): Promise<ClockedSendResult<Awaited<ReturnType<typeof scrapeGeneric>>>> {
  return sendOnHostClock({ host: new URL(url).hostname, caller: 'scrape' }, () => scrapeGeneric(url, config as Parameters<typeof scrapeGeneric>[1]), deps);
}

const router = express.Router();

// Generic scraping endpoint
router.post('/scrape', async (req, res) => {
  console.log('[SCRAPER API] Received generic scrape request');
  
  try {
    const { url, config } = req.body;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        message: 'URL is required'
      });
    }
    
    if (!config) {
      return res.status(400).json({
        success: false,
        message: 'Config is required for generic scraping'
      });
    }
    
    // Validate URL format
    try {
      new URL(url);
    } catch (urlError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid URL format'
      });
    }
    
    console.log(`[SCRAPER API] Processing generic URL: ${sanitizeForLog(url)}`); // lgtm[js/log-injection]
    console.log('[SCRAPER API] Using config:', sanitizeObjectForLog(config)); // lgtm[js/log-injection]

    const sent = await scrapeOnHostClock(url, config);
    if (!sent.sent) {
      const waitMs = sent.refused ? sent.waitMs : 0;
      res.set('Retry-After', String(Math.max(1, Math.ceil(waitMs / 1000))));
      return res.status(503).json({
        success: false,
        message: `[HOST-CLOCK] ${sanitizeForLog(new URL(url).hostname)} refused a scrape send: its slot is ${waitMs} ms away, past the wait cap`,
      });
    }
    const scrapedData = sent.value;

    console.log('[SCRAPER API] Generic scraping completed:', sanitizeObjectForLog(scrapedData)); // lgtm[js/log-injection]
    
    res.json({
      success: true,
      data: scrapedData
    });
    
  } catch (error: any) {
    console.error('[SCRAPER API] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Scraping failed',
      error: error.message
    });
  }
});

// Site-specific scrape/workflow routes are registered by plugins at bootstrap
// (see pluginBootstrap.ts) — the engine itself only exposes the generic
// raw-fetch surface above.

// Only expose reset endpoint in non-production environments
if (process.env.NODE_ENV !== 'production') {
  // Browser pool reset endpoint (for testing only)
  // Protected with admin-only authentication
  router.post('/reset-pool', async (req, res) => {
    console.log('[SCRAPER API] Reset pool request received');
    
    // Require admin token for authentication
    const adminToken = req.header('x-admin-token');
    const configuredToken = process.env.ADMIN_TOKEN;
    
    if (!configuredToken) {
      console.error('[SCRAPER API] ADMIN_TOKEN not configured');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error'
      });
    }
    
    if (!adminToken || adminToken !== configuredToken) {
      console.log('[SCRAPER API] Unauthorized reset attempt');
      return res.status(403).json({
        success: false,
        message: 'Forbidden'
      });
    }
    
    console.log('[SCRAPER API] Authorized - resetting browser pool');
    
    try {
      await BrowserPool.reset();
      
      res.json({
        success: true,
        message: 'Browser pool reset successfully'
      });
    } catch (error: any) {
      console.error('[SCRAPER API] Error resetting pool:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to reset browser pool'
      });
    }
  });
}

export default router;