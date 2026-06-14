/**
 * MFC Sync API Routes
 *
 * Endpoints for MFC collection synchronization:
 * - POST /sync/validate-cookies - Validate MFC session cookies
 * - POST /sync/export-csv - Export CSV from MFC Manager
 * - POST /sync/from-csv - Sync from user-provided CSV content
 * - POST /sync/full - Full sync (validate → export → parse → queue)
 * - GET /sync/status - Get queue status
 * - GET /sync/queue-stats - Get detailed queue statistics
 *
 * Session Management:
 * - GET /sync/sessions - List all sessions with status (paused, cooldown, failures)
 * - POST /sync/sessions/:sessionId/resume - Resume a paused session
 * - POST /sync/sessions/:sessionId/cancel-failed - Cancel failed items for a session
 */

import express from 'express';
import { sanitizeForLog, sanitizeObjectForLog } from '../utils/security.js';
import { validateMfcCookies, exportMfcCsv, MfcCookies } from '../services/mfcCsvExporter.js';
import { fetchUserLists, fetchListItems, fetchCollectionCategory } from '../services/mfcListsFetcher.js';
import { getScrapeQueue, resetScrapeQueue } from '../services/scrapeQueue.js';
import { executeMfcSync, syncFromCsv, getSyncStatus, parseMfcCsv } from '../services/syncOrchestrator.js';
import { getSessionManager } from '../services/sessionManager.js';

const router = express.Router();

// ============================================================================
// Cookie Validation
// ============================================================================

/**
 * POST /sync/validate-cookies
 * Validate MFC session cookies before starting a sync
 */
