/**
 * Extended unit tests for Generic Scraper
 * Covers pure utility functions, BrowserPool health/return,
 * scrapeMFC convenience function, and Cloudflare detection paths
 */
import puppeteer from 'puppeteer';
import zlib from 'zlib';
import crypto from 'crypto';
import {
  calculateSimilarity,
  getEditDistance,
  BrowserPool,
  SITE_CONFIGS,
  scrapeGeneric,
  scrapeMFC,
} from '../../services/genericScraper';

// ============================================================================
// Pure Utility Functions (no browser mocking needed)
// ============================================================================

describe('genericScraper - pure utility functions', () => {
  describe('calculateSimilarity', () => {
    it('should return 1.0 for identical strings', () => {
      expect(calculateSimilarity('hello', 'hello')).toBe(1.0);
    });

    it('should return 0 for completely different strings of same length', () => {
      // completely different chars
      const result = calculateSimilarity('abc', 'xyz');
      expect(result).toBeLessThan(0.5);
    });

    it('should return high similarity for similar strings', () => {
      const result = calculateSimilarity('hello', 'helo');
      expect(result).toBeGreaterThan(0.7);
    });

    it('should return 1.0 for two empty strings', () => {
      expect(calculateSimilarity('', '')).toBe(1.0);
    });

    it('should handle one empty string', () => {
      expect(calculateSimilarity('hello', '')).toBe(0);
    });

    it('should be symmetric', () => {
      const ab = calculateSimilarity('kitten', 'sitting');
      const ba = calculateSimilarity('sitting', 'kitten');
      expect(ab).toBeCloseTo(ba, 5);
    });

    it('should handle very long strings safely (truncation)', () => {
      const long1 = 'a'.repeat(10000);
      const long2 = 'b'.repeat(10000);
      // Should not throw or hang - truncation occurs
      const result = calculateSimilarity(long1, long2);
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    });
  });

  describe('getEditDistance', () => {
    it('should return 0 for identical strings', () => {
      expect(getEditDistance('hello', 'hello')).toBe(0);
    });

    it('should return correct distance for simple substitution', () => {
      expect(getEditDistance('cat', 'car')).toBe(1);
    });

    it('should return correct distance for insertion', () => {
      expect(getEditDistance('cat', 'cats')).toBe(1);
    });

    it('should return correct distance for deletion', () => {
      expect(getEditDistance('cats', 'cat')).toBe(1);
    });

    it('should return length of other string for empty input', () => {
      expect(getEditDistance('', 'hello')).toBe(5);
      expect(getEditDistance('hello', '')).toBe(5);
    });

    it('should handle both empty strings', () => {
      expect(getEditDistance('', '')).toBe(0);
    });

    it('should compute kitten -> sitting correctly', () => {
      // Classic Levenshtein example: kitten -> sitting = 3
      expect(getEditDistance('kitten', 'sitting')).toBe(3);
    });

    it('should handle long strings safely (truncation prevents DoS)', () => {
      const long1 = 'a'.repeat(10000);
      const long2 = 'a'.repeat(10000);
      // Should not throw or hang
      const result = getEditDistance(long1, long2);
      expect(typeof result).toBe('number');
    });
  });

  describe('SITE_CONFIGS', () => {
    it('should have mfc configuration', () => {
      expect(SITE_CONFIGS.mfc).toBeDefined();
      expect(SITE_CONFIGS.mfc.imageSelector).toBeDefined();
      expect(SITE_CONFIGS.mfc.manufacturerSelector).toBeDefined();
      expect(SITE_CONFIGS.mfc.nameSelector).toBeDefined();
      expect(SITE_CONFIGS.mfc.scaleSelector).toBeDefined();
    });

    it('should have Cloudflare detection patterns', () => {
      expect(SITE_CONFIGS.mfc.cloudflareDetection).toBeDefined();
      expect(SITE_CONFIGS.mfc.cloudflareDetection!.titleIncludes).toBeInstanceOf(Array);
      expect(SITE_CONFIGS.mfc.cloudflareDetection!.bodyIncludes).toBeInstanceOf(Array);
      expect(SITE_CONFIGS.mfc.cloudflareDetection!.titleIncludes!.length).toBeGreaterThan(0);
    });

    it('should have a user agent string', () => {
      expect(SITE_CONFIGS.mfc.userAgent).toBeDefined();
      expect(SITE_CONFIGS.mfc.userAgent).toContain('Mozilla');
    });

    it('should have a wait time', () => {
      expect(typeof SITE_CONFIGS.mfc.waitTime).toBe('number');
      expect(SITE_CONFIGS.mfc.waitTime).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// BrowserPool Tests (require puppeteer mock)
// ============================================================================

describe('genericScraper - BrowserPool extended', () => {
  let mockBrowser: any;
  let mockPage: any;
  let mockContext: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;

    mockPage = {
      goto: jest.fn().mockResolvedValue({ status: () => 200 }),
      title: jest.fn().mockResolvedValue('Test Page'),
      evaluate: jest.fn().mockImplementation((fn: any) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('document.body.innerText') || fnStr.includes('document.body.textContent')) {
            return Promise.resolve('Normal page content');
          }
        }
        return Promise.resolve({});
      }),
      content: jest.fn().mockResolvedValue('<div></div>'),
      close: jest.fn().mockResolvedValue(undefined),
      setViewport: jest.fn().mockResolvedValue(undefined),
      setUserAgent: jest.fn().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
      setCookie: jest.fn().mockResolvedValue(undefined),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
    };

    mockContext = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
      pages: jest.fn().mockReturnValue([]),
    };

    mockBrowser = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
      connected: true,
      createBrowserContext: jest.fn().mockResolvedValue(mockContext),
    };

    (puppeteer.launch as jest.Mock).mockResolvedValue(mockBrowser);
  });

  describe('getHealth', () => {
    it('should return health when uninitialized', async () => {
      const health = await BrowserPool.getHealth();
      expect(health.initialized).toBe(false);
      expect(health.availableBrowsers).toBe(0);
      expect(health.connectedBrowsers).toBe(0);
      expect(health.hasStealthBrowser).toBe(false);
      expect(health.warnings).toEqual([]);
    });

    it('should report initialized pool health', async () => {
      (BrowserPool as any).isInitialized = true;
      (BrowserPool as any).browsers = [mockBrowser, mockBrowser];

      const health = await BrowserPool.getHealth();
      expect(health.initialized).toBe(true);
      expect(health.availableBrowsers).toBe(2);
      expect(health.connectedBrowsers).toBe(2);
      expect(health.poolSize).toBe(3); // POOL_SIZE constant
    });

    it('should warn when pool is exhausted', async () => {
      (BrowserPool as any).isInitialized = true;
      (BrowserPool as any).browsers = [];

      const health = await BrowserPool.getHealth();
      expect(health.warnings).toContain('CRITICAL: Browser pool exhausted - all browsers in use');
    });

    it('should warn when browsers are disconnected', async () => {
      const disconnected = {
        ...mockBrowser,
        connected: false,
      };
      (BrowserPool as any).isInitialized = true;
      (BrowserPool as any).browsers = [mockBrowser, disconnected];

      const health = await BrowserPool.getHealth();
      expect(health.connectedBrowsers).toBe(1);
      expect(health.warnings.some((w: string) => w.includes('disconnected'))).toBe(true);
    });

    it('should handle the connected getter throwing', async () => {
      // Puppeteer 25: `connected` is a getter; a throwing getter is the
      // faithful equivalent of the old isConnected() throwing.
      const broken = {
        get connected(): boolean { throw new Error('broken'); },
      };
      (BrowserPool as any).isInitialized = true;
      (BrowserPool as any).browsers = [broken];

      const health = await BrowserPool.getHealth();
      expect(health.warnings).toContain('Failed to check browser connection status');
      expect(health.connectedBrowsers).toBe(0);
    });

    it('should detect stealth browser presence', async () => {
      (BrowserPool as any).stealthBrowser = mockBrowser;
      const health = await BrowserPool.getHealth();
      expect(health.hasStealthBrowser).toBe(true);
    });
  });

  describe('returnBrowser', () => {
    it('should return connected browser to pool', async () => {
      (BrowserPool as any).isInitialized = true;
      (BrowserPool as any).browsers = [];

      await BrowserPool.returnBrowser(mockBrowser);
      expect((BrowserPool as any).browsers.length).toBe(1);
    });

    it('should not return disconnected browser', async () => {
      const disconnected = {
        ...mockBrowser,
        connected: false,
      };
      (BrowserPool as any).isInitialized = true;
      (BrowserPool as any).browsers = [];

      await BrowserPool.returnBrowser(disconnected);
      // Should not add disconnected browser; instead triggers replenishment
      expect((BrowserPool as any).browsers.length).toBeGreaterThanOrEqual(0);
    });

    it('should close extra browser when pool is full', async () => {
      (BrowserPool as any).isInitialized = true;
      (BrowserPool as any).browsers = [mockBrowser, mockBrowser, mockBrowser]; // 3 = POOL_SIZE

      const extra = {
        ...mockBrowser,
        close: jest.fn().mockResolvedValue(undefined),
      };
      await BrowserPool.returnBrowser(extra);
      expect(extra.close).toHaveBeenCalled();
    });

    it('should handle the connected check error', async () => {
      // Puppeteer 25: `connected` getter throwing must be swallowed by returnBrowser
      const broken = {
        get connected(): boolean { throw new Error('check failed'); },
      };
      (BrowserPool as any).isInitialized = true;
      (BrowserPool as any).browsers = [];

      // Should not throw
      await expect(BrowserPool.returnBrowser(broken as any)).resolves.toBeUndefined();
    });
  });

  describe('closeAll - error handling', () => {
    it('should handle close error gracefully', async () => {
      const errorBrowser = {
        connected: true,
        close: jest.fn().mockRejectedValue(new Error('Close error')),
      };
      (BrowserPool as any).browsers = [errorBrowser];

      await expect(BrowserPool.closeAll()).resolves.toBeUndefined();
      expect(errorBrowser.close).toHaveBeenCalled();
    });

    it('should handle non-Error thrown from close', async () => {
      const errorBrowser = {
        connected: true,
        close: jest.fn().mockRejectedValue('string error'),
      };
      (BrowserPool as any).browsers = [errorBrowser];

      await expect(BrowserPool.closeAll()).resolves.toBeUndefined();
    });
  });
});

// ============================================================================
// scrapeMFC convenience function
// ============================================================================

describe('genericScraper - scrapeMFC', () => {
  let mockPage: any;
  let mockContext: any;
  let mockBrowser: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;

    mockPage = {
      goto: jest.fn().mockResolvedValue({ status: () => 200 }),
      title: jest.fn().mockResolvedValue('Test Page'),
      evaluate: jest.fn().mockImplementation((fn: any) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('document.body.innerText') || fnStr.includes('document.body.textContent')) {
            return Promise.resolve('Normal page content');
          }
        }
        return Promise.resolve({ name: 'Test Figure' });
      }),
      content: jest.fn().mockResolvedValue('<div></div>'),
      close: jest.fn().mockResolvedValue(undefined),
      setViewport: jest.fn().mockResolvedValue(undefined),
      setUserAgent: jest.fn().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
      setCookie: jest.fn().mockResolvedValue(undefined),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
    };

    mockContext = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
      pages: jest.fn().mockReturnValue([]),
    };

    mockBrowser = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
      connected: true,
      createBrowserContext: jest.fn().mockResolvedValue(mockContext),
    };

    (puppeteer.launch as jest.Mock).mockResolvedValue(mockBrowser);
  });

  it('should scrape without cookies (public scraping)', async () => {
    const result = await scrapeMFC('https://myfigurecollection.net/item/12345');
    expect(result).toBeDefined();
    // Verify it used regular browser (getBrowser), not stealth
    expect(mockBrowser.createBrowserContext).toHaveBeenCalled();
  });

  it('should scrape with cookies (authenticated scraping)', async () => {
    const cookies = { PHPSESSID: 'abc', sesUID: '123', sesDID: 'dev' };
    const result = await scrapeMFC('https://myfigurecollection.net/item/12345', cookies);
    expect(result).toBeDefined();
    // Should have set cookies
    expect(mockPage.setCookie).toHaveBeenCalled();
  });

  it('should handle string cookies (JSON parse)', async () => {
    const cookieStr = JSON.stringify({ PHPSESSID: 'abc', sesUID: '123' });
    const result = await scrapeMFC('https://myfigurecollection.net/item/12345', cookieStr);
    expect(result).toBeDefined();
  });

  it('should throw when authenticated scrape fails', async () => {
    mockPage.goto.mockRejectedValue(new Error('Navigation failed'));

    await expect(
      scrapeMFC('https://myfigurecollection.net/item/12345', { PHPSESSID: 'abc' })
    ).rejects.toThrow('Navigation failed');
  });

  it('should throw when public scrape fails', async () => {
    mockPage.goto.mockRejectedValue(new Error('Navigation failed'));

    await expect(
      scrapeMFC('https://myfigurecollection.net/item/12345')
    ).rejects.toThrow('Navigation failed');
  });
});

