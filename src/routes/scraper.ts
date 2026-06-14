import express from 'express';
import { scrapeMFC, scrapeGeneric, SITE_CONFIGS, ScrapeConfig, BrowserPool } from '../services/genericScraper.js';
import { sanitizeForLog, sanitizeObjectForLog, isValidMfcUrl } from '../utils/security.js';

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

    const scrapedData = await scrapeGeneric(url, config);

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

// MFC-specific endpoint (convenience wrapper)
router.post('/scrape/mfc', async (req, res) => {
  console.log('[SCRAPER API] Received MFC scrape request');

  try {
    const { url, mfcAuth } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: 'URL is required'
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

    // Check if it's a valid MFC URL (proper domain validation, not substring match)
    if (!isValidMfcUrl(url)) {
      return res.status(400).json({
        success: false,
        message: 'URL must be from myfigurecollection.net domain'
      });
    }

    console.log(`[SCRAPER API] Processing MFC URL: ${sanitizeForLog(url)}`); // lgtm[js/log-injection]
    if (mfcAuth) {
      console.log('[SCRAPER API] MFC authentication cookies provided');
    }

    const scrapedData = await scrapeMFC(url, mfcAuth);

    console.log('[SCRAPER API] MFC scraping completed:', sanitizeObjectForLog(scrapedData)); // lgtm[js/log-injection]
    
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

// Get available site configurations
router.get('/configs', (req, res) => {
  console.log('[SCRAPER API] Received configs request');

  res.json({
    success: true,
    data: SITE_CONFIGS
  });
});

// Get MFC cookie allowlist - used by frontend to generate dynamic cookie extraction script
// HttpOnly cookies (like cf_clearance) cannot be read by JavaScript and must be manually copied
router.get('/mfc/cookie-allowlist', (req, res) => {
  console.log('[SCRAPER API] Received MFC cookie allowlist request');

  const allowedCookies = process.env.MFC_ALLOWED_COOKIES
    ? process.env.MFC_ALLOWED_COOKIES.split(',').map(s => s.trim()).filter(s => s.length > 0)
    : ['PHPSESSID', 'sesUID', 'sesDID', 'cf_clearance'];

  // cf_clearance is HttpOnly (Cloudflare sets it) - JavaScript can't read it
  const httpOnlyCookies = ['cf_clearance'];

  res.json({
    success: true,
    data: {
      allowedCookies,
      // Cookies that can be extracted via document.cookie (JavaScript readable)
      scriptReadable: allowedCookies.filter(c => !httpOnlyCookies.includes(c)),
      // Cookies that must be manually copied from Application tab
      manualCopy: allowedCookies.filter(c => httpOnlyCookies.includes(c)),
    }
  });
});

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