/**
 * The legacy POST /scrape route on the host clock (QB-U30b caller 'scrape'): its in-process fetch
 * passes the clock; a refusal (its slot is past the cap) answers 503 with Retry-After and fetches
 * nothing.
 */
import request from 'supertest';
import express from 'express';
import scraperRoutes from '../../routes/scraper';
import * as genericScraper from '../../services/genericScraper';
import { HostClock, parseHostClockScope, setHostClock } from '../../services/hostClock';

jest.mock('../../services/genericScraper');
const mocked = genericScraper as jest.Mocked<typeof genericScraper>;

const HOST = 'shop.example';
const FLOOR = 7000;

describe('POST /scrape on the host clock', () => {
  const app = express();
  app.use(express.json());
  app.use('/', scraperRoutes);
  let clock: HostClock;

  beforeEach(() => {
    jest.clearAllMocks();
    clock = new HostClock(parseHostClockScope('all'), 'all', { waitSlackMs: 0 });
    clock.setFloorSource(host => (host === HOST ? FLOOR : undefined));
    setHostClock(clock);
  });
  afterEach(() => setHostClock(null));

  it('sends through the clock and is recorded as caller scrape', async () => {
    mocked.scrapeGeneric.mockResolvedValueOnce({ name: 'x' } as any);
    const res = await request(app).post('/scrape').send({ url: `https://${HOST}/item/1`, config: { nameSelector: 'h1' } }).expect(200);
    expect(res.body).toEqual({ success: true, data: { name: 'x' } });
    expect(clock.view(Date.now()).hosts[0].sends60m.scrape).toBe(1);
  });

  it('a refused send answers 503 with Retry-After and fetches nothing', async () => {
    clock.tryAcquire(HOST, Date.now(), FLOOR);
    clock.reserve(HOST, Date.now(), FLOOR);
    const res = await request(app).post('/scrape').send({ url: `https://${HOST}/item/1`, config: { nameSelector: 'h1' } }).expect(503);
    expect(res.body).toMatchObject({ success: false, message: expect.stringContaining('refused a scrape send') });
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(7);
    expect(mocked.scrapeGeneric).not.toHaveBeenCalled();
    expect(clock.view(Date.now()).hosts[0].clockRefusals60m.scrape).toBe(1);
  });
});