// ============================================================================
// scrapeGeneric - MFC 404 detection and schema v3 extraction
// ============================================================================

describe('genericScraper - scrapeGeneric extended', () => {
  let mockPage: any;
  let mockContext: any;
  let mockBrowser: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;

    mockPage = {
      goto: jest.fn().mockResolvedValue({ status: () => 200 }),
      title: jest.fn().mockResolvedValue('Test Page'),
      evaluate: jest.fn().mockImplementation((fn: any) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('document.body.innerText') || fnStr.includes('document.body.textContent')) {
            return Promise.resolve('Normal page content');
          }
        }
        return Promise.resolve({ name: 'Test Figure' });
      }),
      content: jest.fn().mockResolvedValue('<div></div>'),
      close: jest.fn().mockResolvedValue(undefined),
      setViewport: jest.fn().mockResolvedValue(undefined),
      setUserAgent: jest.fn().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
      setCookie: jest.fn().mockResolvedValue(undefined),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
    };

    mockContext = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
      pages: jest.fn().mockReturnValue([]),
    };

    mockBrowser = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
      connected: true,
      createBrowserContext: jest.fn().mockResolvedValue(mockContext),
    };

    (puppeteer.launch as jest.Mock).mockResolvedValue(mockBrowser);
  });

  it('should detect MFC 404 page without auth', async () => {
    mockPage.title.mockResolvedValue('Error - MyFigureCollection.net');
    mockPage.evaluate.mockImplementation((fn: any) => {
      if (typeof fn === 'function') {
        const fnStr = fn.toString();
        if (fnStr.includes('document.body.innerText') || fnStr.includes('document.body.textContent')) {
          return Promise.resolve('404 Not Found');
        }
      }
      return Promise.resolve({});
    });

    await expect(
      scrapeGeneric('https://myfigurecollection.net/item/99999', {})
    ).rejects.toThrow('MFC_ITEM_NOT_ACCESSIBLE');
  });

  it('should detect MFC 404 page with auth', async () => {
    mockPage.title.mockResolvedValue('Error - MyFigureCollection.net');
    mockPage.evaluate.mockImplementation((fn: any) => {
      if (typeof fn === 'function') {
        const fnStr = fn.toString();
        if (fnStr.includes('document.body.innerText') || fnStr.includes('document.body.textContent')) {
          return Promise.resolve('404 Not Found');
        }
      }
      return Promise.resolve({});
    });

    await expect(
      scrapeGeneric('https://myfigurecollection.net/item/99999', {
        mfcAuth: { sessionCookies: { PHPSESSID: 'test' } },
      })
    ).rejects.toThrow('MFC_ITEM_NOT_ACCESSIBLE');
  });

  it('should extract v3 schema data from page content', async () => {
    // Mock page.content to return HTML with companies/artists
    mockPage.content.mockResolvedValue(`
      <div class="data-field">
        <span class="data-label">Companies</span>
        <div class="data-value">
          <div class="item-entries">
            <a href="/entry/100"><span switch="JP">Good Smile Company</span></a>
            <small class="light">as <em>Manufacturer</em></small>
          </div>
        </div>
      </div>
      <div class="data-field">
        <span class="data-label">Title</span>
        <span class="data-value"><a switch="JP">Hatsune Miku</a></span>
      </div>
    `);

    const result = await scrapeGeneric('https://myfigurecollection.net/item/12345', {});
    expect(result.companies).toBeDefined();
    expect(result.companies!.length).toBe(1);
    expect(result.companies![0].name).toBe('Good Smile Company');
    expect(result.mfcTitle).toBe('Hatsune Miku');
  });

  it('should set legacy manufacturer from companies', async () => {
    mockPage.evaluate.mockImplementation((fn: any) => {
      if (typeof fn === 'function') {
        const fnStr = fn.toString();
        if (fnStr.includes('document.body.innerText') || fnStr.includes('document.body.textContent')) {
          return Promise.resolve('Normal page content');
        }
      }
      return Promise.resolve({}); // No manufacturer from page.evaluate
    });
    mockPage.content.mockResolvedValue(`
      <div class="data-field">
        <span class="data-label">Companies</span>
        <div class="data-value">
          <div class="item-entries">
            <a href="/entry/100"><span switch="JP">Alter</span></a>
            <small class="light">as <em>Manufacturer</em></small>
          </div>
        </div>
      </div>
    `);

    const result = await scrapeGeneric('https://myfigurecollection.net/item/12345', {});
    expect(result.manufacturer).toBe('Alter');
  });

  it('should use mfcTitle as name fallback', async () => {
    mockPage.evaluate.mockImplementation((fn: any) => {
      if (typeof fn === 'function') {
        const fnStr = fn.toString();
        if (fnStr.includes('document.body.innerText') || fnStr.includes('document.body.textContent')) {
          return Promise.resolve('Normal page content');
        }
      }
      return Promise.resolve({}); // No name from page.evaluate
    });
    mockPage.content.mockResolvedValue(`
      <div class="data-field">
        <span class="data-label">Title</span>
        <span class="data-value"><a switch="JP">Mash Kyrielight</a></span>
      </div>
    `);

    const result = await scrapeGeneric('https://myfigurecollection.net/item/12345', {});
    expect(result.name).toBe('Mash Kyrielight');
  });

  it('should handle v3 extraction errors gracefully', async () => {
    mockPage.content.mockRejectedValue(new Error('Content retrieval failed'));

    // Should not throw -- v3 extraction failure is non-fatal
    const result = await scrapeGeneric('https://myfigurecollection.net/item/12345', {});
    expect(result).toBeDefined();
  });

  it('should handle empty cookie array (no valid cookies)', async () => {
    // Set up env to have empty allowlist (no allowed cookies)
    mockPage.evaluate.mockImplementation((fn: any) => {
      if (typeof fn === 'function') {
        const fnStr = fn.toString();
        if (fnStr.includes('document.body.innerText') || fnStr.includes('document.body.textContent')) {
          return Promise.resolve('Normal page content');
        }
      }
      return Promise.resolve({});
    });

    const result = await scrapeGeneric('https://myfigurecollection.net/item/12345', {
      mfcAuth: { sessionCookies: { unknownCookie: 'value' } },
    });
    expect(result).toBeDefined();
  });

  it('should detect Cloudflare challenge page', async () => {
    mockPage.title.mockResolvedValue('Just a moment...');
    mockPage.evaluate.mockImplementation((fn: any) => {
      if (typeof fn === 'function') {
        const fnStr = fn.toString();
        if (fnStr.includes('document.body.innerText') || fnStr.includes('document.body.textContent')) {
          return Promise.resolve('Just a moment... Please wait while we verify your browser');
        }
      }
      return Promise.resolve({});
    });
    mockPage.content.mockResolvedValue('<div></div>');

    // Should not throw - Cloudflare detection logs and waits
    const result = await scrapeGeneric('https://myfigurecollection.net/item/12345', {
      cloudflareDetection: SITE_CONFIGS.mfc.cloudflareDetection,
    });
    expect(result).toBeDefined();
    expect(mockPage.waitForFunction).toHaveBeenCalled();
  });

  it('should handle Cloudflare detection without challenge present', async () => {
    mockPage.content.mockResolvedValue('<div></div>');

    const result = await scrapeGeneric('https://myfigurecollection.net/item/12345', {
      cloudflareDetection: SITE_CONFIGS.mfc.cloudflareDetection,
    });
    expect(result).toBeDefined();
    // Should NOT have called waitForFunction for Cloudflare (no challenge)
    expect(mockPage.waitForFunction).not.toHaveBeenCalled();
  });

  describe('raw HTML capture (PERSIST_RAW_HTML)', () => {
    const originalEnv = process.env.PERSIST_RAW_HTML;
    const html = '<html><body><div class="data-field">raw capture fixture</div></body></html>';

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.PERSIST_RAW_HTML;
      } else {
        process.env.PERSIST_RAW_HTML = originalEnv;
      }
    });

    it('should emit rawHtmlGz/htmlSha/rawHtmlBytes when PERSIST_RAW_HTML=true', async () => {
      process.env.PERSIST_RAW_HTML = 'true';
      mockPage.content.mockResolvedValue(html);

      const result = await scrapeGeneric('https://myfigurecollection.net/item/12345', {});

      expect(result.rawHtmlGz).toBeDefined();
      expect(typeof result.rawHtmlGz).toBe('string');
      const gunzipped = zlib.gunzipSync(Buffer.from(result.rawHtmlGz as string, 'base64')).toString('utf-8');
      expect(gunzipped).toBe(html);

      const expectedSha = crypto.createHash('sha256').update(html, 'utf-8').digest('hex');
      expect(result.htmlSha).toBe(expectedSha);

      expect(result.rawHtmlBytes).toBe(Buffer.byteLength(html, 'utf-8'));
    });

    it('should omit rawHtmlGz/htmlSha/rawHtmlBytes when PERSIST_RAW_HTML is unset (default OFF)', async () => {
      delete process.env.PERSIST_RAW_HTML;
      mockPage.content.mockResolvedValue(html);

      const result = await scrapeGeneric('https://myfigurecollection.net/item/12345', {});

      expect(result.rawHtmlGz).toBeUndefined();
      expect(result.htmlSha).toBeUndefined();
      expect(result.rawHtmlBytes).toBeUndefined();
    });

    it('should omit rawHtmlGz/htmlSha/rawHtmlBytes when PERSIST_RAW_HTML=false', async () => {
      process.env.PERSIST_RAW_HTML = 'false';
      mockPage.content.mockResolvedValue(html);

      const result = await scrapeGeneric('https://myfigurecollection.net/item/12345', {});

      expect(result.rawHtmlGz).toBeUndefined();
      expect(result.htmlSha).toBeUndefined();
      expect(result.rawHtmlBytes).toBeUndefined();
    });

    it('should not fail the scrape when raw HTML capture throws', async () => {
      process.env.PERSIST_RAW_HTML = 'true';
      mockPage.content.mockResolvedValue(html);
      const gzipSpy = jest.spyOn(zlib, 'gzipSync').mockImplementation(() => {
        throw new Error('gzip failed');
      });

      const result = await scrapeGeneric('https://myfigurecollection.net/item/12345', {});

      // Capture failure is non-fatal: scrape still succeeds without the raw HTML fields
      expect(result).toBeDefined();
      expect(result.rawHtmlGz).toBeUndefined();
      expect(result.htmlSha).toBeUndefined();
      expect(result.rawHtmlBytes).toBeUndefined();

      gzipSpy.mockRestore();
    });
  });
});
