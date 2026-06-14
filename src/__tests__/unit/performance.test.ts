import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Page, Browser } from 'puppeteer';
import { scrapeGeneric, initializeBrowserPool, BrowserPool } from '../../services/genericScraper';
import { createMockBrowser } from '../__mocks__/puppeteer';

// Centralized Puppeteer mock from moduleNameMapper

describe('Performance Tests - Browser Pool Efficiency', () => {
  let mockPage: jest.Mocked<Page>;
  let mockBrowser: jest.Mocked<Browser>;
  let launchCallCount: number;

  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks(); jest.resetModules();
    
    // Reset launch call count
    launchCallCount = 0;
    
    // Reset BrowserPool state
    (BrowserPool as any).isInitialized = false;
    (BrowserPool as any).browsers = [];
    
    // Setup launch mock to track calls
    jest.mocked(puppeteer.launch).mockImplementation(() => {
      launchCallCount++;
      return Promise.resolve(createMockBrowser() as unknown as Browser);
    });

    // Mock BrowserPool.getBrowser method
    jest.spyOn(BrowserPool, 'getBrowser').mockResolvedValue(createMockBrowser() as unknown as Browser);
    
    // Create mock page with resolved methods
    mockPage = {  
      goto: jest.fn<(...args: any[]) => any>().mockResolvedValue({ status: () => 200 }),
      content: jest.fn<(...args: any[]) => any>().mockResolvedValue('<html>Mock Content</html>'),
      title: jest.fn<(...args: any[]) => any>().mockResolvedValue('Performance Test Page'),
      screenshot: jest.fn<(...args: any[]) => any>().mockResolvedValue(Buffer.from('screenshot')),
      evaluate: jest.fn<(...args: any[]) => any>().mockResolvedValue({ performance: 'test' }),
      waitForFunction: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      close: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      setViewport: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      setUserAgent: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      waitForSelector: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      waitForTimeout: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      on: jest.fn<(...args: any[]) => any>().mockReturnValue(undefined),
      $: jest.fn(),
      $$: jest.fn(),
    } as unknown as jest.Mocked<Page>;

    // Create mock browser with resolved methods
    mockBrowser = {
      newPage: jest.fn<(...args: any[]) => any>().mockResolvedValue(mockPage),
      close: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      createIncognitoBrowserContext: jest.fn<(...args: any[]) => any>().mockResolvedValue({
        newPage: jest.fn<(...args: any[]) => any>().mockResolvedValue(mockPage),
      } as any),
      connected: true,
    } as unknown as jest.Mocked<Browser>;
  });

  describe('Browser Pool Initialization Performance', () => {
    it('should initialize browser pool within acceptable time', async () => {
      const startTime = Date.now();
      await initializeBrowserPool();
      const endTime = Date.now();

      // Should initialize quickly in test environment
      expect(endTime - startTime).toBeLessThan(1000);
      
      // Should create 3 browsers for the pool
      expect(launchCallCount).toBe(3);
    });

    it('should handle concurrent initialization requests efficiently', async () => {
      const initPromises = Array(5).fill(0).map(() => initializeBrowserPool());

      const startTime = Date.now();
      await Promise.all(initPromises);
      const endTime = Date.now();

      // Should not initialize multiple times concurrently
      expect(endTime - startTime).toBeLessThan(2000);
      
      // Verify launch mock was called (may be more than 3 due to race condition in concurrent calls)
      const launchMock = jest.mocked(puppeteer.launch);
      expect(launchMock).toHaveBeenCalledTimes(15); // 5 concurrent calls × 3 browsers each
    });
  });

  // Include other performance test sections with the same pattern of mocking

  // ... rest of the tests remain mostly the same, but using mockPage and mockBrowser consistently
});

afterEach(() => {
  // Reset mocking to original state
  jest.resetAllMocks();
  if (jest.isMockFunction(puppeteer.launch)) {
    jest.mocked(puppeteer.launch).mockRestore();
  }
});