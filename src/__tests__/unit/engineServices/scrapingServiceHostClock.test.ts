/**
 * The engine's scraping service on the host clock (QB-U30b, design.host_clock.callers):
 *   - the plugin-mounted routes (rulesets /scrape/mfc, /sync/validate-cookies, /sync/export-csv, the
 *     /sync list workflows) reach stores through ctx.services.scraping; that service is built with
 *     caller 'pluginRoute' and EVERY page-level request of its pages passes the clock at the request
 *     itself: a main-frame navigation, whatever started it (page.goto, reload, goBack, goForward, a
 *     main-frame goto, a click that submits a form). While SCRAPE_HOST_CLOCK may hold the request the
 *     page's requests are intercepted and a page-level one waits for its send block; otherwise nothing
 *     is intercepted (byte-identical) and the observer still sees each page-level request;
 *   - a browser-lane SESSION PRIME is a second request in one call: in a service whose caller clocks
 *     the call (the queue, /lookup, /catalog, /resolve), the prime is the call's first request and the
 *     target that follows passes the clock as 'sessionPrime'; in the plugin service the prime passes
 *     it as 'sessionPrime' and the target as 'pluginRoute'.
 * Puppeteer is mocked with a page that models request issue and interception (requestModelPage).
 */
import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import type { Page, Browser } from 'puppeteer';
import { BrowserPool } from '../../../services/genericScraper';
import { createScrapingService } from '../../../services/engineServices/scrapingService';
import { clearChallengeGates } from '../../../services/browserChallenge';
import { resetHostConcurrency } from '../../../services/gatedBrowsers';
import { processHostClockPacer, type PageRequestPacer } from '../../../services/hostClockSend';
import { HostClock, parseHostClockScope, setHostClock, type HostClockOptions } from '../../../services/hostClock';
import { requestModelPage } from '../../helpers/requestModelPage';

const URL_A = 'https://alpha.example.test/item/1';
const URL_B = 'https://alpha.example.test/item/2';
const PRIME = 'https://alpha.example.test/';
const MFC = 'myfigurecollection.net';
const MFC_URL = `https://${MFC}`;

