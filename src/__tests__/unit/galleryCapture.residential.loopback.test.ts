/**
 * GAL-RES: GALLERY_EGRESS=residential through the REAL Job entry (galleryCaptureCli.ts as a child process), the REAL impit and a REAL
 * SOCKS5 exit on loopback (socks5Loopback.ts, standing in for fc-infra's egress-proxy). The image urls name a port nothing listens on;
 * only the exit routes it to the image server, so a file arrives only if it went through the exit (sent from the process's own address
 * it meets a closed port). The env-built capture hook resolves the exit from RESIDENTIAL_PROXY_URL exactly as the live capture does.
 * Nothing here leaves 127.0.0.1.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AI_CRAWLER_UA } from '../helpers/galleryDriverDoubles';
import {
  cliEnv, png, readDispatches, readLedger, runCli, startCli, startLoopback, useLockDir, withDispatchClock, writeWorklist, type Loopback,
} from '../helpers/galleryLoopback';
import { closedPort, startSocks5, type Socks5Loopback } from '../helpers/socks5Loopback';

jest.setTimeout(180_000);

/** What one request may read on the real lanes: the 32 MiB cap plus the 1 MiB chunk allowance. */
const RESERVE = 32 * 1024 * 1024 + 1024 * 1024;
/** The Job's row for the static host: impit, residential, no Referer, the profile's own UA. */
const ROW = { lane: 'impit', egress: 'residential', referer: false, ua: 'default' };

let lb: Loopback;
let socks: Socks5Loopback;
/** The port the image urls name: closed, routed by the exit to the image server. */
let fake: number;
let dir: string;
let wl: string;
let ledger: string;
beforeEach(async () => {
  lb = await startLoopback();
  socks = await startSocks5();
  fake = await closedPort();
  socks.route(fake, lb.portA);
  dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-res-loopback-'));
  useLockDir(dir);
  wl = path.join(dir, 'wl.jsonl');
  ledger = path.join(dir, 'ledger.jsonl');
});
afterEach(async () => {
  await socks.close();
  await lb.close();
  rmSync(dir, { recursive: true, force: true });
});

const url = (p: string): string => `http://localhost:${fake}/${p}`;
/** Items on the store `localhost` (the item page), whose image host is the same store: residential may carry them. */
const items = (specs: Array<{ id: number | string; paths: string[] }>): void =>
  writeWorklist(lb, wl, specs.map(s => ({ id: s.id, site: 'mfc', pageUrl: `http://localhost/item/${s.id}`, entries: s.paths.map((p, i) => ({ position: i, src: url(p) })) })));
const resEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => cliEnv(lb, {
  IMAGE_HOST_POLICY_JSON: JSON.stringify({ localhost: ROW }),
  GALLERY_ALLOWED_HOSTS: `http://localhost:${fake}`,
  RESIDENTIAL_PROXY_URL: socks.url,
  GALLERY_EGRESS: 'residential',
  GALLERY_MAX_BYTES: String(100 * 1024 * 1024),
  IMAGE_FETCH_CONCURRENCY: '1',
  ...over,
});
const base = (...more: string[]): string[] => ['--worklist', wl, '--ledger', ledger, ...more];
const pngLen = (p: string): number => png(`A:${p.split('/').slice(1).join('/')}`).length;

describe('the residential exit, through the real Job entry', () => {
  it('the test figure alone (--item, 16 entries): every request through the exit, no cookie, no Referer, a Chrome identity; bytes counted', async () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => (i === 0 ? 'cookie/f0.jpeg' : `img/f${i}.jpeg`));
    items([{ id: 7, paths: ['img/other.jpeg'] }, { id: 1005999, paths: sixteen }, { id: 8, paths: ['img/later.jpeg'] }]);
    const r = await runCli(base('--item', 'mfc/1005999'), resEnv());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`EGRESS localhost: residential, through the scraper's residential exit socks5://127\\.0\\.0\\.1:${socks.port} .*budget 104857600 bytes`));
    expect(r.report).toMatchObject({ stopped: 'done', items: 1, fetched: 16, stored: 16, blocked: 0, budget: 104857600 });
    expect(r.report!.bytesRead).toBe(sixteen.reduce((n, p) => n + pngLen(p), 0));
    expect(lb.a.map(s => s.path)).toEqual(sixteen.map(p => `/${p}`));
    // every request reached the image server through the exit: the port the urls name is closed
    expect(socks.connects.length).toBeGreaterThanOrEqual(1);
    expect(socks.connects.every(c => c.port === fake)).toBe(true);
    for (const s of lb.a) {
      expect(s.host).toBe(`localhost:${fake}`);
      expect(s.headers.cookie).toBeUndefined();
      expect(s.headers.referer).toBeUndefined();
      expect(String(s.headers['user-agent'])).toMatch(/Chrome\/\d+/);
      expect(AI_CRAWLER_UA.test(String(s.headers['user-agent']))).toBe(false);
    }
    expect(readLedger(ledger).filter(x => x.s === 'stored').map(x => x.i)).toEqual(Array(16).fill('mfc/1005999'));
    expect(lb.puts.filter(p => p.replied)).toHaveLength(16);
  });

  it('stops at the budget before a request that could cross it (exit 0, stopped "budget"); the ledger holds exactly what was stored', async () => {
    items([{ id: 1, paths: ['img/1.jpeg', 'img/2.jpeg', 'img/3.jpeg', 'img/4.jpeg'] }]);
    const two = pngLen('img/1.jpeg') + pngLen('img/2.jpeg');
    const r = await runCli(base(), resEnv({ GALLERY_MAX_BYTES: String(RESERVE + two) }));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/STOPPED at the byte budget/);
    expect(r.report).toMatchObject({ stopped: 'budget', fetched: 3, stored: 3, budget: RESERVE + two });
    expect(Number(r.report!.bytesRead)).toBeLessThanOrEqual(RESERVE + two);
    expect(lb.a.map(s => s.path)).toEqual(['/img/1.jpeg', '/img/2.jpeg', '/img/3.jpeg']);
    expect(readLedger(ledger).map(x => [x.u, x.s])).toEqual([[url('img/1.jpeg'), 'stored'], [url('img/2.jpeg'), 'stored'], [url('img/3.jpeg'), 'stored']]);
  });

  it('a body over the 32 MiB cap with NO declared length is read only to the first chunk past the cap, settled oversize, never stored; the run then stops', async () => {
    items([{ id: 1, paths: ['img/1.jpeg', 'bigstream/41943040/x', 'img/3.jpeg'] }]);
    const budget = RESERVE + 1000;
    const r = await runCli(base(), resEnv({ GALLERY_MAX_BYTES: String(budget) }));
    expect(r.code).toBe(0);
    expect(r.report).toMatchObject({ stopped: 'budget', fetched: 2, stored: 1, oversize: 1 });
    const read = Number(r.report!.bytesRead);
    expect(read).toBeGreaterThan(32 * 1024 * 1024);
    expect(read).toBeLessThanOrEqual(budget);
    expect(lb.a.map(s => s.path)).toEqual(['/img/1.jpeg', '/bigstream/41943040/x']);
    expect(readLedger(ledger).map(x => x.s)).toEqual(['stored', 'oversize']);
    expect(lb.puts.filter(p => p.replied)).toHaveLength(1);
  });

  it('a DECLARED length over the cap is refused before the body is read: it costs the budget nothing', async () => {
    items([{ id: 1, paths: ['big-cl/1.jpeg', 'img/2.jpeg'] }]);
    const r = await runCli(base(), resEnv());
    expect(r.report).toMatchObject({ fetched: 2, stored: 1, oversize: 1, bytesRead: pngLen('img/2.jpeg') });
  });

  it('a body the lane does not read (a 404, a declared length over the cap) is let go at once: its connection through the exit closes before the next answer', async () => {
    items([{ id: 1, paths: ['endless/404/a', 'slow/b.jpeg', 'endless-cl/c', 'slow/d.jpeg'] }]);
    const r = await runCli(base(), resEnv());
    expect(r.report).toMatchObject({ fetched: 4, stored: 2, gone: 1, oversize: 1, bytesRead: pngLen('slow/b.jpeg') + pngLen('slow/d.jpeg') });
    const asked = (p: string): number => lb.a.find(s => s.path === p)!.t;
    const closed = (p: string): number | undefined => lb.closed.find(c => c.path === p)?.t;
    // each slow answer is sent 1.5 s after its request: an unread body still open then was held, not let go
    expect(closed('/endless/404/a')).toBeLessThan(asked('/slow/b.jpeg') + 1500);
    expect(closed('/endless-cl/c')).toBeLessThan(asked('/slow/d.jpeg') + 1500);
  });

  it('an off-host redirect is refused before any request to its target: the exit is never asked for it', async () => {
    items([{ id: 1, paths: ['img/1.jpeg', 'redir/2.jpeg', 'img/3.jpeg'] }]);
    const r = await runCli(base(), resEnv());
    expect(r.report).toMatchObject({ fetched: 3, stored: 2, blocked: 1 });
    expect(lb.b).toEqual([]);
    expect(socks.connects.some(c => c.port === lb.portB)).toBe(false);
  });

  it('a same-host redirect chain is followed by hand through the exit, every hop paced at the host rate', async () => {
    items([{ id: 1, paths: ['redir-chain/2/p.jpeg', 'img/q.jpeg'] }]);
    const clock = path.join(dir, 'dispatch.jsonl');
    const r = await runCli(base(), withDispatchClock(resEnv(), clock));
    expect(r.report).toMatchObject({ stored: 2 });
    expect(lb.a.map(s => s.path)).toEqual(['/redir-chain/2/p.jpeg', '/redir-chain/1/p.jpeg', '/img/p.jpeg', '/img/q.jpeg']);
    const sent = readDispatches(clock).filter(d => d.url.startsWith(url('')));
    expect(sent.map(d => d.lane)).toEqual(['impit', 'impit', 'impit', 'impit']);
    const gaps = sent.slice(1).map((d, i) => d.t - sent[i]!.t);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(85);
  });

  it('one request in flight: a slow answer holds the next request back', async () => {
    items([{ id: 1, paths: ['slow/1.jpeg', 'slow/2.jpeg', 'img/3.jpeg'] }]);
    const r = await runCli(base(), resEnv());
    expect(r.report).toMatchObject({ stored: 3 });
    expect(lb.a[1]!.t - lb.a[0]!.t).toBeGreaterThanOrEqual(1400);
    expect(lb.a[2]!.t - lb.a[1]!.t).toBeGreaterThanOrEqual(1400);
  });

  it('a listed placeholder is refused (never stored), and the bytes it cost are counted', async () => {
    items([{ id: 1, paths: ['img/ph.jpeg'] }, { id: 2, paths: ['img/2.jpeg'] }]);
    const sha = createHash('sha256').update(png('A:ph.jpeg')).digest('hex');
    const r = await runCli(base(), resEnv({ IMAGE_HOST_POLICY_JSON: JSON.stringify({ localhost: { ...ROW, placeholders: { [sha]: 'display_gated' } } }) }));
    // exit 6 / itemsWithFailures: the driver's pre-GAL-RES handling of a display-gated answer on every lane (reported, not changed here)
    expect(r.code).toBe(6);
    expect(r.report).toMatchObject({ fetched: 2, stored: 1, itemsWithFailures: 1, bytesRead: pngLen('img/ph.jpeg') + pngLen('img/2.jpeg') });
    expect(lb.puts.filter(p => p.replied).map(p => p.meta['x-amz-meta-url'])).toEqual([url('img/2.jpeg')]);
  });

  it('three challenged fetches pause the run (exit 3); no fourth request goes through the exit', async () => {
    items([{ id: 1, paths: ['cf/1.jpeg', 'cf/2.jpeg', 'cf/3.jpeg', 'cf/4.jpeg'] }]);
    const r = await runCli(base(), resEnv());
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/PAUSED until/);
    expect(lb.a).toHaveLength(3);
    expect(lb.puts).toEqual([]);
  });

  it('a probe PASSes with evidence naming the impit lane and the residential egress of every request', async () => {
    items([{ id: 1, paths: ['img/1.jpeg', 'img/2.jpeg'] }]);
    const r = await runCli(base('--probe', '2'), resEnv());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PROBE PASS/);
    expect(r.out).toMatch(/note: 2 request\(s\) left through the residential exit/);
    const ev = JSON.parse(/^PROBE-EVIDENCE (.*)$/m.exec(r.out)![1]!) as Array<Record<string, unknown>>;
    expect(ev.map(e => [e.lane, e.egress, e.status])).toEqual([['impit', 'residential', 200], ['impit', 'residential', 200]]);
  });

  it('SIGTERM stops the run at once: no further request through the exit, exit 7', async () => {
    items([{ id: 1, paths: ['slow/1.jpeg', 'slow/2.jpeg', 'slow/3.jpeg', 'slow/4.jpeg'] }]);
    const run = startCli(base(), resEnv());
    const t0 = Date.now();
    // generous: a loaded CI runner can take a long time to start the child (tsx) and make its first request
    while (lb.a.length < 1 && Date.now() - t0 < 120_000) await new Promise(res => setTimeout(res, 25));
    expect(lb.a.length).toBeGreaterThanOrEqual(1);
    run.child.kill('SIGTERM');
    const done = await run.done;
    expect(done.code).toBe(7);
    expect(lb.a.length).toBeLessThanOrEqual(2);
  });
});

describe('a proxy in the environment would carry a run past every guard: refused before any request (exit 2)', () => {
  /** The image urls name the closed port: only a proxy could deliver them. */
  const direct = (lane: 'http' | 'impit', over: Record<string, string | undefined>): NodeJS.ProcessEnv => resEnv({
    IMAGE_HOST_POLICY_JSON: JSON.stringify({ localhost: { ...ROW, lane } }), GALLERY_EGRESS: 'direct', GALLERY_MAX_BYTES: undefined,
    RESIDENTIAL_PROXY_URL: undefined, ...over,
  });

  it('ALL_PROXY on a direct impit run (impit would honour it): nothing reaches the proxy or the image host', async () => {
    items([{ id: 1, paths: ['img/1.jpeg', 'img/2.jpeg'] }]);
    const r = await runCli(base('--probe', '2'), direct('impit', { ALL_PROXY: socks.url }));
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/REFUSED: the environment sets ALL_PROXY/);
    expect(r.out).not.toContain(socks.url);
    expect(socks.connects).toEqual([]);
    expect(lb.a).toEqual([]);
  });

  it('HTTP_PROXY with NODE_USE_ENV_PROXY=1 on a direct http run (Node\'s fetch would honour it): nothing reaches the proxy or the image host', async () => {
    items([{ id: 1, paths: ['img/1.jpeg'] }]);
    const r = await runCli(base(), direct('http', { HTTP_PROXY: `http://127.0.0.1:${lb.portB}`, NODE_USE_ENV_PROXY: '1' }));
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/REFUSED: the environment sets HTTP_PROXY, NODE_USE_ENV_PROXY/);
    expect(lb.b).toEqual([]);
    expect(lb.a).toEqual([]);
  });

  it('a lower-case https_proxy on a residential run: the exit is never dialled', async () => {
    items([{ id: 1, paths: ['img/1.jpeg'] }]);
    const r = await runCli(base(), resEnv({ https_proxy: socks.url }));
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/REFUSED: the environment sets https_proxy/);
    expect(socks.connects).toEqual([]);
    expect(lb.a).toEqual([]);
  });
});

describe('refused before the exit is ever dialled', () => {
  it('GALLERY_EGRESS=residential without GALLERY_MAX_BYTES: exit 4', async () => {
    items([{ id: 1, paths: ['img/1.jpeg'] }]);
    const r = await runCli(base(), resEnv({ GALLERY_MAX_BYTES: undefined }));
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/REFUSED: GALLERY_EGRESS=residential needs GALLERY_MAX_BYTES/);
    expect(socks.connects).toEqual([]);
    expect(lb.a).toEqual([]);
  });

  it('without RESIDENTIAL_PROXY_URL: exit 4', async () => {
    items([{ id: 1, paths: ['img/1.jpeg'] }]);
    const r = await runCli(base(), resEnv({ RESIDENTIAL_PROXY_URL: undefined }));
    expect(r.code).toBe(4);
    expect(socks.connects).toEqual([]);
  });

  it('the kill switch (PERSIST_RAW_IMAGES=false): exit 4', async () => {
    items([{ id: 1, paths: ['img/1.jpeg'] }]);
    const r = await runCli(base(), resEnv({ PERSIST_RAW_IMAGES: 'false' }));
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/REFUSED: the image capture lane is off/);
    expect(socks.connects).toEqual([]);
  });

  it('another run holds the lease: LOCKED, exit 8', async () => {
    items([{ id: 1, paths: ['img/1.jpeg'] }]);
    writeFileSync(path.join(dir, 'gallery-capture.lock'), JSON.stringify({ token: 'abc', hostname: 'pod-a', startedAt: Date.now() - 60_000, heartbeatAt: Date.now() - 2_000 }));
    const r = await runCli(base(), resEnv());
    expect(r.code).toBe(8);
    expect(socks.connects).toEqual([]);
  });
});
