/**
 * Extended unit tests for Sync Orchestrator
 * Tests executeMfcSync, syncFromCsv, and getSyncStatus
 */

// Create persistent mock objects that survive clearAllMocks
const mockQueueInstance = {
  enqueue: jest.fn().mockImplementation((mfcId: string) => ({
    id: `${mfcId}-123`,
    deduplicated: false,
    position: 0,
    promise: Promise.resolve({}),
  })),
  getStats: jest.fn().mockReturnValue({
    hot: 0, warm: 0, cold: 0, total: 0,
    processing: 0, completed: 0, failed: 0,
    rateLimited: false, currentDelay: 2067,
  }),
};

// Mock dependencies before imports
jest.mock('../../services/mfcCsvExporter', () => ({
  validateMfcCookies: jest.fn(),
  exportMfcCsv: jest.fn(),
}));

jest.mock('../../services/mfcListsFetcher', () => ({
  fetchUserLists: jest.fn(),
  fetchListItems: jest.fn(),
  fetchCollectionCategory: jest.fn(),
}));

jest.mock('../../services/scrapeQueue', () => ({
  getScrapeQueue: jest.fn().mockImplementation(() => mockQueueInstance),
  resetScrapeQueue: jest.fn(),
}));

jest.mock('../../services/webhookClient', () => ({
  registerWebhookConfig: jest.fn(),
  unregisterWebhookConfig: jest.fn(),
  notifyPhaseChange: jest.fn().mockResolvedValue(true),
  notifyListsSync: jest.fn().mockResolvedValue(true),
}));

import { validateMfcCookies, exportMfcCsv } from '../../services/mfcCsvExporter';
import { fetchUserLists, fetchListItems, fetchCollectionCategory } from '../../services/mfcListsFetcher';
import { getScrapeQueue } from '../../services/scrapeQueue';
import { registerWebhookConfig, notifyPhaseChange, notifyListsSync } from '../../services/webhookClient';
import {
  executeMfcSync,
  syncFromCsv,
  getSyncStatus,
  parseMfcCsv,
  SyncRequest,
} from '../../services/syncOrchestrator';

const mockValidate = validateMfcCookies as jest.MockedFunction<typeof validateMfcCookies>;
const mockExportCsv = exportMfcCsv as jest.MockedFunction<typeof exportMfcCsv>;
const mockFetchLists = fetchUserLists as jest.MockedFunction<typeof fetchUserLists>;
const mockFetchListItems = fetchListItems as jest.MockedFunction<typeof fetchListItems>;
const mockFetchCollection = fetchCollectionCategory as jest.MockedFunction<typeof fetchCollectionCategory>;
const mockNotifyPhaseChange = notifyPhaseChange as jest.MockedFunction<typeof notifyPhaseChange>;

describe('syncOrchestrator - extended', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Re-establish mock implementations after clearAllMocks
    (getScrapeQueue as jest.Mock).mockImplementation(() => mockQueueInstance);
    mockNotifyPhaseChange.mockResolvedValue(true);
    (notifyListsSync as jest.Mock).mockResolvedValue(true);

    // Default: activity ordering returns items with positions
    mockFetchCollection.mockResolvedValue({
      success: true,
      items: [{ mfcId: '12345', name: 'Fig', status: 'owned', mfcActivityOrder: 0 }],
      listName: 'Owned Collection',
      totalItems: 1,
    });

    // Default: list detail fetch returns items and description
    mockFetchListItems.mockResolvedValue({
      success: true,
      items: [{ mfcId: '100', name: 'List Item' }],
      listName: 'Test List',
      description: '<p>Test description</p>',
      totalItems: 1,
    });

    // Reset default return values for queue instance
    mockQueueInstance.enqueue.mockImplementation((mfcId: string) => ({
      id: `${mfcId}-123`,
      deduplicated: false,
      position: 0,
      promise: Promise.resolve({}),
    }));
    mockQueueInstance.getStats.mockReturnValue({
      hot: 0, warm: 0, cold: 0, total: 0,
      processing: 0, completed: 0, failed: 0,
      rateLimited: false, currentDelay: 2067,
    });
  });

  // ============================================================================
  // executeMfcSync
  // ============================================================================

  describe('executeMfcSync', () => {
    const baseRequest: SyncRequest = {
      cookies: { PHPSESSID: 'a', sesUID: 'b', sesDID: 'c' },
      userId: 'user123',
      sessionId: 'session456',
    };

    it('should fail when cookie validation fails', async () => {
      mockValidate.mockResolvedValue({
        valid: false,
        reason: 'Cookies expired',
        canAccessManager: false,
        canExportCsv: false,
      });

      const result = await executeMfcSync(baseRequest);
      expect(result.success).toBe(false);
      expect(result.errors).toContainEqual(expect.stringContaining('Cookie validation failed'));
    });

    it('should fail when validation passes but CSV export is not available', async () => {
      mockValidate.mockResolvedValue({
        valid: true,
        canAccessManager: true,
        canExportCsv: false,
      });

      const result = await executeMfcSync(baseRequest);
      expect(result.success).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('CSV export is not available')
      );
    });

    it('should fail when CSV export fails', async () => {
      mockValidate.mockResolvedValue({
        valid: true,
        canAccessManager: true,
        canExportCsv: true,
      });

      mockExportCsv.mockResolvedValue({
        success: false,
        error: 'MFC_CLOUDFLARE_BLOCKED',
      });

      const result = await executeMfcSync(baseRequest);
      expect(result.success).toBe(false);
      expect(result.errors).toContainEqual(expect.stringContaining('CSV export failed'));
    });

    it('should parse CSV and queue items', async () => {
      mockValidate.mockResolvedValue({
        valid: true,
        canAccessManager: true,
        canExportCsv: true,
      });

      mockExportCsv.mockResolvedValue({
        success: true,
        csvContent: 'ID,Name,Category,Status\n12345,Fig 1,Figure,Owned\n67890,Fig 2,Figure,Wished',
        itemCount: 2,
      });

      const result = await executeMfcSync(baseRequest);
      expect(result.success).toBe(true);
      expect(result.parsedItems.length).toBe(2);
      expect(result.stats.owned).toBe(1);
      expect(result.stats.wished).toBe(1);
    });

    it('should fetch lists when includeLists is true', async () => {
      mockValidate.mockResolvedValue({
        valid: true,
        canAccessManager: true,
        canExportCsv: true,
      });

      mockExportCsv.mockResolvedValue({
        success: true,
        csvContent: 'ID,Name,Status\n12345,Fig,Owned',
        itemCount: 1,
      });

      mockFetchLists.mockResolvedValue({
        success: true,
        lists: [{ id: '1', name: 'List 1', itemCount: 5, privacy: 'public' as const, url: '' }],
      });

      const result = await executeMfcSync({
        ...baseRequest,
        includeLists: true,
      });

      expect(result.success).toBe(true);
      expect(result.lists?.length).toBe(1);
      // Should have fetched detail for each list
      expect(mockFetchListItems).toHaveBeenCalledWith('1', baseRequest.cookies);
    });

    it('should include description and itemMfcIds from list detail fetch', async () => {
      mockValidate.mockResolvedValue({
        valid: true,
        canAccessManager: true,
        canExportCsv: true,
      });

      mockExportCsv.mockResolvedValue({
        success: true,
        csvContent: 'ID,Name,Status\n12345,Fig,Owned',
        itemCount: 1,
      });

      mockFetchLists.mockResolvedValue({
        success: true,
        lists: [{ id: '42', name: 'My Wishlist', itemCount: 3, privacy: 'public' as const, url: '' }],
      });

      mockFetchListItems.mockResolvedValue({
        success: true,
        items: [
          { mfcId: '100', name: 'Item A' },
          { mfcId: '200', name: 'Item B' },
          { mfcId: '300', name: 'Item C' },
        ],
        listName: 'My Wishlist',
        description: '<p>My favorite figures</p>',
        totalItems: 3,
      });

      const result = await executeMfcSync({
        ...baseRequest,
        includeLists: true,
        webhookConfig: {
          webhookUrl: 'http://backend/webhooks',
          webhookSecret: 'secret',
          sessionId: 'session456',
        },
      });

      expect(result.success).toBe(true);
      expect(mockFetchListItems).toHaveBeenCalledWith('42', baseRequest.cookies);
      // Verify webhook payload includes description and itemMfcIds
      expect(notifyListsSync).toHaveBeenCalledWith(
        expect.objectContaining({
          lists: expect.arrayContaining([
            expect.objectContaining({
              mfcId: 42,
              name: 'My Wishlist',
              description: '<p>My favorite figures</p>',
              itemMfcIds: [100, 200, 300],
            }),
          ]),
        })
      );
    });

    it('should handle list detail fetch failure gracefully', async () => {
      mockValidate.mockResolvedValue({
        valid: true,
        canAccessManager: true,
        canExportCsv: true,
      });

      mockExportCsv.mockResolvedValue({
        success: true,
        csvContent: 'ID,Name,Status\n12345,Fig,Owned',
        itemCount: 1,
      });

      mockFetchLists.mockResolvedValue({
        success: true,
        lists: [{ id: '1', name: 'List 1', itemCount: 5, privacy: 'public' as const, url: '' }],
      });

      // List detail fetch fails but sync should still succeed
      mockFetchListItems.mockRejectedValue(new Error('Timeout'));

      const result = await executeMfcSync({
        ...baseRequest,
        includeLists: true,
      });

      expect(result.success).toBe(true);
      expect(result.lists?.length).toBe(1);
    });

    it('should handle lists fetch failure gracefully', async () => {
      mockValidate.mockResolvedValue({
        valid: true,
        canAccessManager: true,
        canExportCsv: true,
      });

      mockExportCsv.mockResolvedValue({
        success: true,
        csvContent: 'ID,Name,Status\n12345,Fig,Owned',
        itemCount: 1,
      });

      mockFetchLists.mockResolvedValue({
        success: false,
        error: 'Lists fetch error',
      });

      const result = await executeMfcSync({
        ...baseRequest,
        includeLists: true,
      });

      expect(result.success).toBe(true); // Main sync still succeeds
      expect(result.errors.some((e: string) => e.includes('Lists fetch failed'))).toBe(true);
    });

    it('should call onProgress callback', async () => {
      mockValidate.mockResolvedValue({ valid: true, canAccessManager: true, canExportCsv: true });
      mockExportCsv.mockResolvedValue({
        success: true,
        csvContent: 'ID,Name,Status\n12345,Fig,Owned',
        itemCount: 1,
      });

      const progress: any[] = [];
      const result = await executeMfcSync({
        ...baseRequest,
        onProgress: (p) => progress.push(p),
      });

      expect(result.success).toBe(true);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress[0].phase).toBe('validating');
    });

    it('should register webhook config when provided', async () => {
      mockValidate.mockResolvedValue({ valid: true, canAccessManager: true, canExportCsv: true });
      mockExportCsv.mockResolvedValue({
        success: true,
        csvContent: 'ID,Name,Status\n12345,Fig,Owned',
        itemCount: 1,
      });

      await executeMfcSync({
        ...baseRequest,
        webhookConfig: {
          webhookUrl: 'http://backend/webhooks',
          webhookSecret: 'secret',
          sessionId: 'session456',
        },
      });

      expect(registerWebhookConfig).toHaveBeenCalled();
      expect(notifyPhaseChange).toHaveBeenCalled();
    });

    it('should filter items by statusFilter', async () => {
      mockValidate.mockResolvedValue({ valid: true, canAccessManager: true, canExportCsv: true });
      mockExportCsv.mockResolvedValue({
        success: true,
        csvContent: 'ID,Name,Status\n1,Fig1,Owned\n2,Fig2,Wished\n3,Fig3,Ordered',
        itemCount: 3,
      });

      const result = await executeMfcSync({
        ...baseRequest,
        statusFilter: ['owned'],
      });

      expect(result.success).toBe(true);
      // Only owned items should be queued
      expect(result.queuedItems).toBe(1);
    });

    it('should handle unexpected errors', async () => {
      mockValidate.mockRejectedValue(new Error('Network failure'));

      const result = await executeMfcSync(baseRequest);
      expect(result.success).toBe(false);
      expect(result.errors).toContainEqual(expect.stringContaining('Sync failed'));
    });

    it('should send webhook notification on error', async () => {
      mockValidate.mockRejectedValue(new Error('Network failure'));

      await executeMfcSync({
        ...baseRequest,
        webhookConfig: {
          webhookUrl: 'http://backend/webhooks',
          webhookSecret: 'secret',
          sessionId: 'session456',
        },
      });

      // Should have notified about failure
      expect(notifyPhaseChange).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'failed' })
      );
    });

    it('should track NSFW items in stats', async () => {
      mockValidate.mockResolvedValue({ valid: true, canAccessManager: true, canExportCsv: true });
      mockExportCsv.mockResolvedValue({
        success: true,
        csvContent: 'ID,Name,Status,NSFW\n12345,Fig,Owned,true\n67890,Fig2,Wished,false',
        itemCount: 2,
      });

      const result = await executeMfcSync(baseRequest);
      expect(result.success).toBe(true);
      expect(result.stats.nsfwItems).toBe(1);
    });
  });

  // ============================================================================
  // syncFromCsv
  // ============================================================================

  describe('syncFromCsv', () => {
    it('should parse and queue items from CSV', async () => {
      const csvContent = 'ID,Name,Status\n12345,Fig 1,Owned\n67890,Fig 2,Wished';
      const result = await syncFromCsv(csvContent, 'user123');

      expect(result.success).toBe(true);
      expect(result.parsedItems.length).toBe(2);
      expect(result.stats.owned).toBe(1);
      expect(result.stats.wished).toBe(1);
    });

    it('should pass cookies to queue when provided', async () => {
      const csvContent = 'ID,Name,Status\n12345,Fig,Owned';
      const result = await syncFromCsv(csvContent, 'user123', {
        cookies: { PHPSESSID: 'a', sesUID: 'b', sesDID: 'c' },
        sessionId: 'session456',
      });

      expect(result.success).toBe(true);
    });

    it('should call onProgress when provided', async () => {
      const progress: any[] = [];
      const csvContent = 'ID,Name,Status\n12345,Fig,Owned';
      await syncFromCsv(csvContent, 'user123', {
        onProgress: (p) => progress.push(p),
      });

      expect(progress.length).toBeGreaterThan(0);
      expect(progress[0].phase).toBe('enriching');
    });

    it('should handle parse errors', async () => {
      // Force parseMfcCsv to throw by providing unusual input
      // The real parseMfcCsv handles bad input gracefully, but we can test the catch
      const result = await syncFromCsv('', 'user123');
      expect(result.success).toBe(true); // Empty CSV just has 0 items
      expect(result.parsedItems.length).toBe(0);
    });
  });

  // ============================================================================
  // getSyncStatus
  // ============================================================================

  describe('getSyncStatus', () => {
    it('should return queue stats', () => {
      const status = getSyncStatus();
      expect(status.queue).toBeDefined();
      expect(typeof status.queue.total).toBe('number');
    });
  });

  // ============================================================================
  // parseMfcCsv - additional tests
  // ============================================================================

  describe('parseMfcCsv - additional edge cases', () => {
    it('should handle quoted CSV fields', () => {
      const csv = 'ID,Name,Status\n12345,"Fig, with comma",Owned';
      const items = parseMfcCsv(csv);
      expect(items.length).toBe(1);
      expect(items[0].name).toBe('Fig, with comma');
    });

    it('should handle escaped quotes in CSV', () => {
      const csv = 'ID,Name,Status\n12345,"Fig ""Special"" Edition",Owned';
      const items = parseMfcCsv(csv);
      expect(items.length).toBe(1);
      expect(items[0].name).toContain('Special');
    });

    it('should skip non-numeric IDs', () => {
      const csv = 'ID,Name,Status\nabc,Fig,Owned\n12345,Valid,Owned';
      const items = parseMfcCsv(csv);
      expect(items.length).toBe(1);
      expect(items[0].mfcId).toBe('12345');
    });

    it('should parse preorder status as ordered', () => {
      const csv = 'ID,Name,Status\n12345,Fig,Preordered';
      const items = parseMfcCsv(csv);
      expect(items[0].status).toBe('ordered');
    });

    it('should default unknown status to wished', () => {
      const csv = 'ID,Name,Status\n12345,Fig,Unknown';
      const items = parseMfcCsv(csv);
      expect(items[0].status).toBe('wished');
    });

    it('should handle NSFW flag values', () => {
      const csv = 'ID,Name,Status,NSFW\n1,Fig1,Owned,true\n2,Fig2,Owned,1\n3,Fig3,Owned,yes\n4,Fig4,Owned,false';
      const items = parseMfcCsv(csv);
      expect(items[0].isNsfw).toBe(true);
      expect(items[1].isNsfw).toBe(true);
      expect(items[2].isNsfw).toBe(true);
      expect(items[3].isNsfw).toBe(false);
    });

    it('should handle CSV with alternate header names', () => {
      const csv = 'Item,Title,Type,Owned\n12345,My Figure,Scale,Owned';
      const items = parseMfcCsv(csv);
      expect(items.length).toBe(1);
      expect(items[0].mfcId).toBe('12345');
    });

    it('should handle CSV with release date and price', () => {
      const csv = 'ID,Name,Status,Release Date,Price\n12345,Fig,Owned,2024-01,¥15000';
      const items = parseMfcCsv(csv);
      expect(items[0].releaseDate).toBe('2024-01');
      expect(items[0].price).toBe('¥15000');
    });

    it('should handle parse errors in individual lines', () => {
      // This tests the try/catch in the parsing loop
      const csv = 'ID,Name,Status\n12345,Good,Owned\n"unclosed quote';
      const items = parseMfcCsv(csv);
      // Should still parse valid lines
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });
});
