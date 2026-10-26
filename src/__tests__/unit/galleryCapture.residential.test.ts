/**
 * GAL-RES: GALLERY_EGRESS=residential under a byte budget, in process. The capture hook here is the REAL one (createImageCaptureHook:
 * the lane decision, the residential proxy it resolves, the final-url guard it hands the lanes, its own day budget) over a fake sink, so
 * what is under test is main()'s composition: the refusals, the budget gate at dispatch, the byte meter at the transport, the impit
 * session built through the residential exit, and the dispatch guard. The real impit through a real SOCKS5 exit is in
 * galleryCapture.residential.loopback.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImpitLike, ImpitResponseLike } from '../../services/impitFetch';
import type { CaptureSink } from '../../services/captureSink';
import { main, parseGalleryArgs } from '../../services/images/galleryCapture';
import { guardGalleryDispatch } from '../../services/images/galleryDriver';
import { createGalleryImpitFetch, galleryImpitFactory } from '../../services/images/galleryImpitLane';
import { getResidentialProxyUrl } from '../../services/residentialEgress';
import { createImageCaptureHook } from '../../services/images/imageCaptureHook';
import type { ImageBytesFetcher } from '../../services/images/imageBytes';
import { buildImageHostPolicy, type ImageHostPolicy, type ImageHostRule } from '../../services/images/imageHostPolicy';
import { png, pngOfSize, startLoopback, type Loopback } from '../helpers/galleryLoopback';
import { closedPort, startSocks5 } from '../helpers/socks5Loopback';

const STATIC = 'static.myfigurecollection.net';
const OTHER = 'cdn.other-store.example';
const PROXY = 'socks5://egress-proxy.fc.svc.cluster.local:1055';
const U = (n: number | string, host = STATIC) => `https://${host}/upload/pictures/2022/10/14/${n}.jpeg`;
const line = (id: string, nums: Array<number | string>, page = `https://myfigurecollection.net/item/${id}`) =>
  JSON.stringify({ site: 'mfc', itemId: id, pageUrl: page, rank: 0, entries: nums.map((n, i) => ({ position: i, src: typeof n === 'string' && n.startsWith('https://') ? n : U(n) })) });
const PLACEHOLDER_SHA = 'a87e4c47e2cb587893a50b1ce0f05956e6d5c0a0ed1f6a71c4537577e3bdadbe';
/** The Job's row for the static host (fc-infra gallery-capture-job.yaml): impit, residential, no Referer, the profile's own UA. */
const ROW: ImageHostRule = { lane: 'impit', egress: 'residential', referer: false, ua: 'default', placeholders: { [PLACEHOLDER_SHA]: 'display_gated' } };
const CAP = 1000;
const ALLOWANCE = 600;
const RESERVE = CAP + ALLOWANCE;

type Answer = { status: number; headers?: Record<string, string>; body?: Buffer; stream?: number[] };
/** A distinct 300-byte PNG per url (the hook dedupes identical bodies). */
const img = (url: string, size = 300): Answer => ({ status: 200, headers: { 'content-type': 'image/png', 'content-length': String(size) }, body: pngOfSize(url, size) });

describe('GALLERY_EGRESS=residential under a byte budget (main, in process)', () => {
  let dir: string;
  let work: string;
  let ledger: string;
  const out: string[] = [];
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-res-'));
    work = path.join(dir, 'wl.jsonl');
    ledger = path.join(dir, 'ledger.jsonl');
    writeFileSync(work, [line('1', [1, 2, 3]), line('2', [4, 5, 6])].join('\n') + '\n');
    out.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  interface RigOpts {
    rows?: Record<string, ImageHostRule>;
    env?: Record<string, string | undefined>;
    answer?: (url: string) => Answer;
    /** The residential exit main() resolves (null: none configured). */
    proxy?: string | null;
    /** The proxy the hook resolves for a residential image (default: the same exit). */
    hookProxy?: string;
  }
  function rig(opts: RigOpts = {}) {
    const calls: Array<{ url: string; headers: Record<string, string>; redirect?: string; proxy: string | undefined; t: number }> = [];
    const made: Array<{ browser: string; proxy: string | undefined }> = [];
    const plans: Array<Record<string, unknown>> = [];
    const stored: string[] = [];
    const hookEnvs: NodeJS.ProcessEnv[] = [];
    const answer = opts.answer ?? (url => img(url));
    const sessionFor = (proxy: string | undefined): ImpitLike => ({
      async fetch(url, init) {
        calls.push({ url, headers: { ...(init.headers ?? {}) }, ...(init.redirect !== undefined ? { redirect: init.redirect } : {}), proxy, t: Date.now() });
        const a = answer(url);
        const headers = new Headers(a.headers ?? {});
        if (a.stream !== undefined) {
          const sizes = [...a.stream];
          const body = new ReadableStream<Uint8Array>({ pull(c) { const n = sizes.shift(); if (n === undefined) c.close(); else c.enqueue(new Uint8Array(n).fill(0x89)); } }, { highWaterMark: 0 });
          const res: ImpitResponseLike & { body: ReadableStream<Uint8Array> } = { status: a.status, url, headers, text: async () => '', body, bytes: async () => { throw new Error('a budgeted run must read through the stream'); } };
          return res;
        }
        const bytes = a.body ?? Buffer.alloc(0);
        const res: ImpitResponseLike = { status: a.status, url, headers, text: async () => '', bytes: async () => new Uint8Array(bytes) };
        return res;
      },
    });
    const env: Record<string, string | undefined> = {
      IMAGE_HOST_RATE_JSON: JSON.stringify({ [STATIC]: { intervalMs: 100 }, [OTHER]: { intervalMs: 100 } }),
      GALLERY_ALLOWED_HOSTS: STATIC, RAW_STORE_IMAGE_MAX_BYTES: '10485760', GALLERY_LOCK_PATH: path.join(dir, 'gallery-capture.lock'),
      GALLERY_EGRESS: 'residential', GALLERY_MAX_BYTES: String(RESERVE + 1000),
      ...opts.env,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const sink: CaptureSink = { capture: async c => { stored.push(c.url); return { admitted: true, storageKey: `raw-img/${c.sha256}`, bytesLen: c.bytes.length }; } };
    return {
      calls, made, plans, stored, hookEnvs,
      deps: {
        env: env as NodeJS.ProcessEnv,
        print: (s: string) => void out.push(s),
        policy: buildImageHostPolicy(opts.rows ?? { [STATIC]: ROW }),
        residentialProxy: () => (opts.proxy === null ? undefined : opts.proxy ?? PROXY),
        imageCapBytes: CAP,
        readAllowanceBytes: ALLOWANCE,
        makeImpit: (browser: string, proxy?: string) => { made.push({ browser, proxy }); return sessionFor(proxy); },
        baseFetch: async () => { throw new Error('the http lane must not be used for an impit row'); },
        // the REAL hook over the composed fetcher and the policy main() hands it; its plans are recorded on the way through
        makeHook: (fetchBytes: ImageBytesFetcher, hookEnv: NodeJS.ProcessEnv, policy: ImageHostPolicy) => {
          hookEnvs.push(hookEnv);
          const recordPlans: ImageBytesFetcher = (url, o) => { plans.push({ url, ...o }); return fetchBytes(url, o); };
          return createImageCaptureHook({
            sink, policy, fetchBytes: recordPlans, maxPerItem: 100, concurrency: 1, warn: () => undefined,
            proxyUrlFor: e => (e === 'residential' ? opts.hookProxy ?? PROXY : undefined),
            residentialBytesPerDay: Number(hookEnv.IMAGE_RESIDENTIAL_BYTES_PER_DAY ?? 1073741824),
          });
        },
        flush: async () => undefined,
        sink: { flush: async () => undefined, stats: () => ({ assetFailed: 0, dropped: 0, droppedBytes: 0, assetRefusedReserve: 0 }) },
      },
    };
  }
  const run = (r: ReturnType<typeof rig>, args: string[] = []) => main(['--worklist', work, '--ledger', ledger, ...args], r.deps);
  const reportOf = (): Record<string, unknown> => JSON.parse(out.find(l => l.startsWith('GALLERY-REPORT '))!.slice('GALLERY-REPORT '.length));
  const evidenceOf = (): Array<Record<string, unknown>> => JSON.parse(out.find(l => l.startsWith('PROBE-EVIDENCE '))!.slice('PROBE-EVIDENCE '.length));
  const settled = (): Array<Record<string, unknown>> => readFileSync(ledger, 'utf8').split('\n').filter(l => l !== '').map(l => JSON.parse(l) as Record<string, unknown>);

  describe('GALLERY_MAX_BYTES', () => {
    it('is read from the env as a positive whole number of bytes', () => {
      expect(parseGalleryArgs([], { GALLERY_MAX_BYTES: '1500000000' } as NodeJS.ProcessEnv).maxBytes).toBe(1_500_000_000);
      expect(parseGalleryArgs([], { GALLERY_MAX_BYTES: ' 2048 ' } as NodeJS.ProcessEnv).maxBytes).toBe(2048);
      expect(parseGalleryArgs([], {} as NodeJS.ProcessEnv).maxBytes).toBeUndefined();
    });

    it.each(['0', '-5', '1.5', '12abc', '1e9', '9007199254740993', 'lots'])('%s is a usage error: exit 2, no session, no request', async value => {
      const r = rig({ env: { GALLERY_MAX_BYTES: value } });
      expect(await run(r)).toBe(2);
      expect(out.join('\n')).toMatch(/GALLERY_MAX_BYTES must be a positive whole number of bytes/);
      expect(r.made).toEqual([]);
      expect(r.calls).toEqual([]);
    });

    it('below one request\'s reservation (the per-file cap plus one chunk) is refused: exit 2, the run could not make a single request', async () => {
      const r = rig({ env: { GALLERY_MAX_BYTES: String(RESERVE - 1) } });
      expect(await run(r)).toBe(2);
      expect(out.join('\n')).toMatch(new RegExp(`GALLERY_MAX_BYTES \\(${RESERVE - 1}\\) is below what one request may read \\(${RESERVE} bytes`));
      expect(r.calls).toEqual([]);
    });
  });

  describe('refusals before any request', () => {
    it('residential without GALLERY_MAX_BYTES: REFUSED, exit 4, no session is built and nothing is sent', async () => {
      const r = rig({ env: { GALLERY_MAX_BYTES: undefined } });
      expect(await run(r)).toBe(4);
      expect(out.join('\n')).toMatch(/REFUSED: GALLERY_EGRESS=residential needs GALLERY_MAX_BYTES/);
      expect(out.join('\n')).toMatch(/home line/);
      expect(r.made).toEqual([]);
      expect(r.calls).toEqual([]);
    });

    it('residential with no residential exit configured (RESIDENTIAL_PROXY_URL): REFUSED, exit 4, never sent from the node\'s own address', async () => {
      const r = rig({ proxy: null });
      expect(await run(r)).toBe(4);
      expect(out.join('\n')).toMatch(/REFUSED: GALLERY_EGRESS=residential but RESIDENTIAL_PROXY_URL/);
      expect(r.made).toEqual([]);
      expect(r.calls).toEqual([]);
    });

    it('an explicit IMAGE_RESIDENTIAL_BYTES_PER_DAY below the budget is refused (exit 2): the home line\'s own day cap would stop the run first', async () => {
      const r = rig({ env: { IMAGE_RESIDENTIAL_BYTES_PER_DAY: String(RESERVE) } });
      expect(await run(r)).toBe(2);
      expect(out.join('\n')).toMatch(/IMAGE_RESIDENTIAL_BYTES_PER_DAY \(1600\) is below GALLERY_MAX_BYTES \(2600\)/);
      expect(r.calls).toEqual([]);
    });

    it('with no exit handed in, the one the process resolved from RESIDENTIAL_PROXY_URL is used (none in this test process: exit 4)', async () => {
      expect(getResidentialProxyUrl()).toBeUndefined();
      const { residentialProxy: _exit, ...deps } = rig().deps;
      expect(await main(['--worklist', work, '--ledger', ledger], deps)).toBe(4);
      expect(out.join('\n')).toMatch(/REFUSED: GALLERY_EGRESS=residential but RESIDENTIAL_PROXY_URL/);
    });

    it('an explicit IMAGE_RESIDENTIAL_BYTES_PER_DAY at or above the budget stands aside: the run goes, and the hook\'s day cap is the budget', async () => {
      const r = rig({ env: { IMAGE_RESIDENTIAL_BYTES_PER_DAY: '1073741824' } });
      expect(await run(r, ['--max-files', '1'])).toBe(0);
      expect(r.hookEnvs[0]!.IMAGE_RESIDENTIAL_BYTES_PER_DAY).toBe('2600');
    });

    it('a residential row that names no lane inherits the store\'s (the browser lane): named at start, then refused (exit 4)', async () => {
      const r = rig({ rows: { [STATIC]: { egress: 'residential', referer: false } } });
      expect(await run(r)).toBe(4);
      expect(out.find(l => l.startsWith('EGRESS '))).toMatch(/on the inherited lane/);
      expect(out.join('\n')).toMatch(/REFUSED: static\.myfigurecollection\.net resolves to lane browser/);
      expect(r.calls).toEqual([]);
    });

    it('GALLERY_EGRESS=residential where no allowed host\'s row is residential says so: every host goes direct, still under the budget', async () => {
      const r = rig({ rows: { [STATIC]: { ...ROW, egress: 'direct' } } });
      expect(await run(r, ['--max-files', '1'])).toBe(0);
      expect(out.filter(l => l.startsWith('EGRESS'))).toEqual([expect.stringMatching(/^EGRESS: GALLERY_EGRESS=residential, but no allowed host's policy row says residential.*budget 2600 bytes/)]);
      expect(r.made).toEqual([{ browser: 'chrome', proxy: undefined }]);
      expect(reportOf()).toMatchObject({ fetched: 1, budget: 2600 });
    });

    it('a residential row whose image host is not on the item page\'s store is refused by the policy (exit 4), as the live capture refuses it', async () => {
      writeFileSync(work, line('1', [1], 'https://another-store.example/item/1') + '\n');
      const r = rig();
      expect(await run(r)).toBe(4);
      expect(out.join('\n')).toMatch(/REFUSED: the host policy refuses static\.myfigurecollection\.net: off-store-residential/);
      expect(r.calls).toEqual([]);
    });
  });

  describe('a residential run', () => {
    it('names the exit and the budget at start, builds ONE impit session through the residential exit, and reports bytesRead and budget', async () => {
      const r = rig();
      expect(await run(r, ['--max-files', '3'])).toBe(0);
      const egress = out.filter(l => l.startsWith('EGRESS '));
      expect(egress).toHaveLength(1);
      expect(egress[0]).toMatch(/^EGRESS static\.myfigurecollection\.net: residential, through the scraper's residential exit socks5:\/\/egress-proxy\.fc\.svc\.cluster\.local:1055 .* on the impit lane; budget 2600 bytes \(GALLERY_MAX_BYTES\)/);
      expect(r.made).toEqual([{ browser: 'chrome', proxy: PROXY }]);
      expect(r.calls.map(c => c.url)).toEqual([U(1), U(2), U(3)]);
      expect(r.calls.every(c => c.proxy === PROXY)).toBe(true);
      expect(r.plans.every(p => p.lane === 'impit' && p.egress === 'residential' && p.proxyUrl === PROXY)).toBe(true);
      expect(reportOf()).toMatchObject({ stopped: 'limit', fetched: 3, stored: 3, bytesRead: 900, budget: 2600 });
      expect(r.stored).toEqual([U(1), U(2), U(3)]);
    });

    it('hands the hook its own day cap equal to the budget (the live default, 1 GiB, would otherwise bind before a 1.5 GB budget)', async () => {
      const r = rig();
      await run(r, ['--max-files', '1']);
      expect(r.hookEnvs[0]).toMatchObject({ IMAGE_RESIDENTIAL_BYTES_PER_DAY: '2600', IMAGE_MAX_PER_ITEM: '100' });
    });

    it('what goes on the wire: no cookie, no Referer, never redirect-following, the profile\'s own UA, and one dispatch per host interval', async () => {
      const r = rig({ env: { IMAGE_HOST_RATE_JSON: JSON.stringify({ [STATIC]: { intervalMs: 100 } }) } });
      expect(await run(r, ['--max-files', '4'])).toBe(0);
      for (const c of r.calls) {
        const names = Object.keys(c.headers).map(h => h.toLowerCase());
        expect(names).not.toContain('cookie');
        expect(names).not.toContain('referer');
        expect(names).not.toContain('user-agent');
        expect(c.redirect).toBe('manual');
      }
      const ts = r.calls.map(c => c.t);
      for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(95);
    });
  });

  describe('the budget', () => {
    it('stops before a request that could cross it (stopped "budget", exit 0), mid-item, and settles exactly what was stored', async () => {
      const r = rig();
      expect(await run(r)).toBe(0);
      // 2600 bytes, 1600 held back for every request: 0, 300, 600 and 900 read leave room; 1200 does not
      expect(r.calls.map(c => c.url)).toEqual([U(1), U(2), U(3), U(4)]);
      expect(reportOf()).toMatchObject({ stopped: 'budget', fetched: 4, stored: 4, bytesRead: 1200, budget: 2600, itemsWithFailures: 0 });
      expect(settled().map(x => [x.i, x.u, x.s])).toEqual([[`mfc/1`, U(1), 'stored'], ['mfc/1', U(2), 'stored'], ['mfc/1', U(3), 'stored'], ['mfc/2', U(4), 'stored']]);
      expect(out.join('\n')).toMatch(/STOPPED at the byte budget: 1200 of 2600 bytes read/);
    });

    it('the ledger stays consistent: the next run (a fresh budget) fetches only what the stopped run left', async () => {
      await run(rig());
      out.length = 0;
      const next = rig();
      expect(await run(next)).toBe(0);
      expect(next.calls.map(c => c.url)).toEqual([U(5), U(6)]);
      expect(reportOf()).toMatchObject({ stopped: 'done', fetched: 2, stored: 2, skippedLedger: 4, bytesRead: 600 });
    });

    it('a stop that falls between items is taken before the next item starts', async () => {
      const r = rig({ env: { GALLERY_MAX_BYTES: String(RESERVE + 899) } });
      expect(await run(r)).toBe(0);
      expect(r.calls.map(c => c.url)).toEqual([U(1), U(2), U(3)]);
      expect(reportOf()).toMatchObject({ stopped: 'budget', items: 1, bytesRead: 900 });
    });

    it('a large file with no declared length is read only to the first chunk past the per-file cap, settled oversize, never stored; then the run stops', async () => {
      writeFileSync(work, line('1', [1, 'big', 3]) + '\n');
      const r = rig({
        env: { GALLERY_MAX_BYTES: '3000' },
        answer: url => (url === U('big') ? { status: 200, headers: { 'content-type': 'image/png' }, stream: [600, 600, 600, 600] } : img(url)),
      });
      expect(await run(r)).toBe(0);
      expect(r.calls.map(c => c.url)).toEqual([U(1), U('big')]);
      // 300 + 1200 (two 600-byte chunks: the second crossed the 1000-byte cap and the read stopped) = 1500; 1500 + 1600 > 3000
      expect(reportOf()).toMatchObject({ stopped: 'budget', fetched: 2, stored: 1, oversize: 1, bytesRead: 1500, budget: 3000 });
      expect(Number(reportOf().bytesRead)).toBeLessThanOrEqual(3000);
      expect(settled().map(x => [x.u, x.s])).toEqual([[U(1), 'stored'], [U('big'), 'oversize']]);
      expect(r.stored).toEqual([U(1)]);
    });

    it('counts the bytes each answer was READ for: a refused status and a declared over-cap length cost nothing, a body that is not an image does', async () => {
      writeFileSync(work, line('1', [1, 2, 3, 4]) + '\n');
      const html = Buffer.from('<html>hotlink protected</html>');
      const r = rig({
        env: { GALLERY_MAX_BYTES: '100000' },
        answer: url => (url === U(1) ? { status: 403, headers: { 'content-type': 'text/html', 'content-length': '5000' }, body: Buffer.alloc(5000) }
          : url === U(2) ? { status: 200, headers: { 'content-type': 'image/png', 'content-length': '40000' }, body: Buffer.alloc(40000) }
            : url === U(3) ? { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(html.length) }, body: html } : img(url)),
      });
      expect(await run(r, ['--pause-after', '9'])).toBe(0);
      expect(reportOf()).toMatchObject({ stopped: 'done', fetched: 4, stored: 1, oversize: 1, blocked: 1, skippedNotImage: 1, bytesRead: html.length + 300 });
    });

    it('a placeholder body is refused (display-gated, never stored) and still counted: the home line carried it', async () => {
      writeFileSync(work, [line('1', [1]), line('2', [2])].join('\n') + '\n');
      const r = rig({ env: { GALLERY_MAX_BYTES: '100000' }, rows: { [STATIC]: { ...ROW, placeholders: { [sha256(pngOfSize(U(1), 300))]: 'display_gated' } } } });
      // Exit 6 and itemsWithFailures 1 are the driver's handling of a display-gated answer on EVERY lane before GAL-RES (the hook counts it
      // as failed, the driver files an unexplained failure as an unconfirmed put); reported, not changed here.
      expect(await run(r)).toBe(6);
      expect(r.stored).toEqual([U(2)]);
      expect(reportOf()).toMatchObject({ fetched: 2, stored: 1, trouble: 1, itemsWithFailures: 1, bytesRead: 600 });
    });

    it('also caps a DIRECT run when it is set (the stop is the same), and a direct run without it reports bytesRead with budget null', async () => {
      const capped = rig({ rows: { [STATIC]: { ...ROW, egress: 'direct' } }, env: { GALLERY_EGRESS: 'direct' } });
      expect(await run(capped)).toBe(0);
      expect(capped.made).toEqual([{ browser: 'chrome', proxy: undefined }]);
      expect(reportOf()).toMatchObject({ stopped: 'budget', fetched: 4, bytesRead: 1200, budget: 2600 });
      expect(out.some(l => /^BUDGET 2600 bytes \(GALLERY_MAX_BYTES\)/.test(l))).toBe(true);
      rmSync(ledger, { force: true });
      out.length = 0;
      const plain = rig({ rows: { [STATIC]: { ...ROW, egress: 'direct' } }, env: { GALLERY_EGRESS: 'direct', GALLERY_MAX_BYTES: undefined } });
      expect(await run(plain)).toBe(0);
      expect(plain.calls).toHaveLength(6);
      expect(reportOf()).toMatchObject({ stopped: 'done', fetched: 6, bytesRead: 1800, budget: null });
      expect(out.some(l => l.startsWith('EGRESS ') || l.startsWith('BUDGET '))).toBe(false);
    });
  });

  it('a stop forced by the hook\'s own home-line day cap is named as such', async () => {
    const r = rig({ env: { GALLERY_MAX_BYTES: '100000' } });
    let n = 0;
    const capped = {
      ...r.deps,
      makeHook: (fetchBytes: ImageBytesFetcher) => ({
        async capture(req: { ruleset: { describeImages?: (f: Record<string, unknown>) => Array<{ url: string }> }; fields: Record<string, unknown> }) {
          for (const ref of req.ruleset.describeImages!(req.fields)) {
            if (++n > 2) { skipped.residentialBudget += 1; continue; }
            await fetchBytes(ref.url, { lane: 'impit', egress: 'residential', proxyUrl: PROXY, allowFinalUrl: () => true } as never);
          }
        },
        async drain() { /* nothing in flight */ },
        stats: () => ({ enabled: true, attempted: 0, stored: 0, deduped: 0, failed: 0, residentialBytesToday: 0, skipped: { ...skipped } }),
      }) as never,
    };
    const skipped = { residentialBudget: 0 };
    expect(await main(['--worklist', work, '--ledger', ledger], capped)).toBe(0);
    expect(r.calls.map(c => c.url)).toEqual([U(1), U(2)]);
    expect(reportOf()).toMatchObject({ stopped: 'budget', items: 1 });
    expect(out.join('\n')).toMatch(/STOPPED: the capture hook's home-line day cap \(IMAGE_RESIDENTIAL_BYTES_PER_DAY\) skipped a file/);
  });

  describe('only the scraper\'s residential exit, only on the store\'s own hosts', () => {
    it('a residential request planned through any OTHER proxy is refused at dispatch: no session for it, nothing sent', async () => {
      const r = rig({ hookProxy: 'socks5://somewhere-else.invalid:1080' });
      expect(await run(r, ['--max-files', '2', '--pause-after', '9'])).toBe(0);
      expect(r.made).toEqual([]);
      expect(r.calls).toEqual([]);
      expect(reportOf()).toMatchObject({ fetched: 2, stored: 0, blocked: 2 });
    });

    it('a redirect from the store\'s static host to an allowed host OFF the store is refused before any request to it', async () => {
      writeFileSync(work, line('1', [1, 2]) + '\n');
      const r = rig({
        env: { GALLERY_ALLOWED_HOSTS: `${STATIC},${OTHER}`, GALLERY_MAX_BYTES: '100000' },
        rows: { [STATIC]: ROW, [OTHER]: { lane: 'impit', egress: 'direct', referer: false, ua: 'default' } },
        answer: url => (url === U(1) ? { status: 302, headers: { location: U(1, OTHER) } } : img(url)),
      });
      expect(await run(r, ['--pause-after', '9'])).toBe(0);
      expect(r.calls.map(c => c.url)).toEqual([U(1), U(2)]);
      expect(reportOf()).toMatchObject({ fetched: 2, stored: 1, blocked: 1 });
    });

    it('a same-store redirect hop is taken through the exit, paced, and counted', async () => {
      writeFileSync(work, line('1', [1]) + '\n');
      const r = rig({ env: { GALLERY_MAX_BYTES: '100000' }, answer: url => (url === U(1) ? { status: 302, headers: { location: U('1b') } } : img(url)) });
      expect(await run(r)).toBe(0);
      expect(r.calls.map(c => [c.url, c.proxy])).toEqual([[U(1), PROXY], [U('1b'), PROXY]]);
      expect(reportOf()).toMatchObject({ stored: 1, bytesRead: 300 });
    });
  });

  describe('every other gallery safety property on the residential path', () => {
    it('three challenged fetches pause the run (exit 3); no fourth request goes through the exit', async () => {
      const r = rig({ env: { GALLERY_MAX_BYTES: '100000' }, answer: () => ({ status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }) });
      expect(await run(r)).toBe(3);
      expect(r.calls).toHaveLength(3);
      expect(out.join('\n')).toMatch(/PAUSED until/);
      expect(reportOf()).toMatchObject({ stopped: 'paused', bytesRead: 0 });
    });

    it('a run already told to stop sends nothing through the exit (exit 7)', async () => {
      const r = rig();
      const ac = new AbortController();
      ac.abort();
      expect(await main(['--worklist', work, '--ledger', ledger], { ...r.deps, signal: ac.signal })).toBe(7);
      expect(r.calls).toEqual([]);
    });

    it('the probe\'s evidence names the lane AND the egress of every request, with a note that the home line carried them', async () => {
      const r = rig({ env: { GALLERY_MAX_BYTES: '100000' } });
      expect(await run(r, ['--probe', '3'])).toBe(0);
      expect(out.join('\n')).toMatch(/PROBE PASS/);
      expect(evidenceOf().map(e => [e.lane, e.egress, e.status])).toEqual([['impit', 'residential', 200], ['impit', 'residential', 200], ['impit', 'residential', 200]]);
      expect(out.join('\n')).toMatch(/note: 3 request\(s\) left through the residential exit/);
    });
  });

  describe('--item: one item only', () => {
    it('fetches only the named item\'s files', async () => {
      const r = rig({ env: { GALLERY_MAX_BYTES: '100000' } });
      expect(await run(r, ['--item', 'mfc/2'])).toBe(0);
      expect(r.calls.map(c => c.url)).toEqual([U(4), U(5), U(6)]);
      expect(reportOf()).toMatchObject({ stopped: 'done', items: 1, fetched: 3, stored: 3 });
    });

    it('a bad line elsewhere in the list is still counted', async () => {
      writeFileSync(work, [line('1', [1]), '{not json', line('2', [2])].join('\n') + '\n');
      const r = rig({ env: { GALLERY_MAX_BYTES: '100000' } });
      expect(await run(r, ['--item', 'mfc/2'])).toBe(0);
      expect(r.calls.map(c => c.url)).toEqual([U(2)]);
      expect(reportOf()).toMatchObject({ items: 1, badLines: 1 });
    });

    it('an item the work list does not hold: exit 2 and a line that says so (nothing was fetched)', async () => {
      const r = rig({ env: { GALLERY_MAX_BYTES: '100000' } });
      expect(await run(r, ['--item', 'mfc/1005999'])).toBe(2);
      expect(out.join('\n')).toMatch(/--item mfc\/1005999 matched no item in the work list/);
      expect(r.calls).toEqual([]);
    });

    it.each([[['--item']], [['--item', '1005999']], [['--item', '--resume']]])('%j is a usage error (exit 2)', async args => {
      const r = rig();
      expect(await run(r, args)).toBe(2);
      expect(out.join('\n')).toMatch(/--item requires site\/itemId/);
    });
  });
});

describe('guardGalleryDispatch with the residential exit', () => {
  const ok = { ok: true as const, bytes: Buffer.from('x'), contentType: 'image/png', status: 200, finalUrl: U(1), headers: {} };
  const onStore = (u: string) => new URL(u).hostname.endsWith('myfigurecollection.net');
  const inner = jest.fn();
  beforeEach(() => inner.mockImplementation(async () => ok)); // the jest config resets mocks before each test
  const guarded = guardGalleryDispatch(inner, { proxyUrl: PROXY });

  it('lets a residential impit request through the configured exit, to the store\'s own host, reach the lane', async () => {
    const o = { lane: 'impit', egress: 'residential' as const, proxyUrl: PROXY, allowFinalUrl: onStore };
    expect(await guarded(U(1), o)).toBe(ok);
    expect(inner).toHaveBeenCalledWith(U(1), o);
  });

  it.each([
    ['another proxy', { lane: 'impit', egress: 'residential' as const, proxyUrl: 'socks5://other.invalid:1080', allowFinalUrl: onStore }, /residential exit/],
    ['no proxy at all', { lane: 'impit', egress: 'residential' as const, allowFinalUrl: onStore }, /residential exit/],
    ['a proxy on a direct request', { lane: 'impit', egress: 'direct' as const, proxyUrl: PROXY }, /proxy/],
    ['the http lane', { lane: 'http', egress: 'residential' as const, proxyUrl: PROXY, allowFinalUrl: onStore }, /impit/],
    ['no final-url guard to say the host is the store\'s', { lane: 'impit', egress: 'residential' as const, proxyUrl: PROXY }, /store/],
  ])('refuses %s before the lane sees it', async (_name, o, why) => {
    expect(await guarded(U(1), o)).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringMatching(why) });
    expect(inner).not.toHaveBeenCalled();
  });

  it('refuses a residential request to a host that is not the store\'s own, before the lane sees it', async () => {
    const o = { lane: 'impit', egress: 'residential' as const, proxyUrl: PROXY, allowFinalUrl: onStore };
    expect(await guarded(U(1, OTHER), o)).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringMatching(/store's own hosts/) });
    expect(inner).not.toHaveBeenCalled();
  });

  it('keeps the UA rule on the residential path', async () => {
    const o = { lane: 'impit', egress: 'residential' as const, proxyUrl: PROXY, allowFinalUrl: onStore, userAgent: 'SomeBot/1.0' };
    expect(await guarded(U(1), o)).toMatchObject({ ok: false, reason: 'refused' });
    expect(inner).not.toHaveBeenCalled();
  });
});

describe('the gallery impit session and the residential exit', () => {
  it('builds one session per egress, hands the wrapper the egress it carries, and refuses any proxy but the exit', async () => {
    const made: Array<[string, string | undefined]> = [];
    const wrapped: string[] = [];
    const ok: ImpitResponseLike = { status: 200, url: U(1), headers: new Headers({ 'content-type': 'image/png' }), text: async () => '', bytes: async () => new Uint8Array(pngOfSize('x', 300)) };
    const impit = createGalleryImpitFetch({
      makeImpit: (browser, proxy) => { made.push([browser, proxy]); return { fetch: async () => ok }; },
      wrap: (session, egress) => { wrapped.push(egress); return session; },
      residentialProxy: PROXY,
    });
    await impit.ready(PROXY);
    await impit.ready(PROXY);
    await impit.ready();
    await impit.ready('socks5://other.invalid:1080');
    expect(made).toEqual([['chrome', PROXY], ['chrome', undefined]]);
    expect(wrapped).toEqual(['residential', 'direct']);
    expect(await impit(U(1), { egress: 'residential', proxyUrl: PROXY })).toMatchObject({ ok: true });
    await expect(impit(U(1), { egress: 'residential', proxyUrl: 'socks5://other.invalid:1080' })).rejects.toThrow(/no proxy but the scraper's residential exit/);
    expect(made).toHaveLength(2);
  });

  it('the real factory dials impit through the exit it is given (real impit, a loopback SOCKS5 exit; the url names a closed port)', async () => {
    const http = await import('node:http');
    const body = png('through-the-exit');
    const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length }); res.end(body); });
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
    const socks = await startSocks5();
    const fake = await closedPort();
    socks.route(fake, port);
    try {
      const make = galleryImpitFactory(5000);
      const viaExit = await make('chrome', socks.url);
      const res = await viaExit.fetch(`http://localhost:${fake}/a.png`, { method: 'GET' });
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.bytes!()).equals(body)).toBe(true);
      expect(socks.connects.map(c => c.port)).toEqual([fake]);
      const direct = await make('chrome');
      await expect(direct.fetch(`http://localhost:${fake}/a.png`, { method: 'GET' })).rejects.toThrow();
    } finally {
      await socks.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('a budgeted DIRECT http run in process: real undici bodies through the meter', () => {
  let lb: Loopback;
  let dir: string;
  beforeEach(async () => { lb = await startLoopback(); dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-res-http-')); });
  afterEach(async () => { await lb.close(); rmSync(dir, { recursive: true, force: true }); });

  it('counts each body read from the global fetch, cuts one with no declared length past the cap, and settles it oversize', async () => {
    const work = path.join(dir, 'wl.jsonl');
    const entries = ['img/1.jpeg', 'bigstream/5000/x', 'img/3.jpeg'].map((p, i) => ({ position: i, src: lb.urlA(p) }));
    writeFileSync(work, JSON.stringify({ site: 'shop', itemId: '1', pageUrl: 'https://item-page.invalid/item/1', rank: 0, entries }) + '\n');
    const out: string[] = [];
    const stored: string[] = [];
    const sink: CaptureSink = { capture: async c => { stored.push(c.url); return { admitted: true, storageKey: `raw-img/${c.sha256}`, bytesLen: c.bytes.length }; } };
    const code = await main(['--worklist', work, '--ledger', path.join(dir, 'ledger.jsonl')], {
      env: {
        IMAGE_HOST_RATE_JSON: JSON.stringify({ localhost: { intervalMs: 100 } }), GALLERY_ALLOWED_HOSTS: `http://localhost:${lb.portA}`,
        RAW_STORE_IMAGE_MAX_BYTES: '10485760', GALLERY_LOCK_PATH: path.join(dir, 'gallery-capture.lock'), GALLERY_MAX_BYTES: String(4 * 1024 * 1024),
      } as NodeJS.ProcessEnv,
      print: l => void out.push(l),
      policy: buildImageHostPolicy({ localhost: { lane: 'http', egress: 'direct' } }),
      imageCapBytes: 1000,
      makeHook: (fetchBytes, _env, policy) => createImageCaptureHook({ sink, policy, fetchBytes, maxPerItem: 100, concurrency: 1, warn: () => undefined }),
      flush: async () => undefined,
      sink: { flush: async () => undefined, stats: () => ({ assetFailed: 0, dropped: 0, droppedBytes: 0, assetRefusedReserve: 0 }) },
    });
    expect(code).toBe(0);
    const report = JSON.parse(out.find(l => l.startsWith('GALLERY-REPORT '))!.slice('GALLERY-REPORT '.length)) as Record<string, number>;
    expect(report).toMatchObject({ stopped: 'done', fetched: 3, stored: 2, oversize: 1 });
    const small = png('A:1.jpeg').length + png('A:3.jpeg').length;
    expect(report.bytesRead! - small).toBeGreaterThan(1000);
    expect(report.bytesRead! - small).toBeLessThanOrEqual(5000);
    expect(stored).toEqual([lb.urlA('img/1.jpeg'), lb.urlA('img/3.jpeg')]);
    expect(lb.a.map(a => a.path)).toEqual(['/img/1.jpeg', '/bigstream/5000/x', '/img/3.jpeg']);
  });
});

function sha256(b: Buffer): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('node:crypto') as typeof import('node:crypto')).createHash('sha256').update(b).digest('hex');
}
