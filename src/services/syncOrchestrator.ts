/**
 * MFC Sync Orchestrator
 *
 * Orchestrates the full sync workflow:
 * 1. Validate cookies
 * 2. Export CSV from MFC
 * 3. Parse CSV to extract MFC IDs
 * 4. Fetch user's lists (optional)
 * 5. Queue items for enrichment scraping
 *
 * Maintains "fresh context" promise - cookies are used then discarded.
 */

import { MfcCookies, exportMfcCsv, validateMfcCookies, CsvExportResult } from './mfcCsvExporter';
import { fetchUserLists, fetchListItems, fetchCollectionCategory, MfcList, MfcListItem } from './mfcListsFetcher';
import { getScrapeQueue, QueuePriority, ItemStatus, EnqueueResult, QueueStats } from './scrapeQueue';
import { calculateCacheTtl, isCacheValid } from './cacheConfig';
import { sanitizeForLog } from '../utils/security';
import {
  registerWebhookConfig,
  unregisterWebhookConfig,
  notifyPhaseChange,
  notifyListsSync,
  WebhookConfig
} from './webhookClient';

/**
 * Allowlist of valid MFC cookie property names.
 * Only these keys will be copied from user-provided cookies.
 */
const VALID_COOKIE_KEYS = ['PHPSESSID', 'sesUID', 'sesDID', 'cf_clearance'];

/**
 * Convert MfcCookies to a queue-compatible Record<string, string>
 * Filters out undefined values since queue expects string values only.
 * Uses an allowlist of valid cookie names to prevent property injection.
 */
function toQueueCookies(cookies: MfcCookies): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of VALID_COOKIE_KEYS) {
    const value = (cookies as Record<string, string | undefined>)[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

// ============================================================================
// Types
// ============================================================================

export interface SyncRequest {
  /** MFC session cookies (ephemeral) */
  cookies: MfcCookies;
  /** User ID for tracking */
  userId: string;
  /** Session ID for cookie context */
  sessionId: string;
  /** Whether to fetch lists in addition to collection */
  includeLists?: boolean;
  /** Skip items already cached within TTL */
  skipCached?: boolean;
  /** Filter by collection status - if undefined/empty, sync all statuses */
  statusFilter?: ('owned' | 'ordered' | 'wished')[];
  /** Callback for progress updates */
  onProgress?: (progress: SyncProgress) => void;
  /** Webhook configuration for backend callbacks (optional) */
  webhookConfig?: WebhookConfig;
}

export interface SyncProgress {
  phase: 'validating' | 'exporting' | 'parsing' | 'fetching_activity_order' | 'fetching_lists' | 'queueing' | 'enriching' | 'completed' | 'failed';
  message: string;
  itemsProcessed?: number;
  itemsTotal?: number;
  itemsQueued?: number;
  listsFound?: number;
  errors?: string[];
}

export interface ParsedMfcItem {
  mfcId: string;
  name?: string;
  category?: string;
  status: ItemStatus;
  releaseDate?: string;
  price?: string;
  imageUrl?: string;
  isNsfw?: boolean;
  mfcActivityOrder?: number;
  isOrphan?: boolean;
}

export interface SyncResult {
  success: boolean;
  /** Items parsed from CSV */
  parsedItems: ParsedMfcItem[];
  /** Items queued for enrichment */
  queuedItems: number;
  /** Items skipped (already cached) */
  skippedItems: number;
  /** User's lists (if includeLists was true) */
  lists?: MfcList[];
  /** Any errors encountered */
  errors: string[];
  /** Statistics */
  stats: {
    owned: number;
    ordered: number;
    wished: number;
    totalFromCsv: number;
    nsfwItems: number;
  };
}

// ============================================================================
// CSV Parsing
// ============================================================================

/**
 * CSV field indices based on MFC export format
 * These may need adjustment if MFC changes their export format
 */
const CSV_FIELDS = {
  ID: 0,              // MFC ID
  NAME: 1,            // Item name
  CATEGORY: 2,        // Category (Figure, Goods, etc.)
  STATUS: 3,          // Owned, Ordered, Wished
  RELEASE_DATE: 4,    // Release date
  PRICE: 5,           // Price
  // Additional fields vary
} as const;

/**
 * Parse MFC CSV content into structured items
 */
export function parseMfcCsv(csvContent: string): ParsedMfcItem[] {
  const items: ParsedMfcItem[] = [];

  // Split into lines and skip header
  const lines = csvContent.split('\n');
  if (lines.length < 2) {
    console.log('[SYNC] CSV has no data rows');
    return items;
  }

  // Parse header to determine field positions
  const header = parseCSVLine(lines[0]);
  const fieldMap = mapCsvFields(header);

  console.log(`[SYNC] Parsing ${lines.length - 1} CSV rows`);

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const fields = parseCSVLine(line);
      const item = parseItemFromFields(fields, fieldMap);

      if (item) {
        items.push(item);
      }
    } catch (error) {
      console.warn(`[SYNC] Failed to parse CSV line ${i}: ${error}`);
    }
  }

  console.log(`[SYNC] Parsed ${items.length} items from CSV`);
  return items;
}