describe('createScrapingService on the host clock', () => {
  let model: ReturnType<typeof requestModelPage>;
  let events: string[];
  let holds: (url?: string) => boolean;
  let pacer: PageRequestPacer;

  beforeEach(async () => {
    jest.clearAllMocks();
    await BrowserPool.reset();
    (BrowserPool as any).stealthBrowser = null;
    clearChallengeGates();
    resetHostConcurrency();
    events = [];
    holds = () => true;
    pacer = {
      first: (url: string) => { events.push(`first ${url}`); },
      send: async (url, caller, invoke) => {
        events.push(`send ${caller} ${url}`);
        return invoke();
      },
      holds: (url?: string) => holds(url),
      observe: (url, caller) => { events.push(`observe ${caller} ${url}`); },
    };
    model = requestModelPage();
    const mockContext = {
      newPage: jest.fn<(...args: any[]) => any>().mockResolvedValue(model.page),
      close: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    };
    const mockBrowser = {
      newPage: jest.fn<(...args: any[]) => any>().mockResolvedValue(model.page),
      close: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      connected: true,
      createBrowserContext: jest.fn<(...args: any[]) => any>().mockResolvedValue(mockContext),
    } as unknown as jest.Mocked<Browser>;
    jest.mocked(puppeteer.launch).mockClear();
    jest.mocked(puppeteer.launch).mockResolvedValue(mockBrowser);
  });

  afterEach(() => {
    setHostClock(null);
    jest.useRealTimers();
  });

  const gotos = () => model.wire.map(w => w.url);

  /** The MFC sync routes' shape (rulesets cookies.ts, lists.ts, csv.ts): goto, reload, a submitted form, a main-frame goto. */
  const syncWorkflow = async (page: Page) => {
    await page.goto(MFC_URL, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'networkidle2' });
    const submit = await page.$('#export');
    await Promise.all([page.waitForNavigation(), submit!.click()]);
    await page.mainFrame().goto(`${MFC_URL}/?mode=manager`);
  };

  describe("the plugin service (caller 'pluginRoute'), while the clock may hold its requests", () => {
    it('scrapePage, scrapePageStealth and browserFetch: their navigation request passes the clock, under interception', async () => {
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      await service.scrapePage(URL_A);
      await service.scrapePageStealth(URL_B);
      await service.browserFetch(URL_A);
      expect(events).toEqual([`send pluginRoute ${URL_A}`, `send pluginRoute ${URL_B}`, `send pluginRoute ${URL_A}`]);
      expect(gotos()).toEqual([URL_A, URL_B, URL_A]);
      expect(model.interception).toEqual([true, true, true]);
    });

    it("a withPage callback: goto, reload, goBack, goForward, a submitted form and a main-frame goto each pass the clock; the page is the page itself", async () => {
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      const title = await service.withPage(async (page: Page) => {
        await syncWorkflow(page);
        await page.goBack();
        await page.goForward();
        return page.title();
      });
      expect(title).toBe('Mock Page Title');
      expect(model.wire.map(w => w.what)).toEqual([
        `goto ${MFC_URL}`,
        `reload ${MFC_URL}`,
        `submit ${MFC_URL}/?submit=%23export`,
        `frame goto ${MFC_URL}/?mode=manager`,
        `goBack ${MFC_URL}/?mode=manager`,
        `goForward ${MFC_URL}/?mode=manager`,
      ]);
      expect(events).toEqual(model.wire.map(w => `send pluginRoute ${w.url}`));
      expect(model.page.goto).toHaveBeenCalledWith(MFC_URL, { waitUntil: 'domcontentloaded' });
    });

    it('a subresource, a subframe navigation and a redirect hop continue at once, without the clock', async () => {
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      await service.withPage(async () => {
        await model.issue(`${MFC_URL}/api/list.json`, { navigation: false });
        await model.issue(`${MFC_URL}/frame.html`, { frame: 'sub' });
        await model.issue(`${MFC_URL}/detached`, { frame: null });
        await model.issue(`${MFC_URL}/moved-here`, { redirectHops: 1 });
      });
      expect(model.wire.map(w => w.url)).toEqual([`${MFC_URL}/api/list.json`, `${MFC_URL}/frame.html`, `${MFC_URL}/detached`, `${MFC_URL}/moved-here`]);
      expect(events).toEqual([]);
    });

    it('a request the clock refuses is aborted (blockedbyclient): the navigation fails and nothing reaches the wire', async () => {
      pacer.send = async () => {
        throw new Error('[HOST-CLOCK] refused');
      };
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      await expect(service.withPage(page => page.goto(MFC_URL))).rejects.toThrow('net::ERR_BLOCKEDBYCLIENT');
      expect(model.aborted).toEqual([{ url: MFC_URL, errorCode: 'blockedbyclient' }]);
      expect(model.wire).toEqual([]);
    });

    it('a request that can no longer be resolved (its page closed) is dropped quietly, page-level or not', async () => {
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      await service.withPage(async () => {
        void model.issue(`${MFC_URL}/x.css`, { navigation: false, gone: true });
        void model.issue(`${MFC_URL}/next`, { gone: true });
        await new Promise(resolve => setImmediate(resolve));
      });
      pacer.send = async () => {
        throw new Error('[HOST-CLOCK] refused');
      };
      await createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer }).withPage(async () => {
        void model.issue(`${MFC_URL}/refused-and-gone`, { gone: true });
        await new Promise(resolve => setImmediate(resolve));
      });
      expect(events).toEqual([`send pluginRoute ${MFC_URL}/next`]);
      expect(model.wire).toEqual([]);
      expect(model.aborted).toEqual([]);
    });

    it('a declared prime: the prime navigation passes as sessionPrime, then the target as pluginRoute', async () => {
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      await service.scrapePage(URL_A, { primeUrl: PRIME });
      expect(gotos()).toEqual([PRIME, URL_A]);
      expect(events).toEqual([`send sessionPrime ${PRIME}`, `send pluginRoute ${URL_A}`]);
    });

    it('asks the pacer about the target a fetch names, and about any host for a bare withPage', async () => {
      const asked: Array<string | undefined> = [];
      holds = url => {
        asked.push(url);
        return true;
      };
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      await service.scrapePage(URL_A);
      await service.withPage(async () => undefined);
      expect(asked).toEqual([URL_A, undefined]);
    });
  });

  describe('the plugin service while the clock cannot hold its requests (byte-identical: nothing intercepted)', () => {
    it('a fetch to a host off the clock: no interception, the observer sees its navigation', async () => {
      holds = () => false;
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      await service.scrapePage(URL_A);
      expect(model.interception).toEqual([]);
      expect(gotos()).toEqual([URL_A]);
      expect(events).toEqual([`observe pluginRoute ${URL_A}`]);
    });

    it('a withPage callback: every page-level request is observed, nothing else; nothing waits', async () => {
      holds = () => false;
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer });
      await service.withPage(async (page: Page) => {
        await syncWorkflow(page);
        await model.issue(`${MFC_URL}/api/list.json`, { navigation: false });
        await model.issue(`${MFC_URL}/frame.html`, { frame: 'sub' });
        await model.issue(`${MFC_URL}/moved-here`, { redirectHops: 2 });
      });
      expect(model.interception).toEqual([]);
      expect(events).toEqual([
        `observe pluginRoute ${MFC_URL}`,
        `observe pluginRoute ${MFC_URL}`,
        `observe pluginRoute ${MFC_URL}/?submit=%23export`,
        `observe pluginRoute ${MFC_URL}/?mode=manager`,
      ]);
    });
  });

  describe('a service whose caller clocks the call (the queue, /lookup, /catalog, /resolve)', () => {
    it('no prime: nothing passes the pacer, nothing is intercepted or listened to (byte-identical)', async () => {
      const service = createScrapingService(undefined, { pacer });
      await service.scrapePage(URL_A);
      await service.withPage(async (page: Page) => { await page.goto(URL_B); });
      expect(events).toEqual([]);
      expect(gotos()).toEqual([URL_A, URL_B]);
      expect(model.interception).toEqual([]);
      expect(model.listenerCount()).toBe(0);
    });

    it('a declared prime: the prime is the first request (stamped there), the target follows through the clock as sessionPrime', async () => {
      const service = createScrapingService(undefined, { pacer });
      await service.scrapePage(URL_A, { primeUrl: PRIME });
      expect(gotos()).toEqual([PRIME, URL_A]);
      expect(events).toEqual([`first ${PRIME}`, `send sessionPrime ${URL_A}`]);
    });
  });

  it('by default the process pacer is used (the clock is off in tests: navigations go as before)', async () => {
    const service = createScrapingService(undefined, { clockCaller: 'pluginRoute' });
    await service.scrapePage(URL_A, { primeUrl: PRIME });
    expect(gotos()).toEqual([PRIME, URL_A]);
    expect(model.interception).toEqual([]);
  });

  describe('on the process clock: the MFC sync workflow shape (challenger regression, closeout round 1)', () => {
    const START = 1_000_000;

    function processClock(raw: string, options: HostClockOptions = {}): HostClock {
      const clock = new HostClock(parseHostClockScope(raw), raw, options);
      clock.setFloorSource(host => (host === MFC ? 7000 : undefined));
      setHostClock(clock);
      return clock;
    }

    async function run<T>(work: Promise<T>, budgetMs: number): Promise<T> {
      let done = false;
      const settled = work.finally(() => { done = true; });
      settled.catch(() => undefined);
      for (let elapsed = 0; !done && elapsed <= budgetMs; elapsed += 250) await jest.advanceTimersByTimeAsync(250);
      return settled;
    }

    it('clock ON for myfigurecollection.net (floor 7000): goto, reload, the export submit and a main-frame goto are 7000 ms apart on the wire, all four observed', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(START);
      const clock = processClock(MFC);
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer: processHostClockPacer() });
      await run(service.withPage(async (page: Page) => {
        await syncWorkflow(page);
        // A subresource of the main host is not a page-level request: it goes at once.
        await model.issue(`${MFC_URL}/static/app.js`, { navigation: false });
      }), 60_000);
      const pages = model.wire.filter(w => !w.url.endsWith('app.js')).map(w => w.at - START);
      expect(pages).toEqual([0, 7000, 14_000, 21_000]);
      expect(model.wire[model.wire.length - 1].at - START).toBe(21_000);
      const [mfc] = clock.view(Date.now()).hosts;
      expect(mfc.sends60m.pluginRoute).toBe(4);
      expect(mfc.underFloor60m).toBe(0);
      expect(model.interception).toEqual([true]);
    });

    it('clock ON: a second page-level request stacked past the cap is refused (counted under pluginRoute) and its navigation fails', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(START);
      const clock = processClock(MFC, { waitSlackMs: 0 });
      clock.tryAcquire(MFC, START, 7000);
      clock.reserve(MFC, START, 7000);
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer: processHostClockPacer() });
      await expect(run(service.withPage(page => page.goto(MFC_URL)), 30_000)).rejects.toThrow('net::ERR_BLOCKEDBYCLIENT');
      expect(model.wire).toEqual([]);
      expect(clock.view(Date.now()).hosts[0].clockRefusals60m.pluginRoute).toBe(1);
    });

    it('clock ON for another host only: a fetch to MFC is not intercepted, a bare withPage is (it may reach a clocked host)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(START);
      processClock('hpoi.net');
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer: processHostClockPacer() });
      await run(service.scrapePage(`${MFC_URL}/item/1`), 1000);
      expect(model.interception).toEqual([]);
      await run(service.withPage(page => page.goto(`${MFC_URL}/item/2`)), 1000);
      expect(model.interception).toEqual([true]);
      expect(model.wire.map(w => w.at - START)).toEqual([0, 0]);
    });

    it('clock OFF (the negative control): nothing intercepted, the same four requests leave at once, all four observed under the floor', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(START);
      const clock = processClock('off');
      const service = createScrapingService(undefined, { clockCaller: 'pluginRoute', pacer: processHostClockPacer() });
      await run(service.withPage(syncWorkflow), 1000);
      expect(model.interception).toEqual([]);
      expect(model.wire.map(w => w.at - START)).toEqual([0, 0, 0, 0]);
      const [mfc] = clock.view(Date.now()).hosts;
      expect(mfc.clocked).toBe(false);
      expect(mfc.sends60m.pluginRoute).toBe(4);
      expect(mfc.underFloor60m).toBe(3);
    });
  });
});
