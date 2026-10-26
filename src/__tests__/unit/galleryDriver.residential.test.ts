/**
 * GAL-RES at the driver (runGalleryCapture): the residential permission, the byte meter it is handed, and the stop that the hook's own
 * home-line day cap forces. main()'s composition is in galleryCapture.residential.test.ts.
 */
import { createByteMeter } from '../../services/images/galleryBytes';
import { createFetchObserver, createMemoryLedger, judgeProbe, runGalleryCapture } from '../../services/images/galleryDriver';
import { buildImageHostPolicy } from '../../services/images/imageHostPolicy';
import { K, PNG, STATIC, U, baseOpts, gdeps, item, memoHook, ok200, recordingLedger, scriptedSink } from '../helpers/galleryDriverDoubles';

const RES_POLICY = buildImageHostPolicy({ [STATIC]: { lane: 'impit', egress: 'residential', referer: false } });
const okSink = () => scriptedSink(() => undefined);

describe('runGalleryCapture: residential egress', () => {
  it('a residential row is refused unless the run permits residential egress (the default stays: never the home line)', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const h = memoHook(observer);
    const r = await runGalleryCapture({ ...gdeps(h.hook, okSink(), observer, createMemoryLedger(), [item('1', [1])]), policy: RES_POLICY }, baseOpts());
    expect(r).toMatchObject({ stopped: 'refused', refusal: expect.stringMatching(/residential egress.*GALLERY_EGRESS=direct/) });
    expect(h.fetchedUrls).toEqual([]);
  });

  it('a run permitted residential egress but handed no byte budget is refused before any request', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const h = memoHook(observer);
    const r = await runGalleryCapture(
      { ...gdeps(h.hook, okSink(), observer, createMemoryLedger(), [item('1', [1])]), policy: RES_POLICY, meter: createByteMeter({ capBytes: 1000 }) },
      baseOpts({ residential: true }),
    );
    expect(r).toMatchObject({ stopped: 'refused', refusal: expect.stringMatching(/byte budget/) });
    expect(h.fetchedUrls).toEqual([]);
  });

  it('with residential permitted and a budget, the residential row runs and the report carries the meter\'s numbers', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const meter = createByteMeter({ max: 10_000, capBytes: 1000, allowance: 100 });
    const h = memoHook(observer, () => { meter.add(11); return ok200(); });
    const r = await runGalleryCapture(
      { ...gdeps(h.hook, okSink(), observer, createMemoryLedger(), [item('1', [1, 2])]), policy: RES_POLICY, meter },
      baseOpts({ residential: true }),
    );
    expect(r).toMatchObject({ stopped: 'done', fetched: 2, stored: 2, bytesRead: 22, budget: 10_000 });
  });

  it('a run with no meter reports bytesRead 0 and budget null', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const r = await runGalleryCapture(gdeps(memoHook(observer).hook, okSink(), observer, createMemoryLedger(), [item('1', [1])]), baseOpts());
    expect(r).toMatchObject({ stopped: 'done', bytesRead: 0, budget: null });
  });

  it('when the hook skips files because ITS home-line day cap is reached, the run stops ("budget") after that item instead of walking the list', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const h = memoHook(observer, () => ok200(), { extraSkip: id => (id === '2' ? 'residentialBudget' : undefined) });
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(h.hook, okSink(), observer, ledger, [item('1', [1]), item('2', [2]), item('3', [3])]), baseOpts());
    expect(r).toMatchObject({ stopped: 'budget', items: 2 });
    expect(h.fetchedUrls).toEqual([U(1), U(2)]);
    expect([...how.keys()]).toEqual([`${K('1')} 1.jpeg`, `${K('2')} 2.jpeg`]);
  });

  it('a meter already spent when the run starts stops it before the first item: no request', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const meter = createByteMeter({ max: 2000, capBytes: 1000, allowance: 100 });
    meter.add(1000);
    const h = memoHook(observer);
    const r = await runGalleryCapture({ ...gdeps(h.hook, okSink(), observer, createMemoryLedger(), [item('1', [1])]), meter }, baseOpts());
    expect(r).toMatchObject({ stopped: 'budget', items: 0, fetched: 0, bytesRead: 1000, budget: 2000 });
    expect(h.fetchedUrls).toEqual([]);
  });

  it('a spent meter stops the run before the next item is planned', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const meter = createByteMeter({ max: 1200, capBytes: 1000, allowance: 100 });
    const h = memoHook(observer, () => { meter.add(150); return ok200(); });
    const r = await runGalleryCapture({ ...gdeps(h.hook, okSink(), observer, createMemoryLedger(), [item('1', [1]), item('2', [2])]), meter }, baseOpts());
    expect(r).toMatchObject({ stopped: 'budget', items: 1, fetched: 1, bytesRead: 150 });
    expect(h.fetchedUrls).toEqual([U(1)]);
  });
});

describe('judgeProbe: the egress of every request', () => {
  it('carries each request\'s egress into the evidence and notes the requests the home line carried', () => {
    const v = judgeProbe({
      observations: [{ url: U(1), ok: true, status: 200, contentType: 'image/png', bytes: PNG(1).length, ms: 3 }],
      requests: [{ url: U(1), lane: 'impit', egress: 'residential', sentHeaderNames: ['accept'], status: 200, redirected: false, setCookie: false }],
      allowedHosts: [STATIC], wanted: 1,
    });
    expect(v.verdict).toBe('PASS');
    expect(v.evidence[0]).toMatchObject({ lane: 'impit', egress: 'residential' });
    expect(v.notes.join('\n')).toMatch(/1 request\(s\) left through the residential exit/);
  });

  it('notes nothing about the home line when every request went direct', () => {
    const v = judgeProbe({
      observations: [{ url: U(1), ok: true, status: 200, contentType: 'image/png', bytes: 11, ms: 3 }],
      requests: [{ url: U(1), lane: 'http', egress: 'direct', sentHeaderNames: ['accept'], status: 200, redirected: false, setCookie: false }],
      allowedHosts: [STATIC], wanted: 1,
    });
    expect(v.evidence[0]).toMatchObject({ lane: 'http', egress: 'direct' });
    expect(v.notes.join('\n')).not.toMatch(/residential/);
  });
});
