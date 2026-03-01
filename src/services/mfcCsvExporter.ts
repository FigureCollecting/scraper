import { BrowserPool } from './genericScraper';
import { Browser, Page } from 'puppeteer';
import { sanitizeForLog } from '../utils/security';

export interface MfcCookies {
  PHPSESSID: string;
  sesUID: string;
  sesDID: string;
  cf_clearance?: string;
  [key: string]: string | undefined;
}

export interface CsvExportOptions {
  /** Which list to export. Default: 0 (owned items) */
  listType?: 'owned' | 'ordered' | 'wished' | 'all';
  /** Export all available fields. Default: true */
  allFields?: boolean;
  /** Use comma separator. Default: true */
  commaSeparator?: boolean;
}

export interface CsvExportResult {
  success: boolean;
  csvContent?: string;
  itemCount?: number;
  error?: string;
}

export interface CookieValidationResult {
  valid: boolean;
  reason?: string;
  canAccessManager?: boolean;
  canExportCsv?: boolean;
}

// MFC Manager URLs
const MFC_BASE_URL = 'https://myfigurecollection.net';
const MFC_MANAGER_URL = `${MFC_BASE_URL}/?_tb=manager`;

// CSS Selectors for MFC CSV Export dialog (from user-provided HTML)
const SELECTORS = {
  // Export trigger link in manager toolbar
  exportTrigger: 'a.tbx-window.action.export',

  // Export dialog container
  exportDialog: '.wrapper.tbx-target-WINDOW',

  // All checkboxes for field selection
  fieldCheckboxes: '.wrapper.tbx-target-WINDOW input[type="checkbox"]',

  // Comma separator radio button (id="rd-Sep-0")
  commaSeparator: '#rd-Sep-0',

  // Submit button
  submitButton: '.wrapper.tbx-target-WINDOW input[type="submit"]',

  // Login/logout indicator - presence means logged in
  userMenu: '.user-menu, .user-avatar, [href*="logout"]',

  // Error/blocked page indicators
  blockedPage: '.cf-error-details, .error-page',
};

// Allowlist of MFC cookie names (from env or defaults)
const ALLOWED_COOKIE_NAMES = process.env.MFC_ALLOWED_COOKIES
  ? process.env.MFC_ALLOWED_COOKIES.split(',').map(s => s.trim()).filter(s => s.length > 0)
  : ['PHPSESSID', 'sesUID', 'sesDID', 'cf_clearance'];

/**
 * Validate that provided cookies contain required MFC session cookies
 */
function validateCookieStructure(cookies: MfcCookies): { valid: boolean; missing: string[] } {
  const requiredCookies = ['PHPSESSID', 'sesUID', 'sesDID'];
  const missing = requiredCookies.filter(name => !cookies[name]);

  return {
    valid: missing.length === 0,
    missing
  };
}

/**
 * Apply MFC cookies to a browser page
 */
async function applyCookies(page: Page, cookies: MfcCookies): Promise<void> {
  // Visit MFC first to establish domain context
  await page.goto(MFC_BASE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });

  // Build cookie array from provided cookies, filtering through allowlist
  const cookieArray = Object.entries(cookies)
    .filter(([name, value]) => {
      if (!ALLOWED_COOKIE_NAMES.includes(name)) {
        console.log(`[MFC CSV] Ignoring unknown cookie: ${sanitizeForLog(name)}`);
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

      // PHPSESSID needs special security flags
      if (name === 'PHPSESSID') {
        cookieObj.httpOnly = true;
        cookieObj.secure = true;
        cookieObj.sameSite = 'Lax';
      }

      return cookieObj;
    });

  if (cookieArray.length > 0) {
    console.log(`[MFC CSV] Setting ${cookieArray.length} cookies: ${cookieArray.map(c => c.name).join(', ')}`);
    await page.setCookie(...cookieArray);
  }
}

/**
 * Check if the page shows we're logged in to MFC
 * Also verifies the page isn't an error page (MFC renders header chrome on error pages too)
 */
async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    // First check we're not on an error page
    const title = await page.title();
    if (title.toLowerCase().includes('error')) {
      console.log(`[MFC CSV] Page title indicates error: "${title}"`);
      return false;
    }

    // Look for user menu or logout link
    const userElement = await page.$(SELECTORS.userMenu);
    return userElement !== null;
  } catch (error) {
    return false;
  }
}

/**
 * Check if we're blocked by Cloudflare or other protection
 */
async function isBlockedPage(page: Page): Promise<boolean> {
  try {
    const title = await page.title();
    const blockedElement = await page.$(SELECTORS.blockedPage);

    return blockedElement !== null ||
           title.includes('Just a moment') ||
           title.includes('Attention Required') ||
           title.includes('Access denied');
  } catch (error) {
    return false;
  }
}

/**
 * Export user's collection as CSV from MFC Manager
 *
 * This function automates the CSV export process:
 * 1. Navigate to MFC Manager with cookies
 * 2. Click the CSV Export link to open dialog
 * 3. Select all fields and comma separator
 * 4. Submit and capture the CSV response
 *
 * @param cookies - MFC session cookies (ephemeral, not stored)
 * @param options - Export configuration options
 * @returns CSV content or error
 */
