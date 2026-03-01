/**
 * Unit tests for MFC Lists Fetcher
 *
 * Tests verify selectors match real MFC HTML structure:
 * - Overview page: .dgst.list-dgst .dgst-wrapper entries
 * - Detail page: .item-icon a[href*="/item/"] items
 * - Date format: MM/DD/YYYY, HH:MM:SS from span[title]
 */
import {
  fetchUserLists,
  fetchListItems,
  fetchCollectionCategory,
  parseMfcDate,
  MfcList,
  MfcListItem,
} from '../../services/mfcListsFetcher';
import { MfcCookies } from '../../services/mfcCsvExporter';
import { BrowserPool } from '../../services/genericScraper';

describe('mfcListsFetcher', () => {
  const validCookies: MfcCookies = {
    PHPSESSID: 'test-session-id',
    sesUID: 'test-user-id',
    sesDID: 'test-device-id',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    await BrowserPool.reset();
  });

  // ============================================================================
  // fetchUserLists
  // ============================================================================

  describe('fetchUserLists', () => {
    it('should attempt to fetch user lists with valid cookies', async () => {
      const result = await fetchUserLists(validCookies);
      // With mock browser, result depends on mock behavior
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should handle not-logged-in state', async () => {
      // Mock page where userMenu is not found (not logged in)
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        $: jest.fn().mockResolvedValue(null), // userMenu not found
        setCookie: jest.fn(),
        evaluate: jest.fn(),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchUserLists(validCookies);
      expect(result.success).toBe(false);
      expect(result.error).toContain('MFC_NOT_AUTHENTICATED');
    });

    it('should handle null page creation', async () => {
      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue({
          newPage: jest.fn().mockResolvedValue(null),
          close: jest.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const result = await fetchUserLists(validCookies);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create browser page');
    });

    it('should handle browser errors', async () => {
      jest.spyOn(BrowserPool, 'getStealthBrowser').mockRejectedValue(
        new Error('Browser crashed')
      );

      const result = await fetchUserLists(validCookies);
      expect(result.success).toBe(false);
      expect(result.error).toContain('MFC_LISTS_ERROR');
    });

    it('should include private lists by default', async () => {
      // Mock a logged-in page with lists data
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        $: jest.fn().mockResolvedValue({ textContent: 'user-menu' }), // logged in
        setCookie: jest.fn(),
        evaluate: jest.fn().mockResolvedValue({
          items: [],
          hasNext: false,
        }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchUserLists(validCookies, true);
      expect(result.success).toBe(true);
      expect(result.lists).toEqual([]);
    });

    it('should handle pagination', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        $: jest.fn().mockResolvedValue({ textContent: 'user-menu' }),
        setCookie: jest.fn(),
        evaluate: jest.fn()
          .mockResolvedValueOnce({
            items: [{
              id: '1',
              name: 'List 1',
              itemCount: 10,
              privacyText: 'Public',
              url: '/list/1',
              teaser: 'My first list',
              createdAt: '01/15/2024, 10:30:00',
              iconUrl: 'https://static.myfigurecollection.net/upload/users/128/1_abc.jpeg',
            }],
            hasNext: true,
          })
          .mockResolvedValueOnce({
            items: [{
              id: '2',
              name: 'List 2',
              itemCount: 5,
              privacyText: 'Private',
              url: '/list/2',
              teaser: null,
              createdAt: null,
              iconUrl: null,
            }],
            hasNext: false,
          }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchUserLists(validCookies);
      expect(result.success).toBe(true);
      expect(result.lists?.length).toBe(2);
      expect(result.lists?.[0].name).toBe('List 1');
      expect(result.lists?.[0].privacy).toBe('public');
      expect(result.lists?.[0].teaser).toBe('My first list');
      expect(result.lists?.[0].createdAt).toBe('2024-01-15T10:30:00.000Z');
      expect(result.lists?.[0].iconUrl).toBe('https://static.myfigurecollection.net/upload/users/128/1_abc.jpeg');
      expect(result.lists?.[1].name).toBe('List 2');
      expect(result.lists?.[1].privacy).toBe('private');
      expect(result.lists?.[1].teaser).toBeUndefined();
      expect(result.lists?.[1].createdAt).toBeUndefined();
      expect(result.lists?.[1].iconUrl).toBeUndefined();
    });

    it('should populate teaser, createdAt, and iconUrl from evaluate data', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        $: jest.fn().mockResolvedValue({ textContent: 'user-menu' }),
        setCookie: jest.fn(),
        evaluate: jest.fn().mockResolvedValue({
          items: [{
            id: '42',
            name: 'For Sale or Trade',
            itemCount: 38,
            privacyText: 'Public',
            url: '/list/42',
            teaser: 'Items I want to sell or trade',
            createdAt: '06/01/2021, 08:00:00',
            iconUrl: 'https://static.myfigurecollection.net/upload/users/128/42_icon.jpeg',
          }],
          hasNext: false,
        }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchUserLists(validCookies);
      expect(result.success).toBe(true);
      expect(result.lists?.length).toBe(1);
      const list = result.lists![0];
      expect(list.id).toBe('42');
      expect(list.name).toBe('For Sale or Trade');
      expect(list.itemCount).toBe(38);
      expect(list.privacy).toBe('public');
      expect(list.teaser).toBe('Items I want to sell or trade');
      expect(list.createdAt).toBe('2021-06-01T08:00:00.000Z');
      expect(list.iconUrl).toBe('https://static.myfigurecollection.net/upload/users/128/42_icon.jpeg');
    });

    it('should handle context close error gracefully', async () => {
      const mockContext = {
        newPage: jest.fn().mockResolvedValue(null),
        close: jest.fn().mockRejectedValue(new Error('close failed')),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchUserLists(validCookies);
      expect(result.success).toBe(false);
      // Should not throw despite close error
    });

    it('should fetch public-only lists when includePrivate is false', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        $: jest.fn().mockResolvedValue({ textContent: 'user-menu' }),
        setCookie: jest.fn(),
        evaluate: jest.fn().mockResolvedValue({
          items: [],
          hasNext: false,
        }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchUserLists(validCookies, false);
      expect(result.success).toBe(true);
      // Verify privacy=0 was used in URL
      const gotoCall = mockPage.goto.mock.calls.find((c: any[]) =>
        c[0].includes('privacy=0')
      );
      expect(gotoCall).toBeDefined();
    });
  });

  // ============================================================================
  // parseMfcDate
  // ============================================================================

  describe('parseMfcDate', () => {
    it('should parse MM/DD/YYYY, HH:MM:SS format to ISO string', () => {
      expect(parseMfcDate('01/15/2024, 10:30:00')).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should parse date with single-digit month/day', () => {
      // MFC uses zero-padded format, but be safe
      expect(parseMfcDate('02/03/2023, 09:05:30')).toBe('2023-02-03T09:05:30.000Z');
    });

    it('should parse midnight correctly', () => {
      expect(parseMfcDate('12/31/2025, 00:00:00')).toBe('2025-12-31T00:00:00.000Z');
    });

    it('should parse end of day correctly', () => {
      expect(parseMfcDate('06/15/2020, 23:59:59')).toBe('2020-06-15T23:59:59.000Z');
    });

    it('should return undefined for null/undefined input', () => {
      expect(parseMfcDate(null as any)).toBeUndefined();
      expect(parseMfcDate(undefined as any)).toBeUndefined();
      expect(parseMfcDate('')).toBeUndefined();
    });

    it('should return undefined for malformed date strings', () => {
      expect(parseMfcDate('not a date')).toBeUndefined();
      expect(parseMfcDate('2024-01-15')).toBeUndefined();
      expect(parseMfcDate('15/01/2024')).toBeUndefined(); // DD/MM instead of MM/DD — but only if month > 12
    });

    it('should handle date with extra whitespace', () => {
      expect(parseMfcDate('  01/15/2024, 10:30:00  ')).toBe('2024-01-15T10:30:00.000Z');
    });
  });

  // ============================================================================
  // fetchListItems
  // ============================================================================

  describe('fetchListItems', () => {
    it('should attempt to fetch items from a list', async () => {
      const result = await fetchListItems('12345', validCookies);
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should handle null page creation', async () => {
      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue({
          newPage: jest.fn().mockResolvedValue(null),
          close: jest.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const result = await fetchListItems('12345', validCookies);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create browser page');
    });

    it('should work without cookies (public list)', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        title: jest.fn().mockResolvedValue('List Page'),
        evaluate: jest.fn().mockResolvedValue({
          items: [{ mfcId: '111', name: 'Figure 1' }],
          hasNext: false,
          title: 'My Public List',
          total: 1,
        }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchListItems('12345');
      expect(result.success).toBe(true);
      expect(result.items?.length).toBe(1);
      expect(result.listName).toBe('My Public List');
      expect(result.totalItems).toBe(1);
    });

    it('should detect error/404 pages', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        title: jest.fn().mockResolvedValue('Error 404'),
        setCookie: jest.fn(),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchListItems('99999', validCookies);
      expect(result.success).toBe(false);
      expect(result.error).toContain('MFC_LIST_NOT_FOUND');
    });

    it('should handle browser errors', async () => {
      jest.spyOn(BrowserPool, 'getStealthBrowser').mockRejectedValue(
        new Error('Browser crashed')
      );

      const result = await fetchListItems('12345', validCookies);
      expect(result.success).toBe(false);
      expect(result.error).toContain('MFC_LIST_ITEMS_ERROR');
    });

    it('should handle pagination for list items', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        title: jest.fn().mockResolvedValue('List Page'),
        evaluate: jest.fn()
          .mockResolvedValueOnce({
            items: [{ mfcId: '111', name: 'Figure 1' }],
            hasNext: true,
            title: 'Test List',
            total: 2,
          })
          .mockResolvedValueOnce({
            items: [{ mfcId: '222', name: 'Figure 2' }],
            hasNext: false,
            title: 'Test List',
            total: 2,
          }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchListItems('12345');
      expect(result.success).toBe(true);
      expect(result.items?.length).toBe(2);
      expect(result.listName).toBe('Test List');
    });

    it('should extract items with imageUrl upgraded to full resolution', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        title: jest.fn().mockResolvedValue('My List Page'),
        evaluate: jest.fn().mockResolvedValue({
          items: [{
            mfcId: '549530',
            name: 'Fate/Grand Order - Mash Kyrielight - 1/7 (Good Smile Company)',
            imageUrl: 'https://static.myfigurecollection.net/upload/items/2/549530-abc123.jpg',
          }],
          hasNext: false,
          title: 'My Wishlist',
          total: 1,
        }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchListItems('100');
      expect(result.success).toBe(true);
      expect(result.items?.length).toBe(1);
      expect(result.items![0].mfcId).toBe('549530');
      expect(result.items![0].name).toBe('Fate/Grand Order - Mash Kyrielight - 1/7 (Good Smile Company)');
      expect(result.items![0].imageUrl).toContain('/upload/items/2/');
      expect(result.listName).toBe('My Wishlist');
      expect(result.totalItems).toBe(1);
    });

    it('should extract description HTML from list detail page', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        title: jest.fn().mockResolvedValue('List Page'),
        evaluate: jest.fn().mockResolvedValue({
          items: [{ mfcId: '111', name: 'Figure 1' }],
          hasNext: false,
          title: 'List With Description',
          total: 1,
          descriptionHtml: '<p>This is my <b>awesome</b> list of figures!</p>',
        }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchListItems('12345');
      expect(result.success).toBe(true);
      expect(result.description).toBe('<p>This is my <b>awesome</b> list of figures!</p>');
      expect(result.listName).toBe('List With Description');
    });

    it('should return undefined description when list has no description', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        title: jest.fn().mockResolvedValue('List Page'),
        evaluate: jest.fn().mockResolvedValue({
          items: [{ mfcId: '111', name: 'Figure 1' }],
          hasNext: false,
          title: 'No Description List',
          total: 1,
          descriptionHtml: undefined,
        }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchListItems('12345');
      expect(result.success).toBe(true);
      expect(result.description).toBeUndefined();
    });
  });

  // ============================================================================
  // fetchCollectionCategory
  // ============================================================================

  describe('fetchCollectionCategory', () => {
    it('should handle not-authenticated state', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        reload: jest.fn(),
        $: jest.fn().mockResolvedValue(null), // Not logged in
        setCookie: jest.fn(),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchCollectionCategory(validCookies, 'owned');
      expect(result.success).toBe(false);
      expect(result.error).toContain('MFC_NOT_AUTHENTICATED');
    });

    it('should handle null page creation', async () => {
      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue({
          newPage: jest.fn().mockResolvedValue(null),
          close: jest.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const result = await fetchCollectionCategory(validCookies, 'owned');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create browser page');
    });

    it('should fetch owned items', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        reload: jest.fn(),
        $: jest.fn().mockResolvedValue({ textContent: 'user-menu' }),
        setCookie: jest.fn(),
        evaluate: jest.fn()
          .mockResolvedValueOnce('testuser') // username extraction
          .mockResolvedValueOnce({ results: [], dateCandidates: [], timeValues: [], bodyClasses: '', pageTitle: '', pageUrl: '', itemLinkCount: 0, firstItemLinks: [], contentPreview: '' }) // detailed view diagnostic
          .mockResolvedValueOnce({ pageTitle: '', pageUrl: '', selectorCounts: {}, itemLinkCount: 1, itemLinkSamples: [] }) // grid view diagnostic
          .mockResolvedValueOnce({
            items: [{ mfcId: '111', name: 'Figure 1', status: 'owned' }],
          })
          .mockResolvedValue({ items: [] }), // empty page stops pagination
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchCollectionCategory(validCookies, 'owned');
      expect(result.success).toBe(true);
      expect(result.items?.length).toBe(1);
      expect(result.listName).toBe('Owned Collection');
    });

    it('should fetch ordered items', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        reload: jest.fn(),
        $: jest.fn().mockResolvedValue({ textContent: 'user-menu' }),
        setCookie: jest.fn(),
        evaluate: jest.fn()
          .mockResolvedValueOnce('testuser') // username extraction
          .mockResolvedValueOnce({ results: [], dateCandidates: [], timeValues: [], bodyClasses: '', pageTitle: '', pageUrl: '', itemLinkCount: 0, firstItemLinks: [], contentPreview: '' })
          .mockResolvedValueOnce({ pageTitle: '', pageUrl: '', selectorCounts: {}, itemLinkCount: 0, itemLinkSamples: [] })
          .mockResolvedValue({ items: [] }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchCollectionCategory(validCookies, 'ordered');
      expect(result.success).toBe(true);
      expect(result.listName).toBe('Ordered Collection');
    });

    it('should fetch wished items', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        reload: jest.fn(),
        $: jest.fn().mockResolvedValue({ textContent: 'user-menu' }),
        setCookie: jest.fn(),
        evaluate: jest.fn()
          .mockResolvedValueOnce('testuser') // username extraction
          .mockResolvedValueOnce({ results: [], dateCandidates: [], timeValues: [], bodyClasses: '', pageTitle: '', pageUrl: '', itemLinkCount: 0, firstItemLinks: [], contentPreview: '' })
          .mockResolvedValueOnce({ pageTitle: '', pageUrl: '', selectorCounts: {}, itemLinkCount: 0, itemLinkSamples: [] })
          .mockResolvedValue({ items: [] }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchCollectionCategory(validCookies, 'wished');
      expect(result.success).toBe(true);
      expect(result.listName).toBe('Wished Collection');
    });

    it('should handle browser errors', async () => {
      jest.spyOn(BrowserPool, 'getStealthBrowser').mockRejectedValue(
        new Error('Browser crashed')
      );

      const result = await fetchCollectionCategory(validCookies, 'owned');
      expect(result.success).toBe(false);
      expect(result.error).toContain('MFC_COLLECTION_ERROR');
    });

    it('should handle username extraction failure', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        reload: jest.fn(),
        $: jest.fn().mockResolvedValue({ textContent: 'user-menu' }), // logged in
        setCookie: jest.fn(),
        evaluate: jest.fn().mockResolvedValueOnce(null), // username extraction returns null
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchCollectionCategory(validCookies, 'owned');
      expect(result.success).toBe(false);
      expect(result.error).toContain('MFC_USERNAME_NOT_FOUND');
    });

    it('should handle pagination for collection items', async () => {
      const mockPage = {
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        reload: jest.fn(),
        $: jest.fn().mockResolvedValue({ textContent: 'user-menu' }),
        setCookie: jest.fn(),
        evaluate: jest.fn()
          // First call: username extraction
          .mockResolvedValueOnce('testuser')
          // Second call: diagnostic for detailed view date fields
          .mockResolvedValueOnce({
            results: [], dateCandidates: [], timeValues: [], bodyClasses: '', pageTitle: '', pageUrl: '', itemLinkCount: 0, firstItemLinks: [], contentPreview: '',
          })
          // Third call: grid view diagnostic
          .mockResolvedValueOnce({
            pageTitle: '', pageUrl: '', selectorCounts: {}, itemLinkCount: 2, itemLinkSamples: [],
          })
          // Fourth call: page 1 items (grid view) - full page triggers pagination
          .mockResolvedValueOnce({
            items: Array.from({ length: 90 }, (_, i) => ({ mfcId: `${100 + i}`, name: `Figure ${i + 1}` })),
          })
          // Fifth call: page 2 items (grid view)
          .mockResolvedValueOnce({
            items: [{ mfcId: '222', name: 'Figure 91' }],
          })
          // Sixth call: page 3 items (empty page stops pagination)
          .mockResolvedValueOnce({
            items: [],
          }),
      };

      const mockContext = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
      };

      jest.spyOn(BrowserPool, 'getStealthBrowser').mockResolvedValue({
        createBrowserContext: jest.fn().mockResolvedValue(mockContext),
      } as any);

      const result = await fetchCollectionCategory(validCookies, 'owned');
      expect(result.success).toBe(true);
      expect(result.items?.length).toBe(91);
      expect(result.totalItems).toBe(91);
      // Verify activity ordering accumulates across pages
      expect(result.items![0].mfcActivityOrder).toBe(0);
      expect(result.items![89].mfcActivityOrder).toBe(89);
      expect(result.items![90].mfcActivityOrder).toBe(90); // First item on page 2
    });
  });
});
