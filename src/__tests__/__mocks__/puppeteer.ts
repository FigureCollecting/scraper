// Enhanced Puppeteer Mock Infrastructure
import { jest } from '@jest/globals';

// Mock function type alias to fix TypeScript strict mode issues
type MockFn = any;

// Comprehensive Type Definitions
interface MockBrowserContext {
  browser: MockBrowser;
  pages: MockPage[];
}

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
  evaluate: jest.fn().mockResolvedValue(null) as any,
  click: jest.fn().mockResolvedValue(undefined) as any,
  type: jest.fn().mockResolvedValue(undefined) as any,
  querySelector: jest.fn().mockResolvedValue(null) as any,
});

export const createMockPage = (): MockPage => ({
  goto: jest.fn().mockResolvedValue({ status: () => 200 }) as any,
  content: jest.fn().mockResolvedValue('<html><body>Mock HTML Content</body></html>') as any,
  title: jest.fn().mockResolvedValue('Mock Page Title') as any,
  screenshot: jest.fn().mockResolvedValue(Buffer.from('screenshot')) as any,
  evaluate: jest.fn().mockImplementation((fn, ...args) => {
    // Handle specific case for document.body.innerText/textContent
    if (typeof fn === 'function') {
      const fnString = fn.toString();
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
  }) as any,
  waitForSelector: jest.fn().mockResolvedValue(createMockElementHandle()) as any,
  $: jest.fn().mockResolvedValue(createMockElementHandle()) as any,
  $$: jest.fn().mockResolvedValue([createMockElementHandle()]) as any,
  close: jest.fn().mockResolvedValue(undefined) as any,
  setViewport: jest.fn().mockResolvedValue(undefined) as any,
  setUserAgent: jest.fn().mockResolvedValue(undefined) as any,
  setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined) as any,
  waitForFunction: jest.fn().mockResolvedValue(undefined) as any,
  waitForTimeout: jest.fn().mockResolvedValue(undefined) as any,
  on: jest.fn().mockReturnThis() as any,
});

export const createMockBrowser = (): MockBrowser => {
  const mockContext = {
    newPage: jest.fn().mockResolvedValue(createMockPage()) as any,
    close: jest.fn().mockResolvedValue(undefined) as any,
    pages: jest.fn().mockReturnValue([]) as any,
  };

  return {
    newPage: jest.fn().mockResolvedValue(createMockPage()) as any,
    close: jest.fn().mockResolvedValue(undefined) as any,
    connected: true,  // Puppeteer 25: freshly launched browser reports connected via getter
    createBrowserContext: jest.fn().mockResolvedValue(mockContext) as any,  // Standard Puppeteer API
    createIncognitoBrowserContext: jest.fn().mockResolvedValue(mockContext) as any,  // Deprecated
  };
};

// Puppeteer Mock Module
const mockPuppeteer = {
  launch: jest.fn().mockImplementation(() => {
    const browser = createMockBrowser();
    return Promise.resolve(browser);
  }) as any,
  defaultViewport: { width: 1280, height: 800 },
  connect: jest.fn() as any,
  
  // Static type compatibility
  Browser: jest.fn().mockReturnValue(createMockBrowser()) as any,
  Page: jest.fn().mockReturnValue(createMockPage()) as any,
};

export default mockPuppeteer;

// Utility for resetting all mocks
export const resetAllMocks = () => {
  Object.values(mockPuppeteer).forEach(mock => {
    if (typeof mock === 'function' && mock.mockReset) {
      mock.mockReset();
    }
  });
};