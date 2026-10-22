/**
 * QB-U30a acceptance (2): with SCRAPE_HOST_CLOCK unset the queue's dispatch order and times, and the
 * image lane's call times, are byte-identical to develop. The scenario (recheck g1's goldenOff) mixes
 * HOT/WARM/COLD items on four stores (one with a NaN declared rate), a 429, a 500, a parse failure,
 * `www.` and case spellings of the MFC host, and the image lane on the MFC main host, its static image
 * host and a shared CDN with 429s and a throw. The fixture was written by this same file on develop
 * 1afae8ba (sha256 0cacc0eec7ff66b9724b33757674b2b5b31420bcb6fc12bbc47874b57d609c9a, the value recheck
 * g1 measured on 52558c9d); HOST_CLOCK_GOLDEN_OUT=<file> writes the log a tree produces, to regenerate
 * it there. The file never names the host clock, so it runs unchanged on both trees.
 * Fake timers, stubbed page fetch and bytes fetcher: no network.
 */
const mockNotify = jest.fn().mockResolvedValue(true);
jest.mock('../../services/genericScraper', () => ({
  BrowserPool: { getStealthBrowser: jest.fn(), getBrowser: jest.fn(), returnBrowser: jest.fn(), getPoolSize: jest.fn().mockReturnValue(2), getPoolCapacity: jest.fn().mockReturnValue(3), reset: jest.fn() },
}));
jest.mock('../../services/webhookClient', () => ({
  notifyItemSuccess: (...a: any[]) => mockNotify(...a),
  notifyItemFailed: (...a: any[]) => mockNotify(...a),
  notifyItemSkipped: (...a: any[]) => mockNotify(...a),
}));

import * as fs from 'fs';
import * as path from 'path';
import { ScrapeQueue, resetScrapeQueue } from '../../services/scrapeQueue';
import { createExtractionRegistry } from '../../services/extractionRegistry';
import { HostRateLimiter } from '../../driver/hostRateLimiter';
import { paceImageBytesByHost } from '../../services/images/imageBytesPacing';
import type { ImageBytesResult } from '../../services/images/imageBytes';
import { okWriteStats } from '../helpers/ingestWriteStats';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'hostClock', 'knobOffGolden.txt');

const SITES = [
  { siteId: 'mfc', domain: 'myfigurecollection.net', baseDelayMs: 7000 },
  { siteId: 'fast', domain: 'fast.test', baseDelayMs: 1000 },
  { siteId: 'slow', domain: 'www.slow.test', baseDelayMs: 20000 },
  { siteId: 'nodecl', domain: 'nodecl.test', baseDelayMs: Number.NaN },
];

function registry() {
  const r = createExtractionRegistry();
  for (const s of SITES) {
    r.registerSite({ siteId: s.siteId, name: s.siteId, domains: [s.domain], rateLimit: { domain: s.domain, baseDelayMs: s.baseDelayMs, minDelayMs: 1000, maxDelayMs: 180000, backoffMultiplier: 2, recoveryDivisor: 1.5, successThreshold: 4 }, requiresBrowser: false, allowedCookies: [] });
    r.registerRuleset({
      siteId: s.siteId,
      version: '1.0.0',
      extract: (_h: string, url: string) => {
        if (url.includes('bad')) throw new Error('parse fail');
        return { source: { site: s.siteId, itemId: new URL(url).pathname.split('/').pop() as string, url, extractedAt: '2026-10-04T00:00:00.000Z', rulesetVersion: '1.0.0' }, fields: { name: 'x' }, warnings: [] };
      },
      validate: () => ({ valid: true, errors: [], warnings: [] }),
    });
  }
  return r;
}

jest.setTimeout(120_000);

it('with SCRAPE_HOST_CLOCK unset, queue dispatch and image pacing are byte-identical to develop', async () => {
  delete process.env.SCRAPE_HOST_CLOCK;
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
  resetScrapeQueue();
  const log: string[] = [];
  const scraping = {
    scrapePage: jest.fn().mockImplementation((url: string) => {
      log.push(`page ${Date.now() - 1_000_000} ${url}`);
      const status = url.includes('429') ? 429 : url.includes('500') ? 500 : 200;
      return Promise.resolve({ html: '<html>ok</html>', url, title: 'Item', statusCode: status });
    }),
    scrapePageStealth: jest.fn(),
  };
  const queue = new ScrapeQueue(false);
  queue.setPluginRegistry(registry());
  queue.setIngestEmitter({ send: jest.fn().mockResolvedValue(okWriteStats()) });
  queue.setScrapingService(scraping);
  queue.setImageCaptureHook({ capture: async () => undefined, drain: async () => undefined, stats: () => ({ enabled: false }) as any });
  const urls: Array<[string, any]> = [];
  for (let i = 1; i <= 6; i++) urls.push([`https://myfigurecollection.net/item/${i}`, i % 3 === 0 ? 'HOT' : 'WARM']);
  for (let i = 1; i <= 5; i++) urls.push([`https://fast.test/p/${i}${i === 3 ? '-429' : ''}`, 'COLD']);
  for (let i = 1; i <= 3; i++) urls.push([`https://www.slow.test/p/${i}`, 'WARM']);
  for (let i = 1; i <= 3; i++) urls.push([`https://nodecl.test/p/${i}${i === 2 ? '-bad' : ''}`, 'HOT']);
  urls.push(['https://MyFigureCollection.net/item/77', 'WARM']);
  urls.push(['https://www.myfigurecollection.net/item/78', 'COLD']);
  urls.push(['https://fast.test/p/500-x', 'WARM']);
  urls.forEach(([u, p], i) => queue.enqueue(`id${i}`, { priority: p, url: u }));
  for (let t = 0; t < 400; t++) await jest.advanceTimersByTimeAsync(500);
  queue.stop();
  queue.clear();
  resetScrapeQueue();

  // The image lane: the MFC main host, its static image host and a shared CDN; successes, 429s, a throw.
  let now = 0;
  const paced = paceImageBytesByHost(async (url: string): Promise<ImageBytesResult> => {
    const k = log.length;
    log.push(`img ${now} ${url}`);
    if (k % 9 === 4) throw new Error('reset');
    return k % 5 === 0
      ? { ok: false, reason: 'http-status', status: 429, detail: '429' }
      : { ok: true, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', status: 200, finalUrl: url, headers: {} };
  }, new HostRateLimiter(() => undefined), { now: () => now, sleep: async (ms: number) => { now += ms; }, cooldown: { remaining: () => 0 } });
  const imgs = [
    'https://myfigurecollection.net/?_tb=commit&commit=nsp&objectType=item&objectId=1&size=1',
    'https://static.myfigurecollection.net/upload/items/1/1.jpg',
    'https://cdn.shopify.com/s/files/1.png',
  ];
  for (let i = 0; i < 60; i++) {
    now += (i % 4) * 300;
    try {
      await paced(`${imgs[i % 3]}#${i}`);
    } catch {
      // the throw is part of the script
    }
  }
  jest.useRealTimers();

  const text = `${log.join('\n')}\n`;
  if (process.env.HOST_CLOCK_GOLDEN_OUT) fs.writeFileSync(process.env.HOST_CLOCK_GOLDEN_OUT, text);
  expect(log.length).toBeGreaterThan(70);
  expect(text).toBe(fs.readFileSync(FIXTURE, 'utf8'));
});