/**
 * Parse a single CSV line, handling quoted fields.
 * Line length is capped to prevent loop bound injection from unbounded iteration.
 */
const MAX_CSV_LINE_LENGTH = 100000; // reasonable upper bound for a CSV line
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  const safeLength = Math.min(line.length, MAX_CSV_LINE_LENGTH);
  for (let i = 0; i < safeLength; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  // Don't forget the last field
  fields.push(current.trim());

  return fields;
}

/**
 * Map header names to field indices
 */
function mapCsvFields(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};

  header.forEach((field, index) => {
    const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Map common field names
    if (normalized.includes('id') || normalized === 'item') {
      map.id = index;
    }
    if (normalized.includes('name') || normalized.includes('title')) {
      map.name = index;
    }
    if (normalized.includes('category') || normalized.includes('type')) {
      map.category = index;
    }
    if (normalized.includes('status') || normalized.includes('owned')) {
      map.status = index;
    }
    if (normalized.includes('release') || normalized.includes('date')) {
      map.releaseDate = index;
    }
    if (normalized.includes('price') || normalized.includes('cost')) {
      map.price = index;
    }
    if (normalized.includes('nsfw') || normalized.includes('adult')) {
      map.nsfw = index;
    }
  });

  return map;
}

/**
 * Parse a single item from CSV fields
 */
function parseItemFromFields(
  fields: string[],
  fieldMap: Record<string, number>
): ParsedMfcItem | null {
  // Extract MFC ID (required)
  const mfcId = fields[fieldMap.id ?? CSV_FIELDS.ID]?.trim();
  if (!mfcId || !/^\d+$/.test(mfcId)) {
    return null; // Invalid or missing ID
  }

  // Extract status
  const statusText = (fields[fieldMap.status ?? CSV_FIELDS.STATUS] || '').toLowerCase();
  let status: ItemStatus = 'wished';
  if (statusText.includes('owned')) {
    status = 'owned';
  } else if (statusText.includes('order') || statusText.includes('preorder')) {
    status = 'ordered';
  }

  // Build item
  const item: ParsedMfcItem = {
    mfcId,
    status,
    name: fields[fieldMap.name ?? CSV_FIELDS.NAME]?.trim(),
    category: fields[fieldMap.category ?? CSV_FIELDS.CATEGORY]?.trim(),
    releaseDate: fields[fieldMap.releaseDate ?? CSV_FIELDS.RELEASE_DATE]?.trim(),
    price: fields[fieldMap.price ?? CSV_FIELDS.PRICE]?.trim(),
  };

  // Check NSFW flag if available
  if (fieldMap.nsfw !== undefined) {
    const nsfwValue = fields[fieldMap.nsfw]?.toLowerCase();
    item.isNsfw = nsfwValue === 'true' || nsfwValue === '1' || nsfwValue === 'yes';
  }

  return item;
}

// ============================================================================
// Sync Orchestrator
// ============================================================================

/**
 * Execute a full MFC sync operation
 *
 * This orchestrates:
 * 1. Cookie validation
 * 2. CSV export from MFC
 * 3. CSV parsing
 * 4. (Optional) Lists fetching
 * 5. Queue items for enrichment
 *
 * @param request - Sync request with cookies and options
 * @returns Sync result with parsed items and queue status
 */
