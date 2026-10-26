/**
 * F1: a listed placeholder (the host's `display_gated` body, e.g. MFC's anonymous-view plate) is a verdict on that ONE file. It is
 * settled `placeholder`, never stored, counted, never an item failure, never a step toward the pause (nor a reset of it), and never
 * asked for again. A real block (403, a challenge) still counts toward the pause.
 */
import type { ImageBytesResult } from '../../services/images/imageBytes';
import {
  classifyObservation, createFetchObserver, createMemoryLedger, judgeProbe, runGalleryCapture, type FetchObservation,
} from '../../services/images/galleryDriver';
import { K, PNG, STATIC, U, baseOpts, gdeps, item, ok200, recordingLedger, scriptedSink } from '../helpers/galleryDriverDoubles';

const okSink = () => scriptedSink(() => undefined);
const gated = (): ImageBytesResult => ({ ok: false, reason: 'display-gated', status: 200, bytesRead: 920, detail: 'display_gated: body sha256 ab is a listed placeholder' });
const blocked403 = (): ImageBytesResult => ({ ok: false, reason: 'http-status', status: 403 });

/**
 * A hook double that counts as the real one does (imageCaptureHook.ts): a display-gated answer is `failed` AND `skipped.displayGated`,
 * a 403 is `failed`, a refusal of this engine's own is `skipped.refused`; a url fetched once is a memo hit for a later item.
 */
function hookLikeTheRealOne(observer: ReturnType<typeof createFetchObserver>, script: (url: string) => ImageBytesResult) {
  const skipped: Record<string, number> = { memo: 0, displayGated: 0 };
  let failed = 0;
  const remembered = new Set<string>();
  const fetchedUrls: string[] = [];
  const forgotten: string[][] = [];
  // what reached the "network": a memo hit, or a call the tripped observer refused, never gets here
  const fetcher = observer.wrap(async url => { fetchedUrls.push(url); return script(url); });
  const hook = {
    async capture(req: { ruleset: { describeImages?: (f: Record<string, unknown>) => Array<{ url: string }> }; fields: Record<string, unknown> }) {
      for (const r of req.ruleset.describeImages!(req.fields)) {
        if (remembered.has(r.url)) { skipped.memo! += 1; continue; }
        const res = await fetcher(r.url, {});
        if (res.ok) { remembered.add(r.url); continue; }
        if (res.reason === 'refused') { skipped.refused = (skipped.refused ?? 0) + 1; continue; }
        if (res.reason === 'display-gated') skipped.displayGated! += 1;
        failed += 1;
      }
    },
    stats: () => ({ enabled: true, attempted: 0, stored: 0, deduped: 0, failed, residentialBytesToday: 0, skipped: { ...skipped } }),
    forget(urls: readonly string[]) { forgotten.push([...urls]); },
  };
  return { hook: hook as never, fetchedUrls, forgotten };
}

describe('a placeholder, as one fetch', () => {
  it('is classified placeholder, not trouble', () => {
    const o: FetchObservation = { url: U(1), ok: false, reason: 'display-gated', status: 200, ms: 1 };
    expect(classifyObservation(o)).toBe('placeholder');
  });

  it('neither counts toward the pause nor resets it: placeholders between 403s still let the third 403 trip it', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const answers = [blocked403, gated, blocked403, gated, gated, gated, gated];
    const f = observer.wrap(async () => answers.shift()!());
    for (let i = 0; i < 7; i++) await f(U(i), {});
    expect(observer.tripped()).toBeUndefined();
    await observer.wrap(async () => blocked403())(U(8), {});
    expect(observer.tripped()).toMatch(/3 consecutive blocked or failed fetches \(last: 403/);
  });
});

