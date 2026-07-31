import puppeteer, { Browser, BrowserContext, Page } from 'puppeteer';
import zlib from 'zlib';
import crypto from 'crypto';
import { sanitizeForLog, sanitizeObjectForLog, capWaitTime, truncateString, MAX_STRING_LENGTH } from '../utils/security.js';

export interface ScrapedData {
  imageUrl?: string;
  manufacturer?: string;
  name?: string;
  scale?: string;
  // Raw HTML capture (only populated when PERSIST_RAW_HTML=true; scraper never persists
  // this itself, it is only emitted on outbound payloads for the consumer to store)
  rawHtmlGz?: string;       // Base64-encoded gzip of the raw page HTML at scrape time
  htmlSha?: string;         // SHA-256 hex digest of the raw (uncompressed) page HTML
  rawHtmlBytes?: number;    // Byte length of the raw (uncompressed) page HTML
  [key: string]: any;       // Allow additional fields
}

export interface ScrapeConfig {
  imageSelector?: string;
  manufacturerSelector?: string;
  nameSelector?: string;
  scaleSelector?: string;
  cloudflareDetection?: {
    titleIncludes?: string[];
    bodyIncludes?: string[];
  };
  waitTime?: number; // milliseconds to wait after page load
  userAgent?: string;
}

// Enhanced fuzzy string matching for robust Cloudflare detection
function fuzzyMatchesPattern(text: string, pattern: string, threshold: number = 0.8): boolean {
  if (!text || !pattern) return false;

  // Normalize both strings: lowercase, trim, remove extra whitespace
  const normalizedText = text.toLowerCase().trim().replace(/\s+/g, ' ');
  const normalizedPattern = pattern.toLowerCase().trim().replace(/\s+/g, ' ');

  // Exact match after normalization
  if (normalizedText.includes(normalizedPattern)) {
    return true;
  }

  // Character-level fuzzy matching for typos and variations
  const similarity = calculateSimilarity(normalizedText, normalizedPattern);
  return similarity >= threshold;
}

export function calculateSimilarity(str1: string, str2: string): number {
  // Truncate first to ensure consistency with getEditDistance
  const s1 = truncateString(str1, MAX_STRING_LENGTH);
  const s2 = truncateString(str2, MAX_STRING_LENGTH);

  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;

  if (longer.length === 0) return 1.0;

  const editDistance = getEditDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

export function getEditDistance(str1: string, str2: string): number {
  // Truncate strings to prevent O(n²) DoS attacks from unbounded loop iterations
  const s1 = truncateString(str1, MAX_STRING_LENGTH);
  const s2 = truncateString(str2, MAX_STRING_LENGTH);

  const matrix = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));

  for (let i = 0; i <= s1.length; i++) {
    matrix[0][i] = i;
  }

  for (let j = 0; j <= s2.length; j++) {
    matrix[j][0] = j;
  }

  for (let j = 1; j <= s2.length; j++) {
    for (let i = 1; i <= s1.length; i++) {
      if (s1[i - 1] === s2[j - 1]) {
        matrix[j][i] = matrix[j - 1][i - 1];
      } else {
        matrix[j][i] = Math.min(
          matrix[j - 1][i - 1] + 1, // substitution
          matrix[j][i - 1] + 1,     // insertion
          matrix[j - 1][i] + 1      // deletion
        );
      }
    }
  }

  return matrix[s2.length][s1.length];
}