export async function executeMfcSync(request: SyncRequest): Promise<SyncResult> {
  const { cookies, userId, sessionId, includeLists = false, skipCached = true, statusFilter, onProgress, webhookConfig } = request;

  const result: SyncResult = {
    success: false,
    parsedItems: [],
    queuedItems: 0,
    skippedItems: 0,
    lists: undefined,
    errors: [],
    stats: {
      owned: 0,
      ordered: 0,
      wished: 0,
      totalFromCsv: 0,
      nsfwItems: 0,
    },
  };

  // Register webhook config if provided (for backend callbacks)
  if (webhookConfig) {
    registerWebhookConfig(webhookConfig);
    console.log(`[SYNC] Webhook registered for session ${JSON.stringify(sessionId)}`);
  }

  const reportProgress = async (progress: SyncProgress) => {
    console.log(`[SYNC] ${progress.phase}: ${progress.message}`);
    if (onProgress) {
      onProgress(progress);
    }

    // Send webhook notification for phase change (non-blocking)
    if (webhookConfig) {
      notifyPhaseChange({
        sessionId,
        phase: progress.phase,
        message: progress.message,
      }).catch(() => {
        console.warn(`[SYNC] Webhook notification failed for phase ${progress.phase}`);
      });
    }
  };

  try {
    // Phase 1: Validate cookies
    await reportProgress({
      phase: 'validating',
      message: 'Validating MFC session...',
    });

    const validation = await validateMfcCookies(cookies);
    if (!validation.valid) {
      result.errors.push(`Cookie validation failed: ${validation.reason}`);
      await reportProgress({
        phase: 'failed',
        message: `Validation failed: ${validation.reason}`,
        errors: result.errors,
      });
      return result;
    }

    if (!validation.canExportCsv) {
      result.errors.push('Cookie validation passed but CSV export is not available on the Manager page');
      await reportProgress({
        phase: 'failed',
        message: 'CSV export not available - session may be invalid or MFC page structure changed',
        errors: result.errors,
      });
      return result;
    }

    // Phase 2: Export CSV
    await reportProgress({
      phase: 'exporting',
      message: 'Exporting collection from MFC...',
    });

    const csvResult = await exportMfcCsv(cookies);
    if (!csvResult.success || !csvResult.csvContent) {
      result.errors.push(`CSV export failed: ${csvResult.error}`);
      await reportProgress({
        phase: 'failed',
        message: `Export failed: ${csvResult.error}`,
        errors: result.errors,
      });
      return result;
    }

    console.log(`[SYNC] CSV export successful: ${csvResult.itemCount} items`);

    // Phase 3: Parse CSV
    await reportProgress({
      phase: 'parsing',
      message: `Parsing ${csvResult.itemCount} items...`,
    });

    result.parsedItems = parseMfcCsv(csvResult.csvContent);
    result.stats.totalFromCsv = result.parsedItems.length;

    // Calculate stats
    for (const item of result.parsedItems) {
      if (item.status === 'owned') result.stats.owned++;
      else if (item.status === 'ordered') result.stats.ordered++;
      else result.stats.wished++;

      if (item.isNsfw) result.stats.nsfwItems++;
    }

    await reportProgress({
      phase: 'parsing',
      message: `Parsed ${result.parsedItems.length} items`,
      itemsProcessed: result.parsedItems.length,
      itemsTotal: result.parsedItems.length,
    });

    // Phase 3.5: Fetch activity ordering from collection pages
    // Browse MFC collection pages sorted by activity to capture the order items were added
    await reportProgress({
      phase: 'fetching_activity_order',
      message: 'Capturing collection activity ordering...',
    });

    const statusesToFetch: Array<'owned' | 'ordered' | 'wished'> = [];
    if (result.stats.owned > 0) statusesToFetch.push('owned');
    if (result.stats.ordered > 0) statusesToFetch.push('ordered');
    if (result.stats.wished > 0) statusesToFetch.push('wished');

    // If statusFilter is provided (even empty), respect it; undefined means sync all
    const activityStatuses = statusFilter !== undefined
      ? statusesToFetch.filter(s => statusFilter.includes(s))
      : statusesToFetch;

    for (const activityStatus of activityStatuses) {
      try {
        console.log(`[SYNC] Fetching activity ordering for ${activityStatus}...`);
        const activityResult = await fetchCollectionCategory(cookies, activityStatus);

        if (activityResult.success && activityResult.items) {
          // Build mfcId → mfcActivityOrder map from activity-sorted pages
          const orderMap = new Map<string, number>();
          for (const item of activityResult.items) {
            if (item.mfcActivityOrder !== undefined) {
              orderMap.set(item.mfcId, item.mfcActivityOrder);
            }
          }

          // Merge activity ordering into parsed items
          let merged = 0;
          for (const parsedItem of result.parsedItems) {
            if (parsedItem.status === activityStatus) {
              const order = orderMap.get(parsedItem.mfcId);
              if (order !== undefined) {
                parsedItem.mfcActivityOrder = order;
                merged++;
              }
            }
          }

          console.log(`[SYNC] Merged activity ordering for ${merged}/${result.stats[activityStatus === 'wished' ? 'wished' : activityStatus]} ${activityStatus} items`);
        } else {
          console.warn(`[SYNC] Activity ordering fetch failed for ${activityStatus}: ${activityResult.error}`);
          result.errors.push(`Activity ordering failed for ${activityStatus}: ${activityResult.error}`);
        }
      } catch (activityError: any) {
        console.warn(`[SYNC] Activity ordering error for ${activityStatus}: ${activityError.message}`);
        result.errors.push(`Activity ordering error for ${activityStatus}: ${activityError.message}`);
        // Non-fatal: continue sync without activity ordering
      }
    }

    await reportProgress({
      phase: 'fetching_activity_order',
      message: `Activity ordering captured for ${activityStatuses.join(', ')}`,
    });

    // Orphan items: list items not in the CSV collection (computed during Phase 4)
    let orphanItems: ParsedMfcItem[] = [];

    // Phase 4: Fetch lists (optional)
    if (includeLists) {
      await reportProgress({
        phase: 'fetching_lists',
        message: 'Fetching your lists...',
      });

      const listsResult = await fetchUserLists(cookies, true);
      if (listsResult.success && listsResult.lists) {
        result.lists = listsResult.lists;
        await reportProgress({
          phase: 'fetching_lists',
          message: `Found ${listsResult.lists.length} lists`,
          listsFound: listsResult.lists.length,
        });

        // Fetch detail pages (description + item IDs) for each list
        const listsWithDetails = await Promise.all(
          listsResult.lists.map(async (l) => {
            try {
              const detail = await fetchListItems(l.id, cookies);
              const itemMfcIds = detail.success && detail.items
                ? detail.items.map(item => parseInt(item.mfcId, 10)).filter(id => !isNaN(id))
                : undefined;
              // Preserve per-item metadata (name, imageUrl) scraped from list pages
              const itemDetails = detail.success && detail.items
                ? detail.items.map(item => ({
                    mfcId: parseInt(item.mfcId, 10),
                    name: item.name,
                    imageUrl: item.imageUrl,
                  })).filter(d => !isNaN(d.mfcId))
                : undefined;
              return {
                mfcId: parseInt(l.id, 10),
                name: l.name,
                teaser: l.teaser,
                description: detail.success ? detail.description : undefined,
                privacy: l.privacy,
                iconUrl: l.iconUrl,
                itemCount: l.itemCount,
                itemMfcIds,
                itemDetails,
                mfcCreatedAt: l.createdAt,
              };
            } catch (err: any) {
              console.warn(`[SYNC] Failed to fetch details for list ${l.id}: ${err.message}`);
              return {
                mfcId: parseInt(l.id, 10),
                name: l.name,
                teaser: l.teaser,
                privacy: l.privacy,
                iconUrl: l.iconUrl,
                itemCount: l.itemCount,
                mfcCreatedAt: l.createdAt,
              };
            }
          })
        );

        // Send lists to backend via webhook
        if (webhookConfig && listsWithDetails.length > 0) {
          await notifyListsSync({
            sessionId,
            lists: listsWithDetails,
          });
        }

        // Compute orphan items: MFC IDs that appear in lists but not in CSV collection.
        // These get enriched (MFCItem catalog entry) but NOT turned into user Figures.
        const collectionMfcIds = new Set(result.parsedItems.map(i => i.mfcId));
        const listMfcIds = new Set<string>();
        for (const list of listsWithDetails) {
          if (list.itemMfcIds) {
            for (const id of list.itemMfcIds) {
              listMfcIds.add(String(id));
            }
          }
        }

        for (const mfcId of listMfcIds) {
          if (!collectionMfcIds.has(mfcId)) {
            orphanItems.push({
              mfcId,
              status: 'wished' as ItemStatus,
              isOrphan: true,
            });
          }
        }

        if (orphanItems.length > 0) {
          console.log(`[SYNC] Found ${orphanItems.length} orphan list items to enrich`);
        }
      } else {
        result.errors.push(`Lists fetch failed: ${listsResult.error}`);
        console.warn(`[SYNC] Lists fetch failed: ${listsResult.error}`);
      }
    }

    // Phase 5: Queue items for enrichment
    await reportProgress({
      phase: 'queueing',
      message: 'Queueing items for enrichment...',
    });

    const queue = getScrapeQueue();
    const queueResults: EnqueueResult[] = [];

    // Filter items by status if statusFilter is provided (even empty = queue nothing)
    const itemsToQueue = statusFilter !== undefined
      ? result.parsedItems.filter(item => statusFilter.includes(item.status))
      : result.parsedItems;

    // Combine collection items with orphan list items for queueing
    const allItemsToQueue = [...itemsToQueue, ...orphanItems];

    const filterLabel = statusFilter !== undefined ? JSON.stringify(statusFilter) : '"all"';
    console.log(`[SYNC] Queueing ${allItemsToQueue.length} items (${itemsToQueue.length} collection + ${orphanItems.length} orphans, filter: ${filterLabel})`);

    // Send items list with queueing phase for backend SyncJob tracking
    if (webhookConfig) {
      await notifyPhaseChange({
        sessionId,
        phase: 'queueing',
        message: `Queueing ${allItemsToQueue.length} items for enrichment`,
        items: allItemsToQueue.map(item => ({
          mfcId: item.mfcId,
          name: item.name,
          collectionStatus: item.status,
          isNsfw: item.isNsfw,
          mfcActivityOrder: item.mfcActivityOrder,
          isOrphan: item.isOrphan,
        })),
      }).catch(() => {
        console.warn('[SYNC] Webhook notification failed for queueing phase with items');
      });
    };

    for (const item of allItemsToQueue) {
      // Skip cached items if requested
      if (skipCached) {
        // Note: In a real implementation, you'd check against your cache/DB here
        // For now, we queue everything
      }

      // Determine priority: orphans always COLD (background enrichment)
      let priority: QueuePriority = 'WARM';
      if (item.isOrphan) {
        priority = 'COLD'; // Orphan list items are background enrichment
      } else if (item.isNsfw) {
        priority = 'HOT'; // NSFW items highest priority
      } else if (item.status === 'wished') {
        priority = 'COLD'; // Wished items are lower priority
      }

      // Always pass cookies - needed for user-specific data (collection status, prices)
      // and required for NSFW content access
      const itemCookies = toQueueCookies(cookies);

      const enqueueResult = queue.enqueue(item.mfcId, {
        priority,
        status: item.status,
        cookies: itemCookies,
        sessionId,
        userId,
      });

      if (!enqueueResult.deduplicated) {
        result.queuedItems++;
      } else {
        result.skippedItems++;
      }

      queueResults.push(enqueueResult);
    }

    const queueStats = queue.getStats();

    await reportProgress({
      phase: 'queueing',
      message: `Queued ${result.queuedItems} items, ${result.skippedItems} deduplicated`,
      itemsQueued: result.queuedItems,
      itemsProcessed: result.parsedItems.length,
      itemsTotal: result.parsedItems.length,
    });

    // Queueing complete
    result.success = true;

    console.log(`[SYNC] Queueing complete: ${result.queuedItems} queued, ${result.skippedItems} deduped, ${result.errors.length} errors`);
    console.log(`[SYNC] Queue stats: HOT=${queueStats.hot}, WARM=${queueStats.warm}, COLD=${queueStats.cold}`);

    if (result.queuedItems === 0) {
      // No items to enrich — skip enriching phase and report completed immediately.
      // This happens when all items were deduplicated, or when statusFilter is empty
      // AND no orphan list items were found.
      const completedMessage = result.lists
        ? `Sync complete: ${result.lists.length} lists synced, no figures to enrich`
        : 'Sync complete: no figures to enrich';

      if (webhookConfig) {
        await notifyPhaseChange({
          sessionId,
          phase: 'completed',
          message: completedMessage,
        }).catch(() => {
          console.warn('[SYNC] Webhook notification failed for completed phase');
        });
      }

      await reportProgress({
        phase: 'completed',
        message: completedMessage,
        listsFound: result.lists?.length,
      });

      console.log(`[SYNC] ${completedMessage}`);
    } else {
      // Items queued — enrichment begins in background.
      // NOTE: Do NOT report 'completed' here! Items are still being processed.
      // The backend SyncJob.recalculateStats() will set phase to 'completed'
      // when all items are done (pending=0 && processing=0).

      if (webhookConfig) {
        await notifyPhaseChange({
          sessionId,
          phase: 'enriching',
          message: `Enriching ${result.queuedItems} items in background...`,
        }).catch(() => {
          console.warn('[SYNC] Webhook notification failed for enriching phase');
        });
      }

      await reportProgress({
        phase: 'enriching',
        message: `Enriching ${result.queuedItems} items in background...`,
        itemsQueued: result.queuedItems,
        itemsProcessed: 0, // No items processed yet - enrichment just starting
        itemsTotal: result.queuedItems,
        listsFound: result.lists?.length,
      });

      console.log(`[SYNC] Enrichment running in background - completion will be reported by backend when all items done`);
    }

    return result;

  } catch (error: any) {
    result.errors.push(`Sync failed: ${error.message}`);
    await reportProgress({
      phase: 'failed',
      message: `Sync failed: ${error.message}`,
      errors: result.errors,
    });

    // Notify backend of failure
    if (webhookConfig) {
      await notifyPhaseChange({
        sessionId,
        phase: 'failed',
        message: error.message,
      }).catch(() => {
        console.warn('[SYNC] Webhook notification failed for error phase');
      });
    }

    return result;
  }
  // NOTE: Do NOT unregister webhook here! Queue processing continues asynchronously
  // after this function returns. Webhook config should persist until:
  // 1. Session is explicitly cancelled (DELETE /sync/job/:sessionId)
  // 2. All items are processed and sync-complete is sent
  // 3. Session TTL expires (future enhancement)
}

/**
 * Quick sync from existing CSV content (no export needed)
 *
 * Use this when CSV is already available (e.g., from frontend upload)
 */
export async function syncFromCsv(
  csvContent: string,
  userId: string,
  options: {
    cookies?: MfcCookies;
    sessionId?: string;
    onProgress?: (progress: SyncProgress) => void;
  } = {}
): Promise<SyncResult> {
  const { cookies, sessionId, onProgress } = options;

  const result: SyncResult = {
    success: false,
    parsedItems: [],
    queuedItems: 0,
    skippedItems: 0,
    errors: [],
    stats: {
      owned: 0,
      ordered: 0,
      wished: 0,
      totalFromCsv: 0,
      nsfwItems: 0,
    },
  };

  try {
    // Parse CSV
    result.parsedItems = parseMfcCsv(csvContent);
    result.stats.totalFromCsv = result.parsedItems.length;

    // Calculate stats
    for (const item of result.parsedItems) {
      if (item.status === 'owned') result.stats.owned++;
      else if (item.status === 'ordered') result.stats.ordered++;
      else result.stats.wished++;

      if (item.isNsfw) result.stats.nsfwItems++;
    }

    // Queue items
    const queue = getScrapeQueue();

    for (const item of result.parsedItems) {
      let priority: QueuePriority = 'WARM';
      if (item.isNsfw) {
        priority = 'HOT';
      } else if (item.status === 'wished') {
        priority = 'COLD';
      }

      // Always pass cookies if available - needed for user-specific data
      const enqueueResult = queue.enqueue(item.mfcId, {
        priority,
        status: item.status,
        cookies: cookies ? toQueueCookies(cookies) : undefined,
        sessionId: cookies ? sessionId : undefined,
        userId,
      });

      if (!enqueueResult.deduplicated) {
        result.queuedItems++;
      } else {
        result.skippedItems++;
      }
    }

    result.success = true;

    // Report enriching phase - NOT completed!
    // Items are queued but not yet enriched. Backend will determine completion.
    if (onProgress) {
      onProgress({
        phase: 'enriching',
        message: `Enriching ${result.queuedItems} items from CSV...`,
        itemsQueued: result.queuedItems,
        itemsProcessed: 0, // No items processed yet
        itemsTotal: result.queuedItems,
      });
    }

    return result;

  } catch (error: any) {
    result.errors.push(`CSV sync failed: ${error.message}`);
    return result;
  }
}

/**
 * Get sync/queue status
 */
export function getSyncStatus(): {
  queue: QueueStats;
} {
  const queue = getScrapeQueue();
  return {
    queue: queue.getStats(),
  };
}