describe('runGalleryCapture: a placeholder is a verdict on that one file', () => {
  it('is settled placeholder and counted; the item\'s other files are settled; not an item failure; the memo is not cleared', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const h = hookLikeTheRealOne(observer, url => (url === U(1) ? gated() : ok200(Number(url.match(/(\d+)\.jpeg$/)![1]))));
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(h.hook, okSink(), observer, ledger, [item('1', [1, 2, 3])]), baseOpts());
    expect(r).toMatchObject({ stopped: 'done', fetched: 3, stored: 2, placeholder: 1, trouble: 0, blocked: 0, itemsWithFailures: 0 });
    expect([...how]).toEqual([[`${K('1')} 1.jpeg`, 'placeholder'], [`${K('1')} 2.jpeg`, 'stored'], [`${K('1')} 3.jpeg`, 'stored']]);
    expect(h.forgotten).toEqual([]);
  });

  it('three in a row do not pause the run', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const h = hookLikeTheRealOne(observer, url => (url === U(4) ? ok200(4) : gated()));
    const r = await runGalleryCapture(gdeps(h.hook, okSink(), observer, createMemoryLedger(), [item('1', [1, 2, 3, 4]), item('2', [5])]), baseOpts());
    expect(r).toMatchObject({ stopped: 'done', fetched: 5, stored: 1, placeholder: 4, itemsWithFailures: 0 });
    expect(r.pauseReason).toBeUndefined();
  });

  it('is never asked for again: a second run over the same ledger fetches nothing', async () => {
    const ledger = createMemoryLedger();
    const script = (url: string) => (url === U(1) ? gated() : ok200(2));
    const first = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    await runGalleryCapture(gdeps(hookLikeTheRealOne(first, script).hook, okSink(), first, ledger, [item('1', [1, 2])]), baseOpts());
    const second = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const again = hookLikeTheRealOne(second, script);
    const r = await runGalleryCapture(gdeps(again.hook, okSink(), second, ledger, [item('1', [1, 2])]), baseOpts());
    expect(again.fetchedUrls).toEqual([]);
    expect(r).toMatchObject({ fetched: 0, skippedLedger: 2 });
  });

  it('does not keep a sharing file of the same item from being settled by the memo', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const h = hookLikeTheRealOne(observer, url => (url === U(5) ? gated() : ok200(Number(url.match(/(\d+)\.jpeg$/)![1]))));
    const { ledger, how } = recordingLedger();
    const r = await runGalleryCapture(gdeps(h.hook, okSink(), observer, ledger, [item('1', [1, 2]), item('2', [2, 5])]), baseOpts());
    expect(h.fetchedUrls).toEqual([U(1), U(2), U(5)]);
    expect(how.get(`${K('2')} 2.jpeg`)).toBe('stored');
    expect(how.get(`${K('2')} 5.jpeg`)).toBe('placeholder');
    expect(r).toMatchObject({ stored: 3, placeholder: 1, itemsWithFailures: 0 });
  });

  it('a real block in the same run still pauses it', async () => {
    const observer = createFetchObserver({ pauseAfter: 3, now: () => 0 });
    const h = hookLikeTheRealOne(observer, url => (url === U(2) || url === U(4) ? gated() : blocked403()));
    const r = await runGalleryCapture(gdeps(h.hook, okSink(), observer, createMemoryLedger(), [item('1', [1, 2, 3, 4, 5, 6])]), baseOpts());
    expect(r).toMatchObject({ stopped: 'paused', blocked: 3, placeholder: 2 });
    expect(h.fetchedUrls).toEqual([U(1), U(2), U(3), U(4), U(5)]);
  });
});

describe('judgeProbe: a placeholder is a note, not a FAIL', () => {
  const rec = (n: number) => ({ url: U(n), lane: 'impit' as const, egress: 'residential' as const, sentHeaderNames: ['accept'], status: 200, redirected: false, setCookie: false });
  const ph = (n: number): FetchObservation => ({ url: U(n), ok: false, reason: 'display-gated', status: 200, ms: 2 });
  const good = (n: number): FetchObservation => ({ url: U(n), ok: true, status: 200, contentType: 'image/png', bytes: PNG(n).length, ms: 2 });

  it('passes when every other file is a good image, and says how many were the placeholder', () => {
    const v = judgeProbe({ observations: [ph(1), good(2), good(3)], requests: [rec(1), rec(2), rec(3)], allowedHosts: [STATIC], wanted: 3 });
    expect(v.verdict).toBe('PASS');
    expect(v.notes.join('\n')).toMatch(/1 file\(s\) answered with the host's listed placeholder/);
    expect(v.evidence[0]).toMatchObject({ outcome: 'placeholder' });
  });

  it('is INCONCLUSIVE when every file was the placeholder: the path carried bytes, but no picture', () => {
    const v = judgeProbe({ observations: [ph(1), ph(2)], requests: [rec(1), rec(2)], allowedHosts: [STATIC], wanted: 2 });
    expect(v.verdict).toBe('INCONCLUSIVE');
    expect(v.reasons.join('\n')).toMatch(/every file was the host's listed placeholder/);
  });

  it('a challenge beside a placeholder still FAILs', () => {
    const v = judgeProbe({
      observations: [ph(1), { url: U(2), ok: false, reason: 'http-status', status: 403, signals: { 'cf-mitigated': 'challenge' }, ms: 2 }],
      requests: [rec(1), rec(2)], allowedHosts: [STATIC], wanted: 2,
    });
    expect(v.verdict).toBe('FAIL');
  });
});