router.post('/validate-cookies', async (req, res) => {
  console.log('[SYNC API] Received cookie validation request');

  try {
    const { cookies } = req.body;

    if (!cookies) {
      return res.status(400).json({
        success: false,
        message: 'Cookies object is required'
      });
    }

    // Validate required cookies are present
    const requiredCookies = ['PHPSESSID', 'sesUID', 'sesDID'];
    const missingCookies = requiredCookies.filter(name => !cookies[name]);

    if (missingCookies.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required cookies: ${missingCookies.join(', ')}`
      });
    }

    const result = await validateMfcCookies(cookies as MfcCookies);

    console.log('[SYNC API] Cookie validation result:', result.valid ? 'valid' : 'invalid');

    res.json({
      success: true,
      data: result
    });

  } catch (error: any) {
    console.error('[SYNC API] Cookie validation error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Cookie validation failed'
    });
  }
});

// ============================================================================
// CSV Export
// ============================================================================

/**
 * POST /sync/export-csv
 * Export CSV from MFC Manager using cookies
 */
router.post('/export-csv', async (req, res) => {
  console.log('[SYNC API] Received CSV export request');

  try {
    const { cookies, options } = req.body;

    if (!cookies) {
      return res.status(400).json({
        success: false,
        message: 'Cookies object is required'
      });
    }

    const result = await exportMfcCsv(cookies as MfcCookies, options || {});

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error || 'CSV export failed'
      });
    }

    console.log(`[SYNC API] CSV export successful: ${result.itemCount} items`);

    res.json({
      success: true,
      data: {
        itemCount: result.itemCount,
        // Don't return full CSV content in response to avoid large payloads
        // Client can request full sync instead
        preview: result.csvContent?.substring(0, 1000)
      }
    });

  } catch (error: any) {
    console.error('[SYNC API] CSV export error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'CSV export failed'
    });
  }
});

// ============================================================================
// CSV Parsing (without queueing)
// ============================================================================

/**
 * POST /sync/parse-csv
 * Parse CSV content and return structured items without queueing
 */
router.post('/parse-csv', async (req, res) => {
  console.log('[SYNC API] Received CSV parse request');

  try {
    const { csvContent } = req.body;

    if (!csvContent) {
      return res.status(400).json({
        success: false,
        message: 'csvContent is required'
      });
    }

    if (typeof csvContent !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'csvContent must be a string'
      });
    }

    const items = parseMfcCsv(csvContent);

    // Calculate stats
    const stats = {
      owned: items.filter(i => i.status === 'owned').length,
      ordered: items.filter(i => i.status === 'ordered').length,
      wished: items.filter(i => i.status === 'wished').length,
      total: items.length,
      nsfw: items.filter(i => i.isNsfw).length
    };

    console.log(`[SYNC API] Parsed ${items.length} items from CSV`);

    res.json({
      success: true,
      data: {
        items,
        stats
      }
    });

  } catch (error: any) {
    console.error('[SYNC API] CSV parse error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'CSV parsing failed'
    });
  }
});

// ============================================================================
// Sync from User-Provided CSV
// ============================================================================

/**
 * POST /sync/from-csv
 * Sync from user-uploaded CSV content
 */
router.post('/from-csv', async (req, res) => {
  console.log('[SYNC API] Received sync-from-CSV request');

  try {
    const { csvContent, userId, cookies, sessionId } = req.body;

    if (!csvContent) {
      return res.status(400).json({
        success: false,
        message: 'csvContent is required'
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required'
      });
    }

    const result = await syncFromCsv(csvContent, userId, {
      cookies: cookies as MfcCookies | undefined,
      sessionId
    });

    console.log(`[SYNC API] CSV sync complete: ${result.queuedItems} queued, ${result.skippedItems} deduped`);

    res.json({
      success: result.success,
      data: {
        parsedCount: result.parsedItems.length,
        queuedCount: result.queuedItems,
        skippedCount: result.skippedItems,
        stats: result.stats,
        errors: result.errors
      }
    });

  } catch (error: any) {
    console.error('[SYNC API] CSV sync error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'CSV sync failed'
    });
  }
});

// ============================================================================
// Full Sync
// ============================================================================

/**
 * POST /sync/full
 * Execute full sync: validate → export → parse → queue
 *
 * If webhookUrl and webhookSecret are provided, the scraper will send
 * webhook callbacks to the backend as items are processed.
 */
router.post('/full', async (req, res) => {
  console.log('[SYNC API] Received full sync request');

  try {
    const { cookies, userId, sessionId, includeLists, skipCached, statusFilter, webhookUrl, webhookSecret } = req.body;

    if (!cookies) {
      return res.status(400).json({
        success: false,
        message: 'Cookies object is required'
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required'
      });
    }

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'sessionId is required'
      });
    }

    // Build webhook config if provided
    const webhookConfig = webhookUrl && webhookSecret ? {
      webhookUrl,
      webhookSecret,
      sessionId
    } : undefined;

    const result = await executeMfcSync({
      cookies: cookies as MfcCookies,
      userId,
      sessionId,
      includeLists: includeLists ?? false,
      skipCached: skipCached ?? true,
      statusFilter: statusFilter as ('owned' | 'ordered' | 'wished')[] | undefined,
      webhookConfig
    });

    console.log(`[SYNC API] Full sync complete: ${result.queuedItems} queued`);

    res.json({
      success: result.success,
      data: {
        parsedCount: result.parsedItems.length,
        queuedCount: result.queuedItems,
        skippedCount: result.skippedItems,
        listsFound: result.lists?.length,
        stats: result.stats,
        errors: result.errors
      }
    });

  } catch (error: any) {
    console.error('[SYNC API] Full sync error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Full sync failed'
    });
  }
});

// ============================================================================
// Lists Endpoints
// ============================================================================

/**
 * POST /sync/lists
 * Fetch user's lists from MFC
 */
router.post('/lists', async (req, res) => {
  console.log('[SYNC API] Received lists fetch request');

  try {
    const { cookies, includePrivate } = req.body;

    if (!cookies) {
      return res.status(400).json({
        success: false,
        message: 'Cookies object is required'
      });
    }

    const result = await fetchUserLists(cookies as MfcCookies, includePrivate ?? true);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error || 'Lists fetch failed'
      });
    }

    console.log(`[SYNC API] Found ${result.lists?.length || 0} lists`);

    res.json({
      success: true,
      data: {
        lists: result.lists
      }
    });

  } catch (error: any) {
    console.error('[SYNC API] Lists fetch error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Lists fetch failed'
    });
  }
});

/**
 * POST /sync/list/:listId
 * Fetch items from a specific list
 */
router.post('/list/:listId', async (req, res) => {
  console.log(`[SYNC API] Received list items request for list ${JSON.stringify(req.params.listId)}`);

  try {
    const { listId } = req.params;
    const { cookies } = req.body;

    if (!listId || !/^\d+$/.test(listId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid listId is required'
      });
    }

    const result = await fetchListItems(listId, cookies as MfcCookies | undefined);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error || 'List items fetch failed'
      });
    }

    console.log(`[SYNC API] Found ${result.items?.length || 0} items in list ${listId}`);

    res.json({
      success: true,
      data: {
        listName: result.listName,
        totalItems: result.totalItems,
        items: result.items
      }
    });

  } catch (error: any) {
    console.error('[SYNC API] List items fetch error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'List items fetch failed'
    });
  }
});

/**
 * POST /sync/collection/:category
 * Fetch items from a collection category (owned/ordered/wished)
 */
router.post('/collection/:category', async (req, res) => {
  const { category } = req.params;
  console.log(`[SYNC API] Received collection fetch request for ${JSON.stringify(category)}`);

  try {
    const { cookies } = req.body;

    if (!cookies) {
      return res.status(400).json({
        success: false,
        message: 'Cookies object is required'
      });
    }

    if (!['owned', 'ordered', 'wished'].includes(category)) {
      return res.status(400).json({
        success: false,
        message: 'Category must be one of: owned, ordered, wished'
      });
    }

    const result = await fetchCollectionCategory(
      cookies as MfcCookies,
      category as 'owned' | 'ordered' | 'wished'
    );

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error || 'Collection fetch failed'
      });
    }

    console.log(`[SYNC API] Found ${result.items?.length || 0} ${category} items`);

    res.json({
      success: true,
      data: {
        category,
        totalItems: result.totalItems,
        items: result.items
      }
    });

  } catch (error: any) {
    console.error('[SYNC API] Collection fetch error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Collection fetch failed'
    });
  }
});

// ============================================================================
// Queue Status
// ============================================================================

/**
 * GET /sync/status
 * Get current sync/queue status
 */
router.get('/status', (req, res) => {
  console.log('[SYNC API] Status request');

  try {
    const status = getSyncStatus();

    res.json({
      success: true,
      data: status
    });

  } catch (error: any) {
    console.error('[SYNC API] Status error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get status'
    });
  }
});

/**
 * GET /sync/queue-stats
 * Get detailed queue statistics
 */
router.get('/queue-stats', (req, res) => {
  console.log('[SYNC API] Queue stats request');

  try {
    const queue = getScrapeQueue();
    const stats = queue.getStats();

    res.json({
      success: true,
      data: {
        queues: {
          hot: stats.hot,
          warm: stats.warm,
          cold: stats.cold
        },
        total: stats.total,
        processing: stats.processing,
        completed: stats.completed,
        failed: stats.failed,
        rateLimit: {
          active: stats.rateLimited,
          currentDelayMs: stats.currentDelay
        }
      }
    });

  } catch (error: any) {
    console.error('[SYNC API] Queue stats error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get queue stats'
    });
  }
});

// ============================================================================
// Session Management
// ============================================================================

/**
 * GET /sync/sessions
 * Get all active sessions with their status (paused, cooldown, failures)
 */
router.get('/sessions', (req, res) => {
  try {
    const sessionManager = getSessionManager();
    const sessions = sessionManager.getAllSessions();

    res.json({
      success: true,
      data: {
        sessions,
        count: sessions.length,
        pausedCount: sessions.filter(s => s.isPaused).length,
        inCooldownCount: sessions.filter(s => s.inCooldown).length,
      }
    });
  } catch (error: any) {
    console.error('[SYNC API] Get sessions error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get sessions'
    });
  }
});

/**
 * POST /sync/sessions/:sessionId/resume
 * Resume a paused session to continue processing
 */
router.post('/sessions/:sessionId/resume', (req, res) => {
  const { sessionId } = req.params;

  try {
    const queue = getScrapeQueue();
    const resumed = queue.resumeSession(sessionId);

    if (resumed) {
      console.log(`[SYNC API] Session ${JSON.stringify(sessionId.substring(0, 8))}... resumed`);
      res.json({
        success: true,
        message: 'Session resumed, processing will continue'
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'Session not found or not paused'
      });
    }
  } catch (error: any) {
    console.error('[SYNC API] Resume session error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to resume session'
    });
  }
});

/**
 * POST /sync/sessions/:sessionId/cancel-failed
 * Cancel all failed items for a session (removes them from queue)
 */
router.post('/sessions/:sessionId/cancel-failed', (req, res) => {
  const { sessionId } = req.params;

  try {
    const queue = getScrapeQueue();
    const cancelledCount = queue.cancelFailedItems(sessionId);

    console.log(`[SYNC API] Cancelled ${cancelledCount} failed items for session ${JSON.stringify(sessionId.substring(0, 8))}...`);
    res.json({
      success: true,
      message: `Cancelled ${cancelledCount} failed items`,
      data: { cancelledCount }
    });
  } catch (error: any) {
    console.error('[SYNC API] Cancel failed items error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to cancel items'
    });
  }
});

/**
 * DELETE /sync/sessions/:sessionId
 * Cancel ALL items for a session (complete abort)
 */
router.delete('/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  try {
    const queue = getScrapeQueue();
    const cancelledCount = queue.cancelAllForSession(sessionId);

    console.log(`[SYNC API] Cancelled all ${cancelledCount} items for session ${JSON.stringify(sessionId.substring(0, 8))}...`);
    res.json({
      success: true,
      message: `Cancelled ${cancelledCount} items`,
      data: { cancelledCount }
    });
  } catch (error: any) {
    console.error('[SYNC API] Cancel all items error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to cancel session'
    });
  }
});

// ============================================================================
// Queue Management (Development Only)
// ============================================================================

if (process.env.NODE_ENV !== 'production') {
  /**
   * POST /sync/queue/reset
   * Reset the scrape queue (development only)
   */
  router.post('/queue/reset', async (req, res) => {
    console.log('[SYNC API] Queue reset request');

    const adminToken = req.header('x-admin-token');
    const configuredToken = process.env.ADMIN_TOKEN;

    if (!configuredToken) {
      return res.status(500).json({
        success: false,
        message: 'Server configuration error'
      });
    }

    if (!adminToken || adminToken !== configuredToken) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden'
      });
    }

    try {
      resetScrapeQueue();

      res.json({
        success: true,
        message: 'Queue reset successfully'
      });

    } catch (error: any) {
      console.error('[SYNC API] Queue reset error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to reset queue'
      });
    }
  });
}

export default router;
