/**
 * GAL-IMPIT: the gallery job's entry on the impit lane, in process. The hook double makes the lane decision the real hook makes
 * (chooseImageLane over the policy main() hands it), so what is under test is main()'s composition: which policy the hook sees
 * (GALLERY_EGRESS), which transport each lane reaches, the pacing, the redirect follower and the probe evidence over impit.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImpitLike, ImpitResponseLike } from '../../services/impitFetch';
import { main, parseGalleryArgs } from '../../services/images/galleryCapture';
import { resolveImageUserAgent, type ImageBytesFetcher } from '../../services/images/imageBytes';
import { buildImageHostPolicy, chooseImageLane, type ImageHostPolicy, type ImageHostRule } from '../../services/images/imageHostPolicy';

const STATIC = 'static.myfigurecollection.net';
const U = (n: number | string) => `https://${STATIC}/upload/pictures/2022/10/14/${n}.jpeg`;
const line = (id: string, nums: number[]) =>
  JSON.stringify({ site: 'mfc', itemId: id, pageUrl: `https://myfigurecollection.net/item/${id}`, rank: 0, entries: nums.map((n, i) => ({ position: i, src: U(n) })) });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** The fc-infra row for the static host, as committed (image-host-policy.yaml). */
const SHARED_ROW: ImageHostRule = { lane: 'impit', egress: 'residential', referer: false, ua: 'chrome', placeholders: { a87e4c47e2cb587893a50b1ce0f05956e6d5c0a0ed1f6a71c4537577e3bdadbe: 'display_gated' } };

type Answer = { status: number; headers?: Record<string, string>; body?: Buffer };
const IMG: Answer = { status: 200, headers: { 'content-type': 'image/png' }, body: PNG };

describe('main() on the impit lane', () => {
  let dir: string;
  let work: string;
  let ledger: string;
  const out: string[] = [];
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-impit-'));
    work = path.join(dir, 'wl.jsonl');
    ledger = path.join(dir, 'ledger.jsonl');
    writeFileSync(work, [line('1', [1, 2]), line('2', [3])].join('\n') + '\n');
    out.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function rig(opts: { row?: ImageHostRule; env?: Record<string, string | undefined>; answer?: (url: string) => Answer } = {}) {
    const impitCalls: Array<{ url: string; headers: Record<string, string>; redirect?: string; t: number }> = [];
    const httpCalls: string[] = [];
    const made: string[] = [];
    const plans: Array<Record<string, unknown>> = [];
    const refusedByPolicy: string[] = [];
    const answer = opts.answer ?? (() => IMG);
    const impit: ImpitLike = {
      async fetch(url, init) {
        impitCalls.push({ url, headers: { ...(init.headers ?? {}) }, ...(init.redirect !== undefined ? { redirect: init.redirect } : {}), t: Date.now() });
        const a = answer(url);
        const body = a.body ?? Buffer.alloc(0);
        const res: ImpitResponseLike = { status: a.status, url, headers: new Headers(a.headers ?? {}), text: async () => '', bytes: async () => new Uint8Array(body) };
        return res;
      },
    };
    const env: Record<string, string | undefined> = {
      IMAGE_HOST_RATE_JSON: JSON.stringify({ [STATIC]: { intervalMs: 100 } }), GALLERY_ALLOWED_HOSTS: STATIC, RAW_STORE_IMAGE_MAX_BYTES: '10485760',
      GALLERY_LOCK_PATH: path.join(dir, 'gallery-capture.lock'), ...opts.env,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    return {
      impitCalls, httpCalls, made, plans, refusedByPolicy,
      deps: {
        env: env as NodeJS.ProcessEnv,
        print: (s: string) => void out.push(s),
        policy: buildImageHostPolicy({ [STATIC]: opts.row ?? SHARED_ROW }),
        makeImpit: (browser: string) => { made.push(browser); return impit; },
        baseFetch: async (url: string) => { httpCalls.push(url); throw new Error('the http lane must not be used for an impit row'); },
        // the real hook's lane decision, over the policy main() hands the hook
        makeHook: (fetchBytes: ImageBytesFetcher, _env: NodeJS.ProcessEnv, policy: ImageHostPolicy) => ({
          async capture(req: { pageUrl: string; ruleset: { describeImages?: (f: Record<string, unknown>) => Array<{ url: string }> }; fields: Record<string, unknown> }) {
            for (const r of req.ruleset.describeImages!(req.fields)) {
              const d = chooseImageLane(req.pageUrl, r.url, undefined, policy);
              if (!d.ok) { refusedByPolicy.push(r.url); continue; }
              const ua = resolveImageUserAgent(d.ua);
              const plan = { lane: d.lane, egress: d.egress, storeHost: 'myfigurecollection.net', ...(d.referer !== undefined ? { referer: d.referer } : {}), ...(ua !== undefined ? { userAgent: ua } : {}), ...(d.placeholders !== undefined ? { placeholders: d.placeholders } : {}) };
              plans.push(plan);
              await fetchBytes(r.url, plan);
            }
          },
          async drain() { /* nothing in flight */ },
          stats: () => ({ enabled: true, attempted: 0, stored: 0, deduped: 0, failed: 0, residentialBytesToday: 0, skipped: {} }),
        }) as never,
        flush: async () => undefined,
        sink: { flush: async () => undefined, stats: () => ({ assetFailed: 0, dropped: 0, droppedBytes: 0, assetRefusedReserve: 0 }) },
      },
    };
  }
  const reportOf = (): Record<string, unknown> => JSON.parse(out.find(l => l.startsWith('GALLERY-REPORT '))!.slice('GALLERY-REPORT '.length));
  const evidenceOf = (): Array<Record<string, unknown>> => JSON.parse(out.find(l => l.startsWith('PROBE-EVIDENCE '))!.slice('PROBE-EVIDENCE '.length));

  describe('GALLERY_EGRESS', () => {
    it('is read from the env: unset, or direct', () => {
      expect(parseGalleryArgs([], {} as NodeJS.ProcessEnv).egress).toBeUndefined();
      expect(parseGalleryArgs([], { GALLERY_EGRESS: 'direct' } as NodeJS.ProcessEnv).egress).toBe('direct');
      expect(parseGalleryArgs([], { GALLERY_EGRESS: ' Direct ' } as NodeJS.ProcessEnv).egress).toBe('direct');
    });

    it.each(['proxy', 'home', 'true'])('any other value (%s) is a usage error: exit 2, no request', async value => {
      const r = rig({ env: { GALLERY_EGRESS: value } });
      expect(await main(['--worklist', work, '--ledger', ledger], r.deps)).toBe(2);
      expect(out.join('\n')).toMatch(/GALLERY_EGRESS must be direct/);
      expect(r.impitCalls).toEqual([]);
    });

    it('GALLERY_EGRESS=residential is REFUSED (exit 4): the home line is Ross\'s decision, and no request is made', async () => {
      const r = rig({ env: { GALLERY_EGRESS: 'residential' } });
      expect(await main(['--worklist', work, '--ledger', ledger], r.deps)).toBe(4);
      expect(out.join('\n')).toMatch(/REFUSED: GALLERY_EGRESS=residential/);
      expect(out.join('\n')).toMatch(/home/);
      expect(r.made).toEqual([]);
      expect(r.impitCalls).toEqual([]);
      expect(r.httpCalls).toEqual([]);
    });

    it('a residential row without the override is REFUSED (exit 4) and names GALLERY_EGRESS=direct; no session is built', async () => {
      const r = rig();
      expect(await main(['--worklist', work, '--ledger', ledger], r.deps)).toBe(4);
      expect(out.join('\n')).toMatch(/REFUSED: .*residential.*GALLERY_EGRESS=direct/);
      expect(r.made).toEqual([]);
      expect(r.impitCalls).toEqual([]);
    });

    it('GALLERY_EGRESS=direct fetches the residential row on its impit lane, direct, and says so at start', async () => {
      const r = rig({ env: { GALLERY_EGRESS: 'direct' } });
      expect(await main(['--worklist', work, '--ledger', ledger], r.deps)).toBe(0);
      expect(out.find(l => l.startsWith('EGRESS '))).toMatch(new RegExp(`EGRESS ${STATIC.replace(/\./g, '\\.')}: the policy row says residential; GALLERY_EGRESS=direct`));
      expect(r.made).toEqual(['chrome']);
      expect(r.impitCalls.map(c => c.url)).toEqual([U(1), U(2), U(3)]);
      expect(r.httpCalls).toEqual([]);
      expect(r.plans.every(p => p.lane === 'impit' && p.egress === 'direct' && !('proxyUrl' in p))).toBe(true);
      expect(reportOf()).toMatchObject({ stopped: 'done', fetched: 3, stored: 3 });
    });

    it('prints no override line for a row that is already direct', async () => {
      const r = rig({ row: { ...SHARED_ROW, egress: 'direct' }, env: { GALLERY_EGRESS: 'direct' } });
      expect(await main(['--worklist', work, '--ledger', ledger], r.deps)).toBe(0);
      expect(out.filter(l => l.startsWith('EGRESS '))).toEqual([]);
      expect(r.impitCalls.length).toBe(3);
    });
  });

  describe('what goes on the wire over impit', () => {
    it('no cookie, no Referer (the row says referer:false), never redirect-following, and a Chrome UA that is no AI crawler', async () => {
      const r = rig({ env: { GALLERY_EGRESS: 'direct' } });
      expect(await main(['--worklist', work, '--ledger', ledger], r.deps)).toBe(0);
      for (const c of r.impitCalls) {
        const names = Object.keys(c.headers).map(h => h.toLowerCase());
        expect(names).not.toContain('cookie');
        expect(names).not.toContain('referer');
        expect(c.redirect).toBe('manual');
        expect(c.headers['user-agent']).toMatch(/Chrome\/\d+/);
        expect(c.headers['user-agent']).not.toMatch(/bot|claude|anthropic|gpt/i);
      }
    });

    it('a ua:default row sends no UA of its own, so the impersonation profile speaks for itself', async () => {
      const r = rig({ row: { ...SHARED_ROW, ua: 'default' }, env: { GALLERY_EGRESS: 'direct' } });
      expect(await main(['--worklist', work, '--ledger', ledger], r.deps)).toBe(0);
      expect(r.impitCalls.every(c => !Object.keys(c.headers).map(h => h.toLowerCase()).includes('user-agent'))).toBe(true);
    });

    it('is paced at the host rate: one dispatch per 100 ms row, never faster', async () => {
      const r = rig({ env: { GALLERY_EGRESS: 'direct' } });
      expect(await main(['--worklist', work, '--ledger', ledger], r.deps)).toBe(0);
      const ts = r.impitCalls.map(c => c.t);
      for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(95);
    });

    it('an off-host redirect is refused before any request to its target; a same-host hop is taken over impit, paced', async () => {
      const r = rig({
        env: { GALLERY_EGRESS: 'direct' },
        answer: url => (url === U(1) ? { status: 302, headers: { location: 'https://evil.example/x.jpeg' } }
          : url === U(2) ? { status: 302, headers: { location: '/upload/pictures/2022/10/14/2b.jpeg' } } : IMG),
      });
      expect(await main(['--worklist', work, '--ledger', ledger, '--pause-after', '9'], r.deps)).toBe(0);
      expect(r.impitCalls.map(c => c.url)).toEqual([U(1), U(2), U('2b'), U(3)]);
      expect(r.impitCalls.some(c => c.url.includes('evil.example'))).toBe(false);
      expect(reportOf()).toMatchObject({ fetched: 3, stored: 2, blocked: 1 });
    });

    it('three challenged fetches pause the run (exit 3) and no fourth request is sent', async () => {
      writeFileSync(work, [line('1', [1, 2, 3, 4]), line('2', [5])].join('\n') + '\n');
      const r = rig({ env: { GALLERY_EGRESS: 'direct' }, answer: () => ({ status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }) });
      expect(await main(['--worklist', work, '--ledger', ledger], r.deps)).toBe(3);
      expect(r.impitCalls.length).toBe(3);
      expect(out.join('\n')).toMatch(/PAUSED until/);
    });

    it('a run already told to stop sends nothing over impit (the kill switch sits under the pacer)', async () => {
      const r = rig({ env: { GALLERY_EGRESS: 'direct' } });
      const ac = new AbortController();
      ac.abort();
      expect(await main(['--worklist', work, '--ledger', ledger], { ...r.deps, signal: ac.signal })).toBe(7);
      expect(r.impitCalls).toEqual([]);
    });
  });

  describe('the probe over impit', () => {
    it('PASSes on 200 images and its evidence names the impit lane and the header NAMES sent', async () => {
      const r = rig({ env: { GALLERY_EGRESS: 'direct' } });
      expect(await main(['--worklist', work, '--ledger', ledger, '--probe', '2'], r.deps)).toBe(0);
      expect(out.join('\n')).toMatch(/PROBE PASS/);
      const ev = evidenceOf();
      expect(ev).toHaveLength(2);
      for (const e of ev) {
        expect(e).toMatchObject({ lane: 'impit', status: 200, outcome: 'ok', setCookie: false, redirected: false });
        expect(e.sentHeaderNames).toEqual(expect.arrayContaining(['accept', 'user-agent']));
        expect(e.sentHeaderNames).not.toContain('cookie');
      }
    });

    it('FAILs on a challenge, with cf-ray in the evidence, and exits 5', async () => {
      const r = rig({ env: { GALLERY_EGRESS: 'direct' }, answer: () => ({ status: 403, headers: { 'cf-mitigated': 'challenge', 'cf-ray': '8f00aa-IAD' } }) });
      expect(await main(['--worklist', work, '--ledger', ledger, '--probe', '3'], r.deps)).toBe(5);
      expect(out.join('\n')).toMatch(/PROBE FAIL: .*cf-mitigated challenge/);
      expect(evidenceOf()[0]).toMatchObject({ lane: 'impit', status: 403, cfRay: '8f00aa-IAD', outcome: 'blocked' });
    });

    it('a Set-Cookie on an impit response is a note, and nothing is sent back', async () => {
      const r = rig({ env: { GALLERY_EGRESS: 'direct' }, answer: () => ({ ...IMG, headers: { ...IMG.headers, 'set-cookie': '__cf_bm=x; Path=/' } }) });
      expect(await main(['--worklist', work, '--ledger', ledger, '--probe', '2'], r.deps)).toBe(0);
      expect(out.join('\n')).toMatch(/note: Set-Cookie seen on 2 response/);
      expect(r.impitCalls.every(c => !Object.keys(c.headers).map(h => h.toLowerCase()).includes('cookie'))).toBe(true);
    });
  });

  it('the env-built hook and the env policy (no doubles): an impit row with the lane switched off is refused before any session is built', async () => {
    const r = rig({ env: { GALLERY_EGRESS: 'direct', IMAGE_HOST_POLICY_JSON: JSON.stringify({ [STATIC]: SHARED_ROW }) } });
    const { makeHook: _hook, policy: _policy, ...real } = r.deps;
    expect(await main(['--worklist', work, '--ledger', ledger], real)).toBe(4);
    expect(out.join('\n')).toMatch(/EGRESS static\.myfigurecollection\.net: the policy row says residential/);
    expect(out.join('\n')).toMatch(/REFUSED: the image capture lane is off/);
    expect(r.made).toEqual([]);
    expect(r.impitCalls).toEqual([]);
  });

  it('an http row never builds an impit session', async () => {
    const r = rig({ row: { lane: 'http', egress: 'direct' } });
    const withHttp = { ...r.deps, baseFetch: async (url: string) => { r.httpCalls.push(url); return { status: 200, url, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'image/png' : null) }, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) }; } };
    expect(await main(['--worklist', work, '--ledger', ledger], withHttp)).toBe(0);
    expect(r.httpCalls).toEqual([U(1), U(2), U(3)]);
    expect(r.made).toEqual([]);
  });
});
