import { BrowserPool } from './genericScraper';
import { Browser, Page } from 'puppeteer';
import { MfcCookies } from './mfcCsvExporter';
import { sanitizeForLog } from '../utils/security';

export interface MfcList {
  id: string;
  name: string;
  itemCount: number;
  privacy: 'public' | 'friends' | 'private';
  url: string;
  teaser?: string;
  createdAt?: string;
  iconUrl?: string;
}

export interface MfcListItem {
  mfcId: string;
  name?: string;
  status?: 'owned' | 'ordered' | 'wished';
  imageUrl?: string;
  mfcActivityOrder?: number;
}

export interface ListsFetchResult {
  success: boolean;
  lists?: MfcList[];
  error?: string;
}

export interface ListItemsFetchResult {
  success: boolean;
  items?: MfcListItem[];
  listName?: string;
  description?: string;
  totalItems?: number;
  error?: string;
}

// MFC URLs for lists
const MFC_BASE_URL = 'https://myfigurecollection.net';

// Build lists URL with optional privacy filter
// -1 = all, 0 = public, 1 = friends only, 2 = private
function buildListsUrl(page: number = 1, privacy: number = -1): string {
  return `${MFC_BASE_URL}/?mode=lists&page=${page}&privacy=${privacy}&current=keywords&_tb=manager`;
}

function buildListUrl(listId: string): string {
  return `${MFC_BASE_URL}/list/${listId}`;
}

// CSS Selectors for MFC Lists pages
const SELECTORS = {
  // Lists overview page (manager view)
  listEntries: '.dgst.list-dgst .dgst-wrapper',
  listAnchor: '.dgst-anchor a[href*="/list/"]',
  listTeaser: '.dgst-meta div.meta[title]',
  listItemCount: '.dgst-meta span.meta',
  listPrivacy: '.meta.category',
  listIcon: '.dgst-icon img',
  listCreatedDate: '.dgst-meta span.meta span[title]',

  // Individual list detail page
  detailTitle: 'h1.title',
  detailIcon: '.content-icon .thumbnail',
  detailDescription: '.object-wrapper .bbcode',
  detailTotalItems: '.object-stats',
  detailItemIcons: '.item-icon a[href*="/item/"]',

  // Pagination
  nextPage: 'a[rel="next"], .pagination .next a',

  // Login indicator
  userMenu: '.user-menu, .user-avatar, [href*="logout"]',
};

// Allowlist of MFC cookie names (from env or defaults)
const ALLOWED_COOKIE_NAMES = process.env.MFC_ALLOWED_COOKIES
  ? process.env.MFC_ALLOWED_COOKIES.split(',').map(s => s.trim()).filter(s => s.length > 0)
  : ['PHPSESSID', 'sesUID', 'sesDID', 'cf_clearance'];

/**
 * Apply MFC cookies to a browser page
 */
async function applyCookies(page: Page, cookies: MfcCookies): Promise<void> {
  await page.goto(MFC_BASE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });

  const cookieArray = Object.entries(cookies)
    .filter(([name, value]) => {
      if (!ALLOWED_COOKIE_NAMES.includes(name)) {
        return false;
      }
      return value != null && value !== '';
    })
    .map(([name, value]) => {
      const cookieObj: any = {
        name,
        value: value as string,
        domain: '.myfigurecollection.net',
        path: '/'
      };

      if (name === 'PHPSESSID') {
        cookieObj.httpOnly = true;
        cookieObj.secure = true;
        cookieObj.sameSite = 'Lax';
      }

      return cookieObj;
    });

  if (cookieArray.length > 0) {
    await page.setCookie(...cookieArray);
  }
}

/**
 * Parse privacy level from text
 */
function parsePrivacy(text: string): 'public' | 'friends' | 'private' {
  const lower = text.toLowerCase();
  if (lower.includes('private')) return 'private';
  if (lower.includes('friend')) return 'friends';
  return 'public';
}

/**
 * Parse MFC date format (MM/DD/YYYY, HH:MM:SS) to ISO string.
 * Returns undefined if the input is falsy or doesn't match the expected format.
 */
export function parseMfcDate(dateStr: string | null | undefined): string | undefined {
  if (!dateStr) return undefined;
  const trimmed = dateStr.trim();
  if (!trimmed) return undefined;

  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return undefined;

  const [, month, day, year, hours, minutes, seconds] = match;
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);

  // Basic validation
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;

  const date = new Date(Date.UTC(
    parseInt(year, 10),
    m - 1,
    d,
    parseInt(hours, 10),
    parseInt(minutes, 10),
    parseInt(seconds, 10)
  ));

  // Verify the date is valid (catches things like Feb 30)
  if (isNaN(date.getTime())) return undefined;

  return date.toISOString();
}

/**
 * Extract list ID from URL
 */
function extractListId(url: string): string | null {
  const match = url.match(/\/list\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Extract MFC item ID from URL
 */
function extractMfcId(url: string): string | null {
  const match = url.match(/\/item\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Extract the logged-in user's MFC username from an authenticated page.
 * Looks for profile links in the page header/navigation.
 */
async function extractMfcUsername(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/profile/"]');
    for (const link of Array.from(links)) {
      const href = (link as HTMLAnchorElement).getAttribute('href') || '';
      const match = href.match(/\/profile\/([^/?#]+)/);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  });
}

/**
 * Fetch all of user's lists from MFC Manager
 *
 * @param cookies - MFC session cookies (ephemeral)
 * @param includePrivate - Whether to include private lists (requires cookies)
 * @returns Array of user's lists with metadata
 */
export async function fetchUserLists(
  cookies: MfcCookies,
  includePrivate: boolean = true
): Promise<ListsFetchResult> {
  console.log('[MFC LISTS] Fetching user lists...');

  let browser: Browser | null = null;
  let context: any | null = null;
  let page: Page | null = null;

  try {
    browser = await BrowserPool.getStealthBrowser();
    context = await browser.createBrowserContext();
    page = await context.newPage();

    if (!page) {
      return {
        success: false,
        error: 'Failed to create browser page'
      };
    }

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    );

    await applyCookies(page, cookies);

    // Navigate to lists page
    const privacy = includePrivate ? -1 : 0; // -1 = all, 0 = public only
    const listsUrl = buildListsUrl(1, privacy);
    console.log(`[MFC LISTS] Navigating to: ${sanitizeForLog(listsUrl)}`);

    await page.goto(listsUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if we can see the user menu (logged in)
    const userMenu = await page.$(SELECTORS.userMenu);
    if (!userMenu) {
      console.log('[MFC LISTS] Not logged in - cookies may be invalid');
      return {
        success: false,
        error: 'MFC_NOT_AUTHENTICATED: Session cookies are invalid or expired'
      };
    }

    const lists: MfcList[] = [];
    let currentPage = 1;
    let hasMorePages = true;

    // Paginate through all lists
    while (hasMorePages) {
      console.log(`[MFC LISTS] Processing page ${currentPage}...`);

      // Extract lists from current page using real MFC selectors
      const pageListData = await page.evaluate((selectors) => {
        const items: any[] = [];

        // MFC lists overview uses .dgst.list-dgst .dgst-wrapper entries
        const listElements = document.querySelectorAll(selectors.listEntries);

        listElements.forEach(el => {
          // Extract list link and ID from .dgst-anchor a[href*="/list/"]
          const link = el.querySelector(selectors.listAnchor) as HTMLAnchorElement;
          if (!link) return;

          const href = link.getAttribute('href') || link.href || '';
          const idMatch = href.match(/\/list\/(\d+)/);
          if (!idMatch) return;

          // Name from the title attribute of the anchor (most reliable)
          const name = link.getAttribute('title') || link.textContent?.trim() || `List ${idMatch[1]}`;

          // Teaser: div.meta with a title attribute inside .dgst-meta
          const teaserEl = el.querySelector(selectors.listTeaser) as HTMLElement;
          const teaser = teaserEl?.getAttribute('title') || teaserEl?.textContent?.trim() || null;

          // Item count: span.meta text matching /(\d+)\s*item/
          let itemCount = 0;
          const metaSpans = el.querySelectorAll(selectors.listItemCount);
          metaSpans.forEach(span => {
            const text = span.textContent || '';
            const countMatch = text.match(/(\d+)\s*item/);
            if (countMatch) {
              itemCount = parseInt(countMatch[1], 10);
            }
          });

          // Privacy from .meta.category text
          const privacyEl = el.querySelector(selectors.listPrivacy);
          const privacyText = privacyEl?.textContent?.trim() || 'Public';

          // Icon URL from .dgst-icon img src
          const iconEl = el.querySelector(selectors.listIcon) as HTMLImageElement;
          const iconUrl = iconEl?.src || iconEl?.getAttribute('src') || null;

          // Created date from span[title] inside .dgst-meta span.meta
          // The title attribute contains the full date: MM/DD/YYYY, HH:MM:SS
          const dateEl = el.querySelector(selectors.listCreatedDate) as HTMLElement;
          const createdAt = dateEl?.getAttribute('title') || null;

          items.push({
            id: idMatch[1],
            name,
            itemCount,
            privacyText,
            url: href,
            teaser,
            createdAt,
            iconUrl,
          });
        });

        // Check for next page
        const nextLink = document.querySelector(selectors.nextPage);
        const hasNext = nextLink !== null;

        return { items, hasNext };
      }, SELECTORS);

      // Process extracted lists
      for (const item of pageListData.items) {
        lists.push({
          id: item.id,
          name: item.name,
          itemCount: item.itemCount,
          privacy: parsePrivacy(item.privacyText),
          url: item.url,
          teaser: item.teaser || undefined,
          createdAt: parseMfcDate(item.createdAt),
          iconUrl: item.iconUrl || undefined,
        });
      }

      // Check if there are more pages
      if (pageListData.hasNext) {
        currentPage++;
        const nextUrl = buildListsUrl(currentPage, privacy);

        await page.goto(nextUrl, {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else {
        hasMorePages = false;
      }

      // Safety: limit pagination to prevent infinite loops
      if (currentPage > 50) {
        console.log('[MFC LISTS] Reached page limit (50), stopping pagination');
        hasMorePages = false;
      }
    }

    console.log(`[MFC LISTS] Found ${lists.length} lists`);

    return {
      success: true,
      lists
    };

  } catch (error: any) {
    console.error('[MFC LISTS] Error fetching lists:', error.message);
    return {
      success: false,
      error: `MFC_LISTS_ERROR: ${error.message}`
    };
  } finally {
    if (context && typeof context.close === 'function') {
      await context.close().catch(() => {});
    }
  }
}

/**
 * Fetch items from a specific MFC list
 *
 * @param listId - The MFC list ID
 * @param cookies - MFC session cookies (optional for public lists)
 * @returns Array of items in the list
 */
export async function fetchListItems(
  listId: string,
  cookies?: MfcCookies
): Promise<ListItemsFetchResult> {
  console.log(`[MFC LISTS] Fetching items from list ${listId}...`);

  let browser: Browser | null = null;
  let context: any | null = null;
  let page: Page | null = null;

  try {
    browser = await BrowserPool.getStealthBrowser();
    context = await browser.createBrowserContext();
    page = await context.newPage();

    if (!page) {
      return {
        success: false,
        error: 'Failed to create browser page'
      };
    }

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    );

    // Apply cookies if provided (needed for private lists)
    if (cookies) {
      await applyCookies(page, cookies);
    }

    const listUrl = buildListUrl(listId);
    console.log(`[MFC LISTS] Navigating to: ${sanitizeForLog(listUrl)}`);

    await page.goto(listUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if we're on an error page
    const pageTitle = await page.title();
    if (pageTitle.includes('Error') || pageTitle.includes('404')) {
      return {
        success: false,
        error: 'MFC_LIST_NOT_FOUND: List does not exist or is not accessible'
      };
    }

    const items: MfcListItem[] = [];
    let currentPage = 1;
    let hasMorePages = true;
    let listName: string | undefined;
    let description: string | undefined;
    let totalItems: number | undefined;

    // Paginate through all items in the list
    while (hasMorePages) {
      console.log(`[MFC LISTS] Processing list page ${currentPage}...`);

      const pageData = await page.evaluate((selectors) => {
        const itemsOnPage: any[] = [];

        // Get list title from h1.title (real MFC selector)
        const titleEl = document.querySelector(selectors.detailTitle);
        const title = titleEl?.textContent?.trim();

        // Get total count from .object-stats (contains "{N} items" text)
        const countEl = document.querySelector(selectors.detailTotalItems);
        const countText = countEl?.textContent || '';
        const countMatch = countText.match(/(\d+)\s*item/);
        const total = countMatch ? parseInt(countMatch[1], 10) : undefined;

        // Find all item icons using .item-icon a[href*="/item/"]
        const itemLinks = document.querySelectorAll(selectors.detailItemIcons);

        itemLinks.forEach(link => {
          const anchor = link as HTMLAnchorElement;
          const href = anchor.getAttribute('href') || anchor.href || '';
          const idMatch = href.match(/\/item\/(\d+)/);
          if (!idMatch) return;

          // Get figure name from img alt text (contains origin, character, scale, manufacturer)
          const img = anchor.querySelector('img') as HTMLImageElement;
          const name = img?.alt || undefined;

          // Get thumbnail image — upgrade to full-resolution /items/2/ if available
          const rawImgUrl = img?.src || img?.getAttribute('data-src');
          const imageUrl = rawImgUrl?.replace(/\/upload\/items\/[01]\//, '/upload/items/2/');

          itemsOnPage.push({
            mfcId: idMatch[1],
            name: name || undefined,
            imageUrl: imageUrl || undefined
          });
        });

        // Extract description HTML (only present on first page)
        const descEl = document.querySelector(selectors.detailDescription);
        const descriptionHtml = descEl?.innerHTML?.trim() || undefined;

        // Check for next page
        const nextLink = document.querySelector(selectors.nextPage);
        const hasNext = nextLink !== null;

        return { items: itemsOnPage, hasNext, title, total, descriptionHtml };
      }, SELECTORS);

      // Store list metadata from first page
      if (currentPage === 1) {
        listName = pageData.title;
        totalItems = pageData.total;
        description = pageData.descriptionHtml;
      }

      // Add items from this page
      items.push(...pageData.items);

      // Check for more pages
      if (pageData.hasNext) {
        currentPage++;

        // Navigate to next page (MFC uses page parameter in URL)
        const nextUrl = `${listUrl}?page=${currentPage}`;
        await page.goto(nextUrl, {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else {
        hasMorePages = false;
      }

      // Safety limit
      if (currentPage > 100) {
        console.log('[MFC LISTS] Reached page limit (100), stopping pagination');
        hasMorePages = false;
      }
    }

    console.log(`[MFC LISTS] Found ${items.length} items in list ${listId}`);

    return {
      success: true,
      items,
      listName,
      description,
      totalItems: totalItems || items.length
    };

  } catch (error: any) {
    console.error('[MFC LISTS] Error fetching list items:', error.message);
    return {
      success: false,
      error: `MFC_LIST_ITEMS_ERROR: ${error.message}`
    };
  } finally {
    if (context && typeof context.close === 'function') {
      await context.close().catch(() => {});
    }
  }
}

/**
 * Fetch items from the user's default collection categories
 * (Owned, Ordered, Wished)
 *
 * @param cookies - MFC session cookies
 * @param category - Which category to fetch
 * @returns Array of items in that category
 */
export async function fetchCollectionCategory(
  cookies: MfcCookies,
  category: 'owned' | 'ordered' | 'wished'
): Promise<ListItemsFetchResult> {
  console.log(`[MFC LISTS] Fetching ${category} items from collection...`);

  // Map category to MFC status parameter
  const statusMap: Record<string, number> = {
    owned: 2,   // Status 2 = Owned
    ordered: 1, // Status 1 = Ordered/Preordered
    wished: 0   // Status 0 = Wished
  };

  const status = statusMap[category];

  let browser: Browser | null = null;
  let context: any | null = null;
  let page: Page | null = null;

  try {
    browser = await BrowserPool.getStealthBrowser();
    context = await browser.createBrowserContext();
    page = await context.newPage();

    if (!page) {
      return {
        success: false,
        error: 'Failed to create browser page'
      };
    }

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    );

    await applyCookies(page, cookies);

    // Reload to see authenticated view (cookies are now in the browser's cookie jar)
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Check login status
    const userMenu = await page.$(SELECTORS.userMenu);
    if (!userMenu) {
      return {
        success: false,
        error: 'MFC_NOT_AUTHENTICATED: Session cookies are invalid or expired'
      };
    }

    // Extract username for collection URLs
    // MFC collection pages require &username= parameter (without it, root URL returns 404)
    const username = await extractMfcUsername(page);
    if (!username) {
      console.log('[MFC LISTS] Could not extract MFC username from authenticated page');
      return {
        success: false,
        error: 'MFC_USERNAME_NOT_FOUND: Could not determine MFC username - no profile link found on page'
      };
    }
    console.log(`[MFC LISTS] Detected MFC username: ${sanitizeForLog(username)}`);

    const buildCollectionUrl = (pageNum: number, output: number) => {
      if (output === 2) {
        return `${MFC_BASE_URL}/?mode=view&username=${encodeURIComponent(username)}&tab=collection&page=${pageNum}&status=${status}&current=keywords&rootId=-1&categoryId=-1&output=2&sort=activity&order=desc&_tb=user`;
      }
      return `${MFC_BASE_URL}/?mode=view&username=${encodeURIComponent(username)}&tab=collection&page=${pageNum}&status=${status}&sort=activity&order=desc&output=${output}&_tb=user`;
    };

    // Navigate to detailed view first for date field diagnostic
    const detailedUrl = buildCollectionUrl(1, 0);
    console.log(`[MFC LISTS] Navigating to collection detailed view (${category})...`);
    await page.goto(detailedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    const diagnosticData = await page.evaluate(() => {
      // Capture the first few item elements in detailed view
      const results: any[] = [];

      // Try multiple selector patterns MFC might use for detailed view
      const detailSelectors = [
        '.result .dgst',
        '.collection-item',
        '.item-detail',
        '.item-entry',
        'table.listing tr',
        '.result',
      ];

      for (const sel of detailSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          results.push({
            selector: sel,
            count: els.length,
            // Capture outerHTML of first 2 items (truncated for logging)
            samples: Array.from(els).slice(0, 2).map(el => el.outerHTML.substring(0, 2000)),
          });
        }
      }

      // Also look for any span[title] with date patterns anywhere on the page
      const dateSpans = document.querySelectorAll('span[title]');
      const dateCandidates: string[] = [];
      dateSpans.forEach(span => {
        const title = span.getAttribute('title') || '';
        if (title.match(/\d{1,2}\/\d{1,2}\/\d{4}/) || title.match(/\d{4}-\d{2}-\d{2}/)) {
          dateCandidates.push(title);
        }
      });

      // Check for time elements
      const timeEls = document.querySelectorAll('time[datetime]');
      const timeValues: string[] = [];
      timeEls.forEach(el => {
        timeValues.push(el.getAttribute('datetime') || '');
      });

      // Capture page title and a broader DOM snapshot
      const pageTitle = document.title;
      const pageUrl = window.location.href;

      // Get all elements with item links to see what's actually on the page
      const itemLinks = document.querySelectorAll('a[href*="/item/"]');
      const itemLinkCount = itemLinks.length;
      const firstItemLinks = Array.from(itemLinks).slice(0, 3).map(a => ({
        href: (a as HTMLAnchorElement).href,
        parentTag: a.parentElement?.tagName,
        parentClass: a.parentElement?.className?.substring(0, 100),
        grandParentTag: a.parentElement?.parentElement?.tagName,
        grandParentClass: a.parentElement?.parentElement?.className?.substring(0, 100),
      }));

      // Get top-level content structure
      const mainContent = document.querySelector('.content, #content, main, .tbx-target-USER');
      const contentPreview = mainContent?.innerHTML?.substring(0, 500) || 'NO_MAIN_CONTENT_FOUND';

      return {
        results, dateCandidates, timeValues, bodyClasses: document.body.className,
        pageTitle, pageUrl, itemLinkCount, firstItemLinks, contentPreview,
      };
    });

    console.log(`[MFC LISTS] Detailed view diagnostic (${category}):`, JSON.stringify(diagnosticData, null, 2));

    // Now switch to grid view (output=2) for the main extraction
    const items: MfcListItem[] = [];
    let currentPage = 1;
    let hasMorePages = true;
    let globalOffset = 0; // Track position across pages for activity ordering

    // Navigate to first page of grid view
    const collectionGridUrl = buildCollectionUrl(1, 2);
    await page.goto(collectionGridUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Grid view diagnostic - understand DOM structure
    const gridDiag = await page.evaluate(() => {
      const pageTitle = document.title;
      const pageUrl = window.location.href;

      // Check candidate selectors for grid items
      const selectorCounts: Record<string, number> = {};
      for (const sel of ['.item-icons li', '.collection-item', '.item-icon', '.result', '.result-icon', 'li.tbx-btn', '.medium-icon']) {
        selectorCounts[sel] = document.querySelectorAll(sel).length;
      }

      // Check for item links and their parent structure
      const itemLinks = document.querySelectorAll('a[href*="/item/"]');
      const itemLinkSamples = Array.from(itemLinks).slice(0, 3).map(a => ({
        href: (a as HTMLAnchorElement).href,
        parentTag: a.parentElement?.tagName,
        parentClass: a.parentElement?.className?.substring(0, 100),
        gpTag: a.parentElement?.parentElement?.tagName,
        gpClass: a.parentElement?.parentElement?.className?.substring(0, 100),
      }));

      return { pageTitle, pageUrl, selectorCounts, itemLinkCount: itemLinks.length, itemLinkSamples };
    });
    console.log(`[MFC LISTS] Grid view diagnostic (${category}):`, JSON.stringify(gridDiag, null, 2));

    // Check if grid view loaded successfully (MFC renders full header chrome on error pages)
    if (gridDiag.pageTitle.toLowerCase().includes('error') || gridDiag.pageTitle.includes('404')) {
      console.log(`[MFC LISTS] Grid view returned error page - collection URL may need updating`);
      return {
        success: false,
        error: `MFC_COLLECTION_URL_ERROR: Collection page returned "${gridDiag.pageTitle}"`
      };
    }

    while (hasMorePages) {
      console.log(`[MFC LISTS] Processing ${category} page ${currentPage} (globalOffset=${globalOffset})...`);

      const pageData = await page.evaluate((catStatus: string) => {
        const itemsOnPage: any[] = [];

        // MFC grid view uses .item-icon containers (each wraps an anchor to /item/ID)
        const figureElements = document.querySelectorAll('.item-icon');

        figureElements.forEach(el => {
          const link = el.querySelector('a[href*="/item/"]') as HTMLAnchorElement;
          if (!link) return;

          const href = link.href;
          const idMatch = href.match(/\/item\/(\d+)/);
          if (!idMatch) return;

          const img = el.querySelector('img') as HTMLImageElement;
          const rawImgUrl = img?.src || img?.getAttribute('data-src');
          // Upgrade to full-resolution /items/2/ if available
          const imageUrl = rawImgUrl?.replace(/\/upload\/items\/[01]\//, '/upload/items/2/');
          const name = img?.alt || undefined;

          itemsOnPage.push({
            mfcId: idMatch[1],
            name,
            imageUrl,
            status: catStatus
          });
        });

        return { items: itemsOnPage };
      }, category);

      // Assign activity order based on position in activity-sorted pages
      for (const item of pageData.items) {
        item.mfcActivityOrder = globalOffset;
        globalOffset++;
      }

      items.push(...pageData.items);

      console.log(`[MFC LISTS] Page ${currentPage}: ${pageData.items.length} items, globalOffset now ${globalOffset}`);

      // Keep paginating until MFC returns an empty page. The toolbox UI
      // doesn't render reliable rel="next" links, and the last page may
      // contain exactly MFC_GRID_PAGE_SIZE items, so we can't stop early.
      if (pageData.items.length > 0) {
        currentPage++;
        const nextUrl = buildCollectionUrl(currentPage, 2);
        await page.goto(nextUrl, {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else {
        hasMorePages = false;
      }

      // Safety limit
      if (currentPage > 200) {
        console.log('[MFC LISTS] Reached page limit (200), stopping pagination');
        hasMorePages = false;
      }
    }

    console.log(`[MFC LISTS] Found ${items.length} ${category} items`);

    return {
      success: true,
      items,
      listName: `${category.charAt(0).toUpperCase() + category.slice(1)} Collection`,
      totalItems: items.length
    };

  } catch (error: any) {
    console.error(`[MFC LISTS] Error fetching ${category} items:`, error.message);
    return {
      success: false,
      error: `MFC_COLLECTION_ERROR: ${error.message}`
    };
  } finally {
    if (context && typeof context.close === 'function') {
      await context.close().catch(() => {});
    }
  }
}