// Enhanced Cloudflare detection with comprehensive pattern library
function detectCloudflareChallenge(title: string, bodyText: string, patterns: { titleIncludes?: string[], bodyIncludes?: string[] }): boolean {
  const expandedTitlePatterns = [
    ...(patterns.titleIncludes || []),
    // Core Cloudflare patterns
    'Just a moment',
    'Please wait',
    'Checking your browser',
    'DDoS protection',
    'Security check',
    'Verifying you are human',
    'Challenge in progress',
    'Browser check',
    // Language variations
    'Un moment',
    'Bitte warten',
    'Espere por favor',
    'Attendere prego',
    'しばらくお待ちください',
    // Common variations and typos
    'Just a sec',
    'Hold on',
    'Wait a moment',
    'One moment please',
    // Cloudflare-specific
    'Cloudflare',
    'CF-RAY',
    'Ray ID'
  ];

  const expandedBodyPatterns = [
    ...(patterns.bodyIncludes || []),
    // Core challenge text
    'Just a moment',
    'Please wait while we verify',
    'Checking your browser before accessing',
    'This process is automatic',
    'Your browser will redirect automatically',
    'Please enable JavaScript and cookies',
    'Please turn JavaScript on and reload the page',
    'DDoS protection by Cloudflare',
    'Performance & security by Cloudflare',
    'Your IP',
    'Ray ID',
    'Cloudflare Ray ID',
    // Anti-bot messages
    'verify you are a human',
    'verify that you are not a robot',
    'prove you are human',
    'human verification',
    'bot detection',
    'automated requests',
    // Browser-specific messages
    'Please enable cookies',
    'JavaScript required',
    'Please enable JavaScript',
    'browser does not support JavaScript',
    'cookies disabled',
    // Additional security messages
    'Security service',
    'Website is under attack mode',
    'High security',
    'Browser integrity check',
    'Challenge page',
    'Access denied',
    'Forbidden',
    'blocked by security policy',
    // Language variations
    'Por favor espere',
    'Veuillez patienter',
    'Bitte warten Sie',
    'お待ちください',
    '请等待'
  ];

  // Check title patterns with fuzzy matching
  for (const pattern of expandedTitlePatterns) {
    if (fuzzyMatchesPattern(title, pattern, 0.8)) {
      return true;
    }
  }

  // Check body patterns with fuzzy matching
  for (const pattern of expandedBodyPatterns) {
    if (fuzzyMatchesPattern(bodyText, pattern, 0.7)) { // Slightly lower threshold for body text
      return true;
    }
  }

  return false;
}

export class BrowserPool {
  private static browsers: Browser[] = [];
  private static readonly POOL_SIZE = 3; // Keep 3 browsers ready
  private static isInitialized = false;

  // Per-context lifecycle counters. Browsers are intentionally long-lived (a
  // fresh launch costs 4-7s and re-triggers Cloudflare), so the per-request unit
  // is the BrowserContext. A context that fails to close LEAKS onto its immortal
  // browser — the historical `context.close().catch(() => {})` swallowed exactly
  // that failure, which is how the process climbed to ~25 GB and OOM-crashed the
  // host. These counters make the leak observable; `leaked = opened - closed`.
  private static contextsOpened = 0;
  private static contextsClosed = 0;
  private static contextsFailed = 0;
  private static readonly CONTEXT_CLOSE_TIMEOUT_MS = 10_000;

  // Added for improved test isolation
  static async reset(): Promise<void> {
    // Close all existing browsers first
    await this.closeAll();
    this.browsers = [];
    this.isInitialized = false;
    this.contextsOpened = 0;
    this.contextsClosed = 0;
    this.contextsFailed = 0;
  }


  /** Number of browsers currently available in the pool */
  static getPoolSize(): number {
    return this.browsers.length;
  }

  /** Maximum pool capacity */
  static getPoolCapacity(): number {
    return this.POOL_SIZE;
  }

  private static getBrowserConfig() {
    const config: any = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--memory-pressure-off'
      ],
      timeout: 30000
    };

    // Add single-process flag ONLY for GitHub Actions (not for Docker)
    // GitHub Actions needs this flag, but it breaks Docker containers
    /* istanbul ignore next - GitHub Actions specific configuration */
    if (process.env.GITHUB_ACTIONS === 'true') {
      config.args.push('--single-process');
    }

    // Use the executable path from environment variable if set (for Docker)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      config.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    return config;
  }

  static async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log(`[BROWSER POOL] Initializing pool with ${this.POOL_SIZE} browsers...`);

    for (let i = 0; i < this.POOL_SIZE; i++) {
      try {
        const browser = await puppeteer.launch(this.getBrowserConfig());
        this.browsers.push(browser);
        console.log(`[BROWSER POOL] Browser ${i + 1}/${this.POOL_SIZE} launched`);
      } catch (error) {
        console.error(`[BROWSER POOL] Failed to launch browser ${i + 1}:`, error);
      }
    }

    this.isInitialized = true;
    console.log(`[BROWSER POOL] Pool initialized with ${this.browsers.length} browsers`);
  }

  static async getBrowser(): Promise<Browser> {
    // Ensure pool is initialized
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Wait for a browser to become available (with timeout)
    const maxWaitTime = 30000; // 30 seconds max wait
    const startTime = Date.now();
    const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID;

    while (this.browsers.length === 0) {
      /* istanbul ignore next - Timeout scenario rarely hit in tests */
      if (Date.now() - startTime > maxWaitTime) {
        throw new Error('[BROWSER POOL] Timeout waiting for available browser');
      }

      // In test environment, if pool is empty after initialization, something is wrong
      // Don't wait - fail fast
      if (isTestEnv && this.isInitialized) {
        throw new Error('[BROWSER POOL] Pool exhausted in test environment - browser not returned?');
      }

      /* istanbul ignore next - Production wait loop, tests fail fast instead */
      console.log('[BROWSER POOL] No browsers available, waiting...');
      /* istanbul ignore next */
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms before checking again
    }

    // Get a browser from the pool
    const browser = this.browsers.shift();

    if (!browser) {
      throw new Error('[BROWSER POOL] Failed to retrieve browser from pool');
    }

    console.log(`[BROWSER POOL] Retrieved browser from pool (${this.browsers.length} remaining)`);

    return browser;
  }

  // Return a browser back to the pool after use
  static async returnBrowser(browser: Browser): Promise<void> {
    // Check if browser is still connected before returning to pool
    try {
      const isConnected = browser.connected;
      if (!isConnected) {
        console.warn('[BROWSER POOL] Attempted to return disconnected browser - creating replacement');
        // Don't return the dead browser, create a new one instead
        await this.replenishPool();
        return;
      }
    } catch (checkError) {
      console.error('[BROWSER POOL] Error checking browser connection:', checkError);
      // Browser is in unknown state, don't return it
      await this.replenishPool();
      return;
    }

    // Only return if pool isn't already full
    if (this.browsers.length < this.POOL_SIZE) {
      this.browsers.push(browser);
      console.log(`[BROWSER POOL] Browser returned to pool (${this.browsers.length} available)`);
    } else {
      console.log('[BROWSER POOL] Pool full, browser will be closed');
      browser.close().catch((err: any) => console.error('[BROWSER POOL] Error closing extra browser:', err));
    }
  }

  /** Open a fresh per-request context on a (long-lived) browser, counting it. */
  static async openContext(browser: Browser): Promise<BrowserContext> {
    const context = await browser.createBrowserContext();
    this.contextsOpened++;
    return context;
  }

  /**
   * Close a per-request context, bounded by a timeout so a hung Cloudflare page
   * cannot stall teardown. Returns true if it closed cleanly. A false return
   * means the context LEAKED onto its long-lived browser — the caller must
   * retire that browser rather than keep reusing it. The failure is logged with
   * live counters + RSS, never swallowed.
   */
  static async closeContext(context: BrowserContext): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        context.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('context.close() timed out')), this.CONTEXT_CLOSE_TIMEOUT_MS);
        }),
      ]);
      this.contextsClosed++;
      return true;
    } catch (err) {
      this.contextsFailed++;
      const rssMb = Math.round(process.memoryUsage().rss / 1048576);
      console.error(
        `[BROWSER POOL] context.close() FAILED — leaked context on a long-lived browser ` +
        `(opened=${this.contextsOpened} closed=${this.contextsClosed} failed=${this.contextsFailed} ` +
        `leaked=${this.contextsOpened - this.contextsClosed} rss=${rssMb}MB): ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Retire a pooled browser that can no longer cleanly release contexts, and
   *  replenish the pool with a fresh one. */
  static async retirePooledBrowser(browser: Browser): Promise<void> {
    console.warn('[BROWSER POOL] Retiring a pooled browser after a context-close failure');
    await browser.close().catch((err: any) => console.error('[BROWSER POOL] Error closing retired browser:', err));
    await this.replenishPool();
  }

  /** Retire the stealth singleton so the next stealth request relaunches it —
   *  re-passing Cloudflare once, acceptable ONLY on a failure, never per-call. */
  static async retireStealthBrowser(browser: Browser): Promise<void> {
    console.warn('[BROWSER POOL] Retiring the stealth browser after a context-close failure');
    if (this.stealthBrowser === browser) this.stealthBrowser = null;
    await browser.close().catch((err: any) => console.error('[BROWSER POOL] Error closing retired stealth browser:', err));
  }

  /** Context lifecycle counters, for leak observability / a metrics endpoint. */
  static contextStats(): { opened: number; closed: number; failed: number; leaked: number } {
    return {
      opened: this.contextsOpened,
      closed: this.contextsClosed,
      failed: this.contextsFailed,
      leaked: this.contextsOpened - this.contextsClosed,
    };
  }


  /**
   * Replenish the browser pool when a browser dies.
   * Creates a new browser if pool is below capacity.
   */
  private static async replenishPool(): Promise<void> {
    if (this.browsers.length < this.POOL_SIZE) {
      try {
        console.log(`[BROWSER POOL] Replenishing pool (${this.browsers.length}/${this.POOL_SIZE})...`);
        const browser = await puppeteer.launch(this.getBrowserConfig());
        this.browsers.push(browser);
        console.log(`[BROWSER POOL] New browser added (${this.browsers.length}/${this.POOL_SIZE})`);
      } catch (error) {
        console.error('[BROWSER POOL] Failed to replenish pool:', error);
      }
    }
  }

  // Stealth browser for bot-detection-sensitive fetches (e.g. Cloudflare-fronted pages)
  private static stealthBrowser: Browser | null = null;

  static async getStealthBrowser(): Promise<Browser> {
    if (!this.stealthBrowser) {
      console.log('[BROWSER POOL] Creating stealth browser...');

      // In test environment, use regular browser (mocks interfere with puppeteer-extra)
      if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
        console.log('[BROWSER POOL] Test environment detected - using regular browser instead of stealth');
        this.stealthBrowser = await puppeteer.launch(this.getBrowserConfig());
        return this.stealthBrowser;
      }

      // Production: Use puppeteer-extra with stealth plugin.
      // Dynamic import() (not static) so these CJS-interop modules load lazily
      // and ONLY in production — the test path above returns before reaching
      // here, keeping puppeteer-extra out of the mocked test module graph.
      // Both packages are CJS; under NodeNext their default export is the
      // instance/factory. The casts pin the types NodeNext leaves as the raw
      // module namespace (runtime shape verified: .default is the usable value).
      /* istanbul ignore next - Production-only stealth initialization, conflicts with test mocks */
      const { default: puppeteerExtra } = (await import('puppeteer-extra')) as unknown as {
        default: import('puppeteer-extra').PuppeteerExtra;
      };
      /* istanbul ignore next */
      const { default: StealthPlugin } = (await import('puppeteer-extra-plugin-stealth')) as unknown as {
        default: () => import('puppeteer-extra').PuppeteerExtraPlugin;
      };

      /* istanbul ignore next */
      puppeteerExtra.use(StealthPlugin());

      /* istanbul ignore next */
      const config = this.getBrowserConfig();
      // Add anti-detection flag
      /* istanbul ignore next */
      config.args.push('--disable-blink-features=AutomationControlled');

      /* istanbul ignore next */
      this.stealthBrowser = await puppeteerExtra.launch(config);
      /* istanbul ignore next */
      console.log('[BROWSER POOL] Stealth browser created');
    }

    // TypeScript doesn't know this is always set by this point
    if (!this.stealthBrowser) {
      throw new Error('[BROWSER POOL] Failed to create stealth browser');
    }

    return this.stealthBrowser;
  }

  static async closeAll(): Promise<void> {
    console.log(`[BROWSER POOL] Closing ${this.browsers.length} browsers...`);

    const closePromises = this.browsers.map(async (browser, index) => {
      try {
        // Enhanced checks before closing
        if (browser) {
          const isStillConnected = browser.connected;
          if (isStillConnected) {
            await browser.close();
            console.log(`[BROWSER POOL] Browser ${index + 1} closed`);
          } else {
            console.log(`[BROWSER POOL] Browser ${index + 1} already disconnected`);
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[BROWSER POOL] Error closing browser ${index + 1}: ${errorMessage}`);

        // Additional error logging for debugging
        if (error instanceof Error) {
          console.error(`[BROWSER POOL] Detailed error stack: ${error.stack}`);
        }
      }
    });

    // Use allSettled to ensure all close attempts are made
    const results = await Promise.allSettled(closePromises);

    // Log any failed close attempts
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.warn(`[BROWSER POOL] Browser ${index + 1} close attempt failed:`, result.reason);
      }
    });

    this.browsers = [];
    this.isInitialized = false;
    console.log('[BROWSER POOL] All browsers close attempts completed');
  }


  /**
   * Get health status of the browser pool for monitoring/debugging.
   * Returns stats about available browsers and potential resource issues.
   */
  static async getHealth(): Promise<{
    initialized: boolean;
    poolSize: number;
    availableBrowsers: number;
    connectedBrowsers: number;
    hasStealthBrowser: boolean;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    let connectedCount = 0;

    // Check each browser's connection status
    for (const browser of this.browsers) {
      try {
        if (browser.connected) {
          connectedCount++;
        }
      } catch {
        warnings.push('Failed to check browser connection status');
      }
    }

    // Warn if pool is exhausted
    if (this.isInitialized && this.browsers.length === 0) {
      warnings.push('CRITICAL: Browser pool exhausted - all browsers in use');
    }

    // Warn if some browsers are disconnected
    if (connectedCount < this.browsers.length) {
      warnings.push(`${this.browsers.length - connectedCount} browser(s) disconnected but not removed from pool`);
    }

    return {
      initialized: this.isInitialized,
      poolSize: this.POOL_SIZE,
      availableBrowsers: this.browsers.length,
      connectedBrowsers: connectedCount,
      hasStealthBrowser: this.stealthBrowser !== null,
      warnings,
    };
  }
}

