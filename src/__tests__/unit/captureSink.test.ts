import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import type { Page, Browser, HTTPResponse } from 'puppeteer';
import { BrowserPool } from '../../services/genericScraper';
import { createScrapingService } from '../../services/engineServices/scrapingService';
import { buildRawCapture, CollectingCaptureSink } from '../../services/captureSink';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('buildRawCapture', () => {
  it('computes the sha256 content address of the uncompressed bytes', () => {
    const bytes = Buffer.from('<html>hi</html>', 'utf8');
    const c = buildRawCapture({ url: 'https://x/1', lane: 'wire', bytes, fetchedAt: '2026-07-30T00:00:00Z' });
    expect(c.sha256).toBe(sha(bytes));
    expect(c.lane).toBe('wire');
    expect(c.fetchedAt).toBe('2026-07-30T00:00:00Z');
  });

  it('omits finalUrl when it equals url, includes it when it differs', () => {
    const bytes = Buffer.from('x');
    expect(buildRawCapture({ url: 'https://x/1', finalUrl: 'https://x/1', lane: 'dom', bytes }).finalUrl).toBeUndefined();
    expect(buildRawCapture({ url: 'https://x/1', finalUrl: 'https://x/2', lane: 'dom', bytes }).finalUrl).toBe('https://x/2');
  });

  it('defaults fetchedAt to an ISO instant when omitted', () => {
    const c = buildRawCapture({ url: 'https://x/1', lane: 'dom', bytes: Buffer.from('x') });
    expect(() => new Date(c.fetchedAt).toISOString()).not.toThrow();
    expect(c.fetchedAt).toBe(new Date(c.fetchedAt).toISOString());
  });
});

describe('scrapingService capture hook', () => {
  let mockPage: jest.Mocked<Page>;
  let mockContext: any;
  let mockBrowser: jest.Mocked<Browser>;
  let responseHandler: ((r: HTTPResponse) => unknown) | undefined;
  let simulate: HTTPResponse[] = [];
  const mainFrame = { id: 'main' };

  const wireBytes = Buffer.from('<html>WIRE pre-JS</html>', 'utf8');
  const domHtml = '<html><body>DOM post-JS</body></html>';

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    responseHandler = undefined;
    simulate = [];

    mockPage = {
      // fire simulated responses DURING navigation, as a real browser does
      goto: jest.fn<(...a: any[]) => any>().mockImplementation(async () => {
        for (const r of simulate) if (responseHandler) await responseHandler(r);
        return { status: () => 200, url: () => 'https://alpha.test/item/1' };
      }),
      title: jest.fn<(...a: any[]) => any>().mockResolvedValue('T'),
      content: jest.fn<(...a: any[]) => any>().mockResolvedValue(domHtml),
      evaluate: jest.fn<(...a: any[]) => any>().mockResolvedValue('body'),
      setViewport: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setUserAgent: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      setCookie: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
      mainFrame: jest.fn(() => mainFrame),
      on: jest.fn((evt: string, h: any) => { if (evt === 'response') responseHandler = h; }),
      off: jest.fn(),
      close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Page>;

    mockContext = { newPage: jest.fn<(...a: any[]) => any>().mockResolvedValue(mockPage), close: jest.fn<(...a: any[]) => any>().mockResolvedValue(undefined) };
    mockBrowser = { createBrowserContext: jest.fn<(...a: any[]) => any>().mockResolvedValue(mockContext), connected: true } as unknown as jest.Mocked<Browser>;
    jest.spyOn(BrowserPool, 'getBrowser').mockResolvedValue(mockBrowser);
    jest.spyOn(BrowserPool, 'returnBrowser').mockResolvedValue(undefined as any);
  });

  it('emits a wire capture (main-document response bytes) and a dom capture', async () => {
    const sink = new CollectingCaptureSink();
    const service = createScrapingService(sink);

    simulate = [{
      request: () => ({ resourceType: () => 'document' }),
      frame: () => mainFrame,
      buffer: async () => wireBytes,
      status: () => 200,
      headers: () => ({ 'content-type': 'text/html; charset=utf-8' }),
      url: () => 'https://alpha.test/item/1',
    } as unknown as HTTPResponse];
    const result = await service.scrapePage('https://alpha.test/item/1');

    // scraping result unchanged
    expect(result.html).toBe(domHtml);

    const wire = sink.captures.find(c => c.lane === 'wire');
    const dom = sink.captures.find(c => c.lane === 'dom');
    expect(wire).toBeDefined();
    expect(wire!.sha256).toBe(sha(wireBytes));
    expect(wire!.statusCode).toBe(200);
    expect(wire!.contentType).toContain('text/html');
    expect(dom).toBeDefined();
    expect(dom!.sha256).toBe(sha(Buffer.from(domHtml, 'utf8')));
    // wire and dom differ (pre-JS vs post-JS) — the whole point of two lanes
    expect(wire!.sha256).not.toBe(dom!.sha256);
  });

  it('ignores non-document and cross-frame responses for the wire lane', async () => {
    const sink = new CollectingCaptureSink();
    const service = createScrapingService(sink);
    simulate = [{
      request: () => ({ resourceType: () => 'image' }),
      frame: () => mainFrame,
      buffer: async () => Buffer.from('IMGDATA'),
      status: () => 200, headers: () => ({}), url: () => 'https://alpha.test/img.png',
    } as unknown as HTTPResponse];
    await service.scrapePage('https://alpha.test/item/1');
    expect(sink.captures.find(c => c.lane === 'wire')).toBeUndefined();
    expect(sink.captures.find(c => c.lane === 'dom')).toBeDefined();
  });
});
