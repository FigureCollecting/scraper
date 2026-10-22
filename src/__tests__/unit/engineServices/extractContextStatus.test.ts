/**
 * `ctx.scraping.fetchBody` result shape. The plugin contract names the HTTP status `statusCode`;
 * the capturing fetch names it `status`. A ruleset written to the contract must see the status.
 */
import { buildExtractContext } from '../../../services/engineServices/extractContext';
import type { SiteConfig } from '@figurecollecting/scraper-plugin-contract';

const CONFIG = { siteId: 'hpoi', baseUrl: 'https://www.hpoi.net' } as unknown as SiteConfig;
const LOGGER = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const scraping = {
  scrapePage: jest.fn(async () => ({ html: '<page/>', url: '', title: '', statusCode: 200 })),
  scrapePageStealth: jest.fn(async () => ({ html: '<page/>', url: '', title: '', statusCode: 200 })),
};

function ctxWith(result: { html: string; status?: number; finalUrl?: string; challenge?: boolean }) {
  return buildExtractContext({
    config: CONFIG,
    logger: LOGGER,
    scraping,
    capturingFetch: jest.fn(async () => result),
    searchFetch: undefined,
    primaryUrl: 'https://www.hpoi.net/hobby/126243',
    primaryFetchedAt: 0,
    now: () => 10_000_000,
    sleep: jest.fn(async () => {}),
  });
}

describe('fetchBody carries the HTTP status under the contract name', () => {
  it('a 503 is visible as statusCode, and status is kept', async () => {
    const res = await ctxWith({ html: '<h1>503</h1>', status: 503, finalUrl: 'https://www.hpoi.net/comment/get/v2/1/1/30' })
      .scraping.fetchBody!('https://www.hpoi.net/comment/get/v2/1/1/30');
    expect((res as { statusCode?: number }).statusCode).toBe(503);
    expect((res as { status?: number }).status).toBe(503);
    expect(res.html).toBe('<h1>503</h1>');
  });

  it('a transport that observed no status leaves statusCode undefined', async () => {
    const res = await ctxWith({ html: '<ok/>' }).scraping.fetchBody!('https://www.hpoi.net/comment/get/v2/1/1/30');
    expect((res as { statusCode?: number }).statusCode).toBeUndefined();
  });

  it('the challenge flag survives untouched', async () => {
    const res = await ctxWith({ html: '<cf/>', status: 403, challenge: true }).scraping.fetchBody!('https://www.hpoi.net/x');
    expect((res as { challenge?: boolean }).challenge).toBe(true);
    expect((res as { statusCode?: number }).statusCode).toBe(403);
  });
});