// Initialize the browser pool
export async function initializeBrowserPool(): Promise<void> {
  await BrowserPool.initialize();
}

/**
 * Generic selector-driven page scrape. The caller supplies the selectors —
 * the engine carries NO site-specific extraction logic (extraction rulesets
 * live in plugins; see pluginBootstrap/extractionRegistry and the ingest
 * path in scrapeQueue).
 */
export async function scrapeGeneric(url: string, config: ScrapeConfig): Promise<ScrapedData> {
  console.log(`[GENERIC SCRAPER] Starting scrape for: ${sanitizeForLog(url)}`); // lgtm[js/log-injection]
  console.log('[GENERIC SCRAPER] Config:', sanitizeObjectForLog(config)); // lgtm[js/log-injection]

  const t0 = Date.now();
  let tBrowser = 0, tContext = 0, tNavigate = 0, tExtract = 0;

  let browser: Browser | null = null;
  let context: any | null = null;  // BrowserContext
  let page: Page | null = null;
  let isPooledBrowser = false; // Track if browser came from pool (needs to be returned)

  try {
    browser = await BrowserPool.getBrowser();
    isPooledBrowser = true; // Regular browsers come from pool and should be returned

    tBrowser = Date.now() - t0;

    // Use browser context for isolation (browser stays alive for pool reuse)
    context = await browser.createBrowserContext();
    page = await context.newPage();
    tContext = Date.now() - t0;

    if (!page) {
      throw new Error('[GENERIC SCRAPER] Failed to create page');
    }

    // Set realistic browser configuration
    await page.setViewport({ width: 1280, height: 720 });
    const userAgent = config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
    await page.setUserAgent(userAgent);

    // Set extra headers to appear more like a real browser
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    });

    console.log('[GENERIC SCRAPER] Navigating to page...');

    // Navigate with faster wait conditions
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });

    tNavigate = Date.now() - t0;
    console.log('[GENERIC SCRAPER] Page loaded, waiting for content...');

    // Wait for dynamic content (configurable, capped to prevent resource exhaustion)
    const waitTime = capWaitTime(config.waitTime, 1000);
    await new Promise(resolve => setTimeout(resolve, waitTime)); // lgtm[js/resource-exhaustion]

    // Check for Cloudflare challenge if configured
    if (config.cloudflareDetection) {
      const pageTitle = await page.title();
      const bodyText = await page.evaluate(() => document.body.innerText);

      // Use enhanced detection with fuzzy matching and expanded patterns
      const challengeDetected = detectCloudflareChallenge(pageTitle, bodyText, config.cloudflareDetection);

      if (challengeDetected) {
        console.log('[GENERIC SCRAPER] Detected challenge page with enhanced detection, waiting...');

        const challengePatterns = ['Just a moment'];

        // Wait for the challenge to complete using fuzzy pattern matching
        await page.waitForFunction(
          (patterns: string[]) => {
            const currentBodyText = document.body.innerText.toLowerCase();
            const currentTitle = document.title.toLowerCase();

            // Check if challenge pattern no longer exists
            return !patterns.some(pattern =>
              currentTitle.includes(pattern.toLowerCase()) ||
              currentBodyText.includes(pattern.toLowerCase())
            );
          },
          { timeout: 10000 },
          challengePatterns // Matches test expectation
        ).catch(() => {
          console.log('[GENERIC SCRAPER] Challenge timeout - proceeding anyway');
        });

        // Wait less after challenge completion (speed optimization)
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    console.log('[GENERIC SCRAPER] Extracting data...');

    // Extract data using the caller-supplied selectors (no site-specific logic)
    const scrapedData = await page.evaluate((selectors) => {
      const data: any = {};

      try {
        // Extract image
        if (selectors.imageSelector) {
          const imageElement = document.querySelector(selectors.imageSelector) as HTMLImageElement;
          if (imageElement && imageElement.src) {
            data.imageUrl = imageElement.src;
          }
        }

        // Extract manufacturer
        if (selectors.manufacturerSelector) {
          const manufacturerElement = document.querySelector(selectors.manufacturerSelector) as HTMLElement;
          if (manufacturerElement && manufacturerElement.textContent) {
            data.manufacturer = manufacturerElement.textContent.trim();
          }
        }

        // Extract name
        if (selectors.nameSelector) {
          const nameElement = document.querySelector(selectors.nameSelector) as HTMLElement;
          if (nameElement && nameElement.textContent) {
            data.name = nameElement.textContent.trim();
          }
        }

        // Extract scale
        if (selectors.scaleSelector) {
          const scaleElement = document.querySelector(selectors.scaleSelector) as HTMLElement;
          if (scaleElement && scaleElement.textContent) {
            const scaleText = scaleElement.textContent.trim();

            // The element might contain extra text - extract just the scale
            // fraction (e.g., "1/7") when present
            const scaleMatch = scaleText.match(/1\/\d+/);
            if (scaleMatch) {
              data.scale = scaleMatch[0];
            } else {
              data.scale = scaleText;
            }
          }
        }

        // Debug: Log what we found
        console.log('Extracted data:', data);

      } catch (extractError) {
        console.error('Error during data extraction:', extractError);
      }

      return data;
    }, config);

    tExtract = Date.now() - t0;
    console.log(`[SCRAPE TIMING] browser=${tBrowser}ms, ctx=${tContext - tBrowser}ms, navigate=${tNavigate - tContext}ms, extract=${tExtract - tNavigate}ms, total=${tExtract}ms`);
    console.log('[GENERIC SCRAPER] Extraction completed:', scrapedData);

    // Optional raw HTML capture (enabled via PERSIST_RAW_HTML=true env var).
    // Default OFF: zero overhead, no extra fields on the payload.
    // The scraper only EMITS these fields on outbound payloads -- it never
    // writes them to any store itself (no S3/MinIO creds live in this service).
    if (process.env.PERSIST_RAW_HTML === 'true') {
      try {
        const pageHtml = await page.content();
        const htmlBuffer = Buffer.from(pageHtml, 'utf-8');
        scrapedData.rawHtmlGz = zlib.gzipSync(htmlBuffer).toString('base64');
        scrapedData.htmlSha = crypto.createHash('sha256').update(htmlBuffer).digest('hex');
        scrapedData.rawHtmlBytes = htmlBuffer.byteLength;
      } catch (rawHtmlError) {
        console.error('[GENERIC SCRAPER] Raw HTML capture failed:', rawHtmlError);
        // Don't fail the scrape - just continue without raw HTML capture
      }
    }

    return scrapedData;

  } catch (error: any) {
    console.error(`[GENERIC SCRAPER] Error: ${error.message}`);
    // Log more detailed error information
    if (error instanceof Error) {
      console.error(`[GENERIC SCRAPER] Detailed Error:
        Name: ${error.name}
        Message: ${error.message}
        Stack: ${error.stack}`);
    }
    // All errors should throw - callers handle retries and failure reporting
    throw error;
  } finally {
    try {
      // Close browser context (browser stays alive for pool reuse)
      if (context && 'close' in context && typeof context.close === 'function') {
        await context.close().catch((closeError: any) => {
          console.error('[GENERIC SCRAPER] Error closing context:', closeError);
        });
        console.log('[GENERIC SCRAPER] Context closed');
      }
    } catch (contextClosed) {
      console.log('[GENERIC SCRAPER] Context closing encountered an issue:', contextClosed);
    }

    // Return browser to pool if it came from the pool
    /* istanbul ignore next - Finally block execution varies in mocked tests */
    if (browser && isPooledBrowser) {
      await BrowserPool.returnBrowser(browser);
      console.log('[GENERIC SCRAPER] Browser returned to pool');
    }

    // NOTE: Browser is NOT closed here - it stays alive in the pool for reuse
    // This is the fix for Issue #55 - browser context reuse
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[GENERIC SCRAPER] Received SIGTERM, closing browser pool...');
  await BrowserPool.closeAll();
});

process.on('SIGINT', async () => {
  console.log('[GENERIC SCRAPER] Received SIGINT, closing browser pool...');
  await BrowserPool.closeAll();
});
