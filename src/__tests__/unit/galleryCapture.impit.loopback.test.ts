/**
 * GAL-IMPIT: the gallery Job on the impit lane, run for real against loopback fixtures. Each test starts the real entry
 * (`galleryCaptureCli.ts`) as a child process with the REAL impit (browser 'chrome'), the env-built capture hook, the real
 * object-store sink against a fake S3 and the real flush. Nothing here leaves 127.0.0.1. What it cannot show is the TLS
 * fingerprint a CDN sees: the loopback is cleartext http.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AI_CRAWLER_UA } from '../helpers/galleryDriverDoubles';
import { cliEnv, probeEvidence, readDispatches, readLedger, runCli, startLoopback, useLockDir, withDispatchClock, writeWorklist, type Loopback } from '../helpers/galleryLoopback';

jest.setTimeout(120_000);

let lb: Loopback;
let dir: string;
let wl: string;
let ledger: string;
beforeEach(async () => {
  lb = await startLoopback();
  dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-impit-loopback-'));
  useLockDir(dir);
  wl = path.join(dir, 'wl.jsonl');
  ledger = path.join(dir, 'ledger.jsonl');
});
afterEach(async () => {
  await lb.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The committed fc-infra row's shape (lane impit, egress residential, no Referer), with ua:default so the profile's own UA stands. */
const IMPIT_ROW = { lane: 'impit', egress: 'residential', referer: false, ua: 'default' };
const impitEnv = (over: Record<string, string | undefined> = {}) =>
  cliEnv(lb, { IMAGE_HOST_POLICY_JSON: JSON.stringify({ localhost: IMPIT_ROW, '127.0.0.1': IMPIT_ROW }), GALLERY_EGRESS: 'direct', ...over });
const putUrls = (): string[] => lb.puts.filter(p => p.replied).map(p => p.meta['x-amz-meta-url'] ?? '').sort();

describe('the impit lane through the real Job entry', () => {
  it('stores the files; the host saw a Chrome identity, no cookie (even after a Set-Cookie), and no Referer', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['cookie/1.jpeg', 'img/2.jpeg', 'img/3.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], impitEnv());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/EGRESS localhost: the policy row says residential; GALLERY_EGRESS=direct/);
    expect(r.report).toMatchObject({ stopped: 'done', fetched: 3, stored: 3, blocked: 0 });
    expect(lb.a.map(s => s.path)).toEqual(['/cookie/1.jpeg', '/img/2.jpeg', '/img/3.jpeg']);
    for (const s of lb.a) {
      expect(s.headers.cookie).toBeUndefined();
      expect(s.headers.referer).toBeUndefined();
      expect(String(s.headers['user-agent'])).toMatch(/Chrome\/\d+/);
      expect(AI_CRAWLER_UA.test(String(s.headers['user-agent']))).toBe(false);
      expect(s.headers['sec-ch-ua']).toMatch(/Google Chrome/);
    }
    expect(putUrls()).toEqual([lb.urlA('cookie/1.jpeg'), lb.urlA('img/2.jpeg'), lb.urlA('img/3.jpeg')]);
    expect(readLedger(ledger).filter(x => x.s === 'stored')).toHaveLength(3);
  });

  it('an off-host redirect is refused before any request to its target (impit follows nothing by itself)', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg', 'redir/2.jpeg', 'img/3.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], impitEnv());
    expect(lb.b).toEqual([]);
    expect(r.report).toMatchObject({ fetched: 3, stored: 2, blocked: 1 });
    expect(putUrls()).toEqual([lb.urlA('img/1.jpeg'), lb.urlA('img/3.jpeg')]);
  });

  it('a same-host redirect chain is followed by hand, every hop paced at the host rate', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['redir-chain/2/p.jpeg', 'img/q.jpeg'] }]);
    const clock = path.join(dir, 'dispatch.jsonl');
    const r = await runCli(['--worklist', wl, '--ledger', ledger], withDispatchClock(impitEnv(), clock));
    expect(r.report).toMatchObject({ stored: 2 });
    expect(lb.a.map(s => s.path)).toEqual(['/redir-chain/2/p.jpeg', '/redir-chain/1/p.jpeg', '/img/p.jpeg', '/img/q.jpeg']);
    // a 100 ms row, measured at the moment each request reaches impit's fetch inside the Job process. The session is built before
    // the first request takes its slot: built after it, the first two requests reached the host 55 to 74 ms apart (measured)
    const sent = readDispatches(clock).filter(d => d.url.startsWith(lb.urlA('')));
    expect(sent.map(d => `${d.lane} ${new URL(d.url).pathname}`)).toEqual(lb.a.map(s => `impit ${s.path}`));
    const gaps = sent.slice(1).map((d, i) => d.t - sent[i]!.t);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(85);
  });

  it('one request in flight under the Job\'s IMAGE_FETCH_CONCURRENCY=1: a slow answer holds the next request back', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['slow/1.jpeg', 'slow/2.jpeg', 'img/3.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], impitEnv({ IMAGE_FETCH_CONCURRENCY: '1' }));
    expect(r.report).toMatchObject({ stored: 3 });
    // each slow answer takes 1500 ms; with two in flight the second would start ~100 ms after the first
    expect(lb.a[1]!.t - lb.a[0]!.t).toBeGreaterThanOrEqual(1400);
    expect(lb.a[2]!.t - lb.a[1]!.t).toBeGreaterThanOrEqual(1400);
  });

  it('a probe PASSes with evidence that names the impit lane', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg', 'img/2.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger, '--probe', '2'], impitEnv());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PROBE PASS/);
    const ev = probeEvidence(r.raw);
    expect(ev.map(e => e.lane)).toEqual(['impit', 'impit']);
    expect(ev.every(e => e.status === 200 && e.redirected === false && !(JSON.parse(String(e.sent_header_names)) as string[]).includes('cookie'))).toBe(true);
  });

  it('a challenged probe FAILs (exit 5), pauses at the third request and sends no fourth', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['cf/1.jpeg', 'cf/2.jpeg', 'cf/3.jpeg', 'cf/4.jpeg', 'cf/5.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger, '--probe', '5'], impitEnv());
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/PROBE FAIL: .*cf-mitigated challenge/);
    expect(r.out).toMatch(/PAUSED until/);
    expect(lb.a).toHaveLength(3);
    expect(lb.puts).toEqual([]);
  });

  it('a residential row without GALLERY_EGRESS=direct is refused (exit 4) and the host sees nothing', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], impitEnv({ GALLERY_EGRESS: undefined }));
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/REFUSED: .*residential/);
    expect(lb.a).toEqual([]);
  });

  it('GALLERY_EGRESS=residential is refused (exit 4) and the host sees nothing', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], impitEnv({ GALLERY_EGRESS: 'residential' }));
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/REFUSED: GALLERY_EGRESS=residential/);
    expect(lb.a).toEqual([]);
  });
});
