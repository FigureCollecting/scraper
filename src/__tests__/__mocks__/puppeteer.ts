// Enhanced Puppeteer Mock Infrastructure
import { jest } from '@jest/globals';

/**
 * Permissively-typed mock factory. `@jest/globals`' bare `jest.fn()` infers an
 * `UnknownFunction`, which collapses `.mockResolvedValue`/`.mockReturnValue`
 * arguments to `never`. Giving it an explicit `(...args: any[]) => any`
 * signature keeps the chained matchers honest (they accept the value the mock
 * is meant to return) without per-call generics on every line.
 */
const fn = () => jest.fn<(...args: any[]) => any>();

// Mock function type alias mirrors the factory above.
type MockFn = ReturnType<typeof fn>;

// Comprehensive Type Definitions
interface MockElementHandle {
  evaluate: MockFn;
  click: MockFn;
  type: MockFn;
  querySelector: MockFn;
}

interface MockPage {
  goto: MockFn;
  content: MockFn;
  title: MockFn;
  screenshot: MockFn;
  evaluate: MockFn;
  waitForSelector: MockFn;
  $: MockFn;
  $$: MockFn;
  close: MockFn;
  setViewport: MockFn;
  setUserAgent: MockFn;
  setExtraHTTPHeaders: MockFn;
  waitForFunction: MockFn;
  waitForTimeout: MockFn;
  on: MockFn;
}

interface MockBrowser {
  newPage: MockFn;
  close: MockFn;
  connected: boolean;  // Puppeteer 25: `connected` getter replaced the isConnected() method
  createBrowserContext: MockFn;  // Standard Puppeteer API
  createIncognitoBrowserContext: MockFn;  // Deprecated, kept for compatibility
}

// Comprehensive Mock Implementation
export const createMockElementHandle = (): MockElementHandle => ({
  evaluate: fn().mockResolvedValue(null),
  click: fn().mockResolvedValue(undefined),
  type: fn().mockResolvedValue(undefined),
  querySelector: fn().mockResolvedValue(null),
});

export const createMockPage = (): MockPage => ({
  goto: fn().mockResolvedValue({ status: () => 200 }),
  content: fn().mockResolvedValue('<html><body>Mock HTML Content</body></html>'),
  title: fn().mockResolvedValue('Mock Page Title'),
  screenshot: fn().mockResolvedValue(Buffer.from('screenshot')),
  evaluate: fn().mockImplementation((fnArg: unknown, ...args: unknown[]) => {
    // Handle specific case for document.body.innerText/textContent
    if (typeof fnArg === 'function') {
      const fnString = fnArg.toString();
      if (fnString.includes('document.body.innerText') || fnString.includes('document.body.textContent')) {
        return Promise.resolve('Mock page body text content');
      }
      // Handle data extraction calls (they have parameters)
      if (args.length > 0 || fnString.includes('selectors') || fnString.includes('data')) {
        return Promise.resolve({});
      }
    }
    // Default behavior for other evaluate calls
    return Promise.resolve({});
  }),
  waitForSelector: fn().mockResolvedValue(createMockElementHandle()),
  $: fn().mockResolvedValue(createMockElementHandle()),
  $$: fn().mockResolvedValue([createMockElementHandle()]),
  close: fn().mockResolvedValue(undefined),
  setViewport: fn().mockResolvedValue(undefined),
  setUserAgent: fn().mockResolvedValue(undefined),
  setExtraHTTPHeaders: fn().mockResolvedValue(undefined),
  waitForFunction: fn().mockResolvedValue(undefined),
  waitForTimeout: fn().mockResolvedValue(undefined),
  on: fn().mockReturnThis(),
});

export const createMockBrowser = (): MockBrowser => {
  const mockContext = {
    newPage: fn().mockResolvedValue(createMockPage()),
    close: fn().mockResolvedValue(undefined),
    pages: fn().mockReturnValue([]),
  };

  return {
    newPage: fn().mockResolvedValue(createMockPage()),
    close: fn().mockResolvedValue(undefined),
    connected: true,  // Puppeteer 25: freshly launched browser reports connected via getter
    createBrowserContext: fn().mockResolvedValue(mockContext),  // Standard Puppeteer API
    createIncognitoBrowserContext: fn().mockResolvedValue(mockContext),  // Deprecated
  };
};

// Puppeteer Mock Module
const mockPuppeteer = {
  launch: fn().mockImplementation(() => {
    const browser = createMockBrowser();
    return Promise.resolve(browser);
  }),
  defaultViewport: { width: 1280, height: 800 },
  connect: fn(),

  // Static type compatibility
  Browser: fn().mockReturnValue(createMockBrowser()),
  Page: fn().mockReturnValue(createMockPage()),
};

export default mockPuppeteer;

// Utility for resetting all mocks
export const resetAllMocks = () => {
  Object.values(mockPuppeteer).forEach(mock => {
    if (typeof mock === 'function' && 'mockReset' in mock && typeof mock.mockReset === 'function') {
      mock.mockReset();
    }
  });
};