export async function exportMfcCsv(
  cookies: MfcCookies,
  options: CsvExportOptions = {}
): Promise<CsvExportResult> {
  console.log('[MFC CSV] Starting CSV export automation...');

  // Validate cookie structure first
  const cookieValidation = validateCookieStructure(cookies);
  if (!cookieValidation.valid) {
    return {
      success: false,
      error: `Missing required cookies: ${cookieValidation.missing.join(', ')}`
    };
  }

  const { allFields = true, commaSeparator = true } = options;

  let browser: Browser | null = null;
  let context: any | null = null;
  let page: Page | null = null;

  try {
    // Use stealth browser to bypass Cloudflare
    browser = await BrowserPool.getStealthBrowser();
    context = await browser.createBrowserContext();
    page = await context.newPage();

    if (!page) {
      return {
        success: false,
        error: 'Failed to create browser page'
      };
    }

    // Set realistic browser configuration
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    );

    // Apply cookies
    await applyCookies(page, cookies);

    // Navigate to Manager page
    console.log('[MFC CSV] Navigating to Manager page...');
    await page.goto(MFC_MANAGER_URL, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait for page to settle
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if blocked by Cloudflare
    if (await isBlockedPage(page)) {
      console.log('[MFC CSV] Detected Cloudflare block');
      return {
        success: false,
        error: 'MFC_CLOUDFLARE_BLOCKED: Cloudflare challenge detected. Try again later or refresh your cookies.'
      };
    }

    // Check if logged in
    if (!(await isLoggedIn(page))) {
      console.log('[MFC CSV] Not logged in - cookies may be invalid or expired');
      return {
        success: false,
        error: 'MFC_NOT_AUTHENTICATED: Cookies are invalid or expired. Please provide fresh session cookies.'
      };
    }

    console.log('[MFC CSV] Successfully logged in, looking for CSV Export button...');

    // Find and click the CSV Export link
    const exportLink = await page.$(SELECTORS.exportTrigger);
    if (!exportLink) {
      // Diagnostic: dump page structure to find the new export selector
      const pageDiag = await page.evaluate(() => {
        const diag: any = {};
        // Look for any export-related links
        const allLinks = document.querySelectorAll('a');
        const exportLinks: string[] = [];
        const actionLinks: string[] = [];
        const tbxLinks: string[] = [];
        allLinks.forEach(a => {
          const text = (a.textContent || '').trim().toLowerCase();
          const cls = a.className || '';
          const href = a.getAttribute('href') || '';
          if (text.includes('export') || text.includes('csv') || cls.includes('export') || href.includes('export')) {
            exportLinks.push(`text="${a.textContent?.trim()}" class="${cls}" href="${href}"`);
          }
          if (cls.includes('action')) {
            actionLinks.push(`text="${a.textContent?.trim()}" class="${cls}" href="${href}"`);
          }
          if (cls.includes('tbx')) {
            tbxLinks.push(`text="${a.textContent?.trim()}" class="${cls}" href="${href}"`);
          }
        });
        diag.exportLinks = exportLinks;
        diag.actionLinks = actionLinks.slice(0, 20);
        diag.tbxLinks = tbxLinks.slice(0, 20);
        diag.pageTitle = document.title;
        diag.url = window.location.href;
        // Capture toolbar/nav area HTML
        const toolbar = document.querySelector('.toolbar, .manager-toolbar, .actions, nav');
        diag.toolbarHtml = toolbar?.outerHTML?.substring(0, 3000) || 'no toolbar found';
        // Look for any element with "export" in text
        const body = document.body.innerText || '';
        const exportIdx = body.toLowerCase().indexOf('export');
        if (exportIdx >= 0) {
          diag.exportContext = body.substring(Math.max(0, exportIdx - 100), exportIdx + 200);
        }
        return diag;
      });
      console.log('[MFC CSV] CSV Export link not found. Page diagnostic:', JSON.stringify(pageDiag, null, 2));
      return {
        success: false,
        error: 'MFC_EXPORT_NOT_FOUND: CSV Export option not found. The page structure may have changed.'
      };
    }

    // Click to open the export dialog
    console.log('[MFC CSV] Clicking CSV Export link...');
    await exportLink.click();

    // Wait for dialog to appear
    await page.waitForSelector(SELECTORS.exportDialog, { timeout: 10000 });
    console.log('[MFC CSV] Export dialog opened');

    // Wait a bit for dialog to fully render
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Select all fields if requested
    if (allFields) {
      console.log('[MFC CSV] Selecting all export fields...');
      const checkboxes = await page.$$(SELECTORS.fieldCheckboxes);
      for (const checkbox of checkboxes) {
        const isChecked = await checkbox.evaluate(el => (el as HTMLInputElement).checked);
        if (!isChecked) {
          await checkbox.click();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }

    // Select comma separator if requested
    if (commaSeparator) {
      console.log('[MFC CSV] Selecting comma separator...');
      const commaRadio = await page.$(SELECTORS.commaSeparator);
      if (commaRadio) {
        await commaRadio.click();
      }
    }

    // Set up download handling
    // Use a temp directory to store the downloaded CSV
    const fs = await import('fs/promises');
    const path = await import('path');
    const os = await import('os');

    const downloadPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mfc-csv-'));
    console.log(`[MFC CSV] Download path: ${downloadPath}`);

    // Configure Chrome to download files to our temp directory
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadPath,
    });

    // Click submit button
    console.log('[MFC CSV] Submitting export request...');
    const submitButton = await page.$(SELECTORS.submitButton);
    if (!submitButton) {
      // Clean up temp directory
      await fs.rm(downloadPath, { recursive: true }).catch(() => {});
      return {
        success: false,
        error: 'MFC_SUBMIT_NOT_FOUND: Export submit button not found in dialog.'
      };
    }

    // Click the submit button
    await submitButton.click();

    // Wait for the download to complete (poll for file in download directory)
    let csvContent = '';
    const maxWaitTime = 30000; // 30 seconds
    const pollInterval = 500; // 500ms
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      try {
        const files = await fs.readdir(downloadPath);
        // Look for a CSV file (ignore .crdownload partial downloads)
        const csvFile = files.find(f => f.endsWith('.csv') && !f.endsWith('.crdownload'));

        if (csvFile) {
          const filePath = path.join(downloadPath, csvFile);
          csvContent = await fs.readFile(filePath, 'utf-8');
          console.log(`[MFC CSV] Downloaded file: ${csvFile} (${csvContent.length} bytes)`);
          break;
        }
      } catch (error) {
        // Directory might not exist yet or other transient error
      }
    }

    // Clean up temp directory
    await fs.rm(downloadPath, { recursive: true }).catch((err: any) => {
      console.warn('[MFC CSV] Failed to clean up temp directory:', err.message);
    });

    if (!csvContent) {
      return {
        success: false,
        error: 'MFC_CSV_DOWNLOAD_TIMEOUT: CSV download did not complete within timeout.'
      };
    }

    // Count items in CSV (subtract 1 for header row)
    const lines = csvContent.split('\n').filter(line => line.trim().length > 0);
    const itemCount = Math.max(0, lines.length - 1);

    console.log(`[MFC CSV] Export successful: ${itemCount} items`);

    return {
      success: true,
      csvContent,
      itemCount
    };

  } catch (error: any) {
    console.error('[MFC CSV] Export failed:', error.message);

    // Classify error type
    if (error.message.includes('timeout')) {
      return {
        success: false,
        error: 'MFC_TIMEOUT: Request timed out. MFC may be slow or blocking requests.'
      };
    }

    return {
      success: false,
      error: `MFC_EXPORT_ERROR: ${error.message}`
    };
  } finally {
    // Clean up context (browser stays alive for reuse)
    if (context && typeof context.close === 'function') {
      await context.close().catch((err: any) => {
        console.error('[MFC CSV] Error closing context:', err);
      });
    }
  }
}

/**
 * Validate MFC cookies by attempting to access the Manager page
 * This is useful to check if cookies are still valid before starting a sync
 *
 * @param cookies - MFC session cookies to validate
 * @returns Validation result indicating if cookies work
 */
export async function validateMfcCookies(
  cookies: MfcCookies
): Promise<CookieValidationResult> {
  console.log('[MFC CSV] Validating cookies via Manager access...');

  // First check structure
  const structureCheck = validateCookieStructure(cookies);
  if (!structureCheck.valid) {
    return {
      valid: false,
      reason: `Missing required cookies: ${structureCheck.missing.join(', ')}`,
      canAccessManager: false,
      canExportCsv: false
    };
  }

  let browser: Browser | null = null;
  let context: any | null = null;
  let page: Page | null = null;

  try {
    browser = await BrowserPool.getStealthBrowser();
    context = await browser.createBrowserContext();
    page = await context.newPage();

    if (!page) {
      return {
        valid: false,
        reason: 'Failed to create browser page',
        canAccessManager: false,
        canExportCsv: false
      };
    }

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    );

    await applyCookies(page, cookies);

    // Try to access Manager
    await page.goto(MFC_MANAGER_URL, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check for blocks
    if (await isBlockedPage(page)) {
      return {
        valid: false,
        reason: 'Cloudflare or access block detected',
        canAccessManager: false,
        canExportCsv: false
      };
    }

    // Check login status
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      return {
        valid: false,
        reason: 'Not authenticated - cookies may be expired or invalid',
        canAccessManager: false,
        canExportCsv: false
      };
    }

    // Check if CSV Export is available
    const exportLink = await page.$(SELECTORS.exportTrigger);
    const canExport = exportLink !== null;

    return {
      valid: true,
      canAccessManager: true,
      canExportCsv: canExport
    };

  } catch (error: any) {
    console.error('[MFC CSV] Cookie validation failed:', error.message);

    return {
      valid: false,
      reason: error.message.includes('timeout')
        ? 'Request timed out'
        : `Validation error: ${error.message}`,
      canAccessManager: false,
      canExportCsv: false
    };
  } finally {
    if (context && typeof context.close === 'function') {
      await context.close().catch(() => {});
    }
  }
}
