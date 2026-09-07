import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Page, Browser } from 'puppeteer';
import { BrowserPool } from '../../services/genericScraper';
import { createScrapingService } from '../../services/engineServices/scrapingService';
import { clearChallengeGates } from '../../services/browserChallenge';
import { resetPersistentContexts } from '../../services/persistentContexts';

/**
 * A JSON API on the browser lane (sugotoys' WooCommerce Store API rides it now that its edge
 * challenges every non-browser client) must come back as the JSON BYTES. Chrome renders a navigated
 * JSON document inside a viewer DOM, so `page.content()` would hand the parser `<html><pre>{…`.
 * The content type is read from the FINAL main-frame response — after a challenge, the response
 * `goto` returned is the 403 interstitial, not the document that was actually served.
 */
describe('browser lane JSON body passthrough', () => {
  let mockPage: jest.Mocked<Page>;
  let responseListeners: Array<(resp: any) => void>;
  let mockContext: any;
  let mockBrowser: jest.Mocked<Browser>;

  // One shared frame object: the lane matches a response's frame by IDENTITY against page.mainFrame().
  const mainFrame = { id: 'main' };

  const makeResponse = (headers: Record<string, string>, body: string | Error, status = 200) => ({
    status: () => status,
    url: () => 'https://sugotoys.com.au/wp-json/wc/store/products',
    headers: () => headers,
    text: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
      if (body instanceof Error) throw body;
      return body;
    }),
    buffer: jest.fn<(...a: any[]) => any>().mockResolvedValue(Buffer.from(typeof body === 'string' ? body : '')),
    request: () => ({ resourceType: () => 'document' }),
    frame: () => mainFrame,
  });

  const wire = (gotoResponse: any) => {
    responseListeners = [];
    mockPage = {
      goto: jest.fn<(...a: any[]) => any>().mockResolvedValue(gotoResponse),
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue('Products'),
      content: jest.fn<(...a: any[]) => any>().mockResolvedValue('<html><body><pre>{"json":"wrapped in a viewer"}</pre></body></html>'),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('{"from":"innerText"}'),
      setViewport: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setUserAgent: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setCookie: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      on: jest.fn((event: any, listener: any) => { if (event === 'response') responseListeners.push(listener); }),
      off: jest.fn(),
      mainFrame: jest.fn(() => mainFrame),
    } as unknown as jest.Mocked<Page>;

    mockContext = {
      newPage: jest.fn<(...a: any[]) => any>().mockResolvedValue(mockPage),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
    };
    mockBrowser = {
      createBrowserContext: jest.fn<(...a: any[]) => any>().mockResolvedValue(mockContext),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      connected: true,
    } as unknown as jest.Mocked<Browser>;
    jest.mocked(puppeteer.launch).mockClear();
    jest.mocked(puppeteer.launch).mockResolvedValue(mockBrowser);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
    resetPersistentContexts();
  });

  afterEach(async () => {
    await BrowserPool.reset();
    clearChallengeGates();
    resetPersistentContexts();
  });

  it('browserFetch returns the raw JSON body, not the viewer DOM', async () => {
    wire(makeResponse({ 'content-type': 'application/json; charset=utf-8' }, '[{"id":1,"name":"Lucy"}]'));
    const service = createScrapingService();

    const body = await service.browserFetch('https://sugotoys.com.au/wp-json/wc/store/products', { stealth: false });

    expect(body).toBe('[{"id":1,"name":"Lucy"}]');
    expect(mockPage.content).not.toHaveBeenCalled();
  });

  it('browserFetch falls back to document.body.innerText when the response body is gone', async () => {
    wire(makeResponse({ 'content-type': 'application/json' }, new Error('Could not load body for this request')));
    const service = createScrapingService();

    const body = await service.browserFetch('https://sugotoys.com.au/wp-json/wc/store/products', { stealth: false });

    expect(body).toBe('{"from":"innerText"}');
  });

  it('scrapePage returns the raw JSON body too (the /resolve + ingest door)', async () => {
    wire(makeResponse({ 'content-type': 'application/json' }, '{"product":"Lucy"}'));
    const service = createScrapingService();

    const result = await service.scrapePage('https://sugotoys.com.au/wp-json/wc/store/products');

    expect(result.html).toBe('{"product":"Lucy"}');
  });

  it('an HTML response is still page.content() (the rendered DOM, not the wire bytes)', async () => {
    wire(makeResponse({ 'content-type': 'text/html; charset=utf-8' }, '<html>wire</html>'));
    const service = createScrapingService();

    const body = await service.browserFetch('https://sugotoys.com.au/shop', { stealth: false });

    expect(body).toBe('<html><body><pre>{"json":"wrapped in a viewer"}</pre></body></html>');
  });

  it('reads the FINAL main-frame response, not the challenge response goto returned', async () => {
    // goto resolves with the 403 interstitial; the document actually served arrives during the
    // navigation, on the response event — which is the one whose body the lane must read.
    const interstitial = makeResponse({ 'cf-mitigated': 'challenge', 'content-type': 'text/html' }, '<html>interstitial</html>', 403);
    wire(interstitial);
    const served = makeResponse({ 'content-type': 'application/json' }, '[{"id":7}]');
    jest.mocked(mockPage.goto).mockImplementation(async () => {
      for (const listener of responseListeners) listener(interstitial);
      for (const listener of responseListeners) listener(served);
      return interstitial as any;
    });
    const service = createScrapingService();

    const body = await service.browserFetch('https://sugotoys.com.au/wp-json/wc/store/products', { stealth: false });

    expect(body).toBe('[{"id":7}]');
  });
});
