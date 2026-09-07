/**
 * CfCookieStore — the per-host STORED-COOKIE jar (CF_COOKIE_FILE): a host-keyed JSON file of hand-
 * minted Cloudflare/session cookies (+ the mint User-Agent) that the three fetch lanes inject. Pure
 * and injectable (fs / clock / poll interval) so every behavior below is deterministic:
 *
 *   - disabled (no path) / missing file → empty; malformed file → last-good kept + ONE warn
 *   - host keys normalized (case, leading www.); lookup by exact host then parent-domain fallback
 *   - hot reload on file mtime change (unref'd poll), which also resets stale marks
 *   - markStale/markFresh transitions; view() carries cookie NAMES only — never a value
 *   - singleton wiring reads CF_COOKIE_FILE
 *
 * Every fixture value is an obviously-fake placeholder ('FAKE_…'); the leak assertions grep for them.
 */
import { join } from 'path';
import {
  CfCookieStore,
  getCfCookieStore,
  resetCfCookieStore,
  resolveCfCookieFilePath,
  markStaleIfStored,
  markFreshIfStored,
} from '../../services/cookieJar';

/** Cookie VALUES used across the fixtures — the leak assertions prove none of these ever surfaces. */
const VALUES = ['FAKE_cf_1', 'FAKE_sess_1', 'FAKE_cf_2', 'FAKE_cf_ROTATED', 'FAKE_tfa_1'];

const FILE_V1 = JSON.stringify({
  'www.MyFigureCollection.net': {
    cookies: { cf_clearance: 'FAKE_cf_1', PHPSESSID: 'FAKE_sess_1' },
    userAgent: 'Mozilla/5.0 FAKE-MINT-UA',
    mintedAt: '2026-09-06T00:00:00.000Z',
    expiresAt: '2026-09-07T00:00:00.000Z',
  },
  'anitoysgk.com': { cookies: { cf_clearance: 'FAKE_cf_2' } },
});

const FILE_V2 = JSON.stringify({
  'myfigurecollection.net': { cookies: { cf_clearance: 'FAKE_cf_ROTATED', tfaTrust: 'FAKE_tfa_1' } },
});

/**
 * An in-memory fs with real DESCRIPTOR semantics: `openSync` binds the file's content AND mtime as
 * they stand at that instant, and `fstatSync` / `readFileSync(fd)` serve THAT one snapshot. The
 * legacy path surface (`statSync` / `readFileSync(path)`) is kept beside it and serves whatever the
 * file holds at the moment of the call, so a check-then-use pair — a path stat, then a separate path
 * read — is observably different from one descriptor when `raceOnMtime` replaces the file between
 * the two. Reads/stats/opens throw ENOENT while the file is "missing".
 */
function fakeFs(initial?: string) {
  let content: string | undefined = initial;
  let mtimeMs = 1_000;
  let reads = 0;
  let nextFd = 3;
  const calls: string[] = [];
  const open = new Map<number, { content: string; mtimeMs: number }>();
  let race: (() => void) | undefined;
  const enoent = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  const ebadf = () => Object.assign(new Error('EBADF: bad file descriptor'), { code: 'EBADF' });
  /** The snapshot a descriptor is bound to — a closed/unknown fd is EBADF, as the real fs would be. */
  const held = (fd: number) => { const h = open.get(fd); if (!h) throw ebadf(); return h; };
  /** Fire the armed one-shot replacement (once) — always right after an mtime is observed. */
  const fireRace = () => { const r = race; race = undefined; r?.(); };
  return {
    fs: {
      openSync: (_p: string, _flags: 'r'): number => {
        calls.push('open');
        if (content === undefined) throw enoent();
        const fd = nextFd++;
        open.set(fd, { content, mtimeMs });
        return fd;
      },
      fstatSync: (fd: number): { mtimeMs: number } => {
        calls.push('fstat');
        const h = held(fd);
        fireRace();
        return { mtimeMs: h.mtimeMs };
      },
      readFileSync: (target: number | string, _enc: 'utf8'): string => {
        reads++;
        if (typeof target === 'number') { calls.push('read'); return held(target).content; }
        calls.push('read:path');
        if (content === undefined) throw enoent();
        return content;
      },
      closeSync: (fd: number): void => { calls.push('close'); open.delete(fd); },
      /** The legacy check-then-use surface — present ONLY so the tests below can prove it is unused. */
      statSync: (_p: string): { mtimeMs: number } => {
        calls.push('stat:path');
        if (content === undefined) throw enoent();
        const observed = mtimeMs;
        fireRace();
        return { mtimeMs: observed };
      },
    },
    /** Replace the file's content and bump its mtime (what a kubelet Secret refresh looks like). */
    write: (next: string) => { content = next; mtimeMs += 1; },
    remove: () => { content = undefined; },
    /** Arm a ONE-SHOT replacement that lands the instant the file's mtime is first observed. */
    raceOnMtime: (next: string) => { race = () => { content = next; mtimeMs += 1; }; },
    reads: () => reads,
    calls: () => [...calls],
    openFds: () => open.size,
  };
}

const build = (content?: string, over: { now?: () => number; intervalMs?: number; path?: string } = {}) => {
  const f = fakeFs(content);
  const store = new CfCookieStore({ path: over.path ?? '/var/run/fc/cf-cookies/cf-cookies.json', fs: f.fs, ...over });
  return { f, store };
};

const warnLines = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0]));

describe('CfCookieStore — disabled / missing / malformed', () => {
  it('no path (CF_COOKIE_FILE unset) → disabled: load() is a no-op, nothing resolves, view() is empty', () => {
    const f = fakeFs(FILE_V1);
    const store = new CfCookieStore({ path: undefined, fs: f.fs });
    store.load();
    expect(store.cookiesFor('https://myfigurecollection.net/item/1')).toBeUndefined();
    expect(store.userAgentFor('https://myfigurecollection.net/item/1')).toBeUndefined();
    expect(store.view()).toEqual([]);
    expect(f.reads()).toBe(0); // the file is never touched
    expect(store.poll()).toBe(false);
  });

  it('missing file → empty (no throw), a single warn naming the path — never a crash at boot', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = build(undefined);
    expect(() => store.load()).not.toThrow();
    expect(store.cookiesFor('https://anitoysgk.com/x')).toBeUndefined();
    expect(store.view()).toEqual([]);
    expect(warnLines(warn).filter((l) => l.startsWith('[CF-COOKIE]'))).toHaveLength(1);
    expect(warnLines(warn)[0]).toContain('/var/run/fc/cf-cookies/cf-cookies.json');
    // a repeat poll — or a direct re-load — on a still-missing file does not warn again
    store.poll();
    store.load();
    expect(warnLines(warn).filter((l) => l.startsWith('[CF-COOKIE]'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('malformed JSON on first load → empty + ONE warn (names only)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = build('{ not json');
    store.load();
    expect(store.view()).toEqual([]);
    const lines = warnLines(warn).filter((l) => l.startsWith('[CF-COOKIE]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('malformed');
    warn.mockRestore();
  });

  it('malformed JSON with an UNQUOTED cookie value → the warn must NOT carry the V8 parse snippet (it embeds ~10 chars of the source around the bad token)', () => {
    // A hand-edited file where an operator dropped the quotes around a value: V8's JSON.parse message is
    // `Unexpected token 'F', ..."arance": FAKE_cf_le"... is not valid JSON` — a value PREFIX in the log.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = build('{"anitoysgk.com":{"cookies":{"cf_clearance": FAKE_cf_leak_value_1}}}');
    store.load();
    expect(store.view()).toEqual([]);
    const lines = warnLines(warn).filter((l) => l.startsWith('[CF-COOKIE]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('malformed');
    expect(lines[0]).not.toContain('FAKE_cf_l');
    // the reason is a FIXED string, optionally followed by V8's digits-only position — never free text
    expect(lines[0]).toMatch(/: invalid JSON( at position \d+)? — keeping the last-good set \(0 host\(s\)\)$/);
    warn.mockRestore();
  });

  it('malformed file AFTER a good load → the last-good set is KEPT and exactly one warn is logged', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { f, store } = build(FILE_V1);
    store.load();
    expect(store.cookiesFor('https://anitoysgk.com/x')).toEqual({ cf_clearance: 'FAKE_cf_2' });

    f.write('[1, 2, 3]'); // valid JSON, wrong shape (top-level must be an object)
    expect(store.poll()).toBe(true);
    expect(store.cookiesFor('https://anitoysgk.com/x')).toEqual({ cf_clearance: 'FAKE_cf_2' }); // last-good survives
    expect(store.cookiesFor('https://myfigurecollection.net/x')).toEqual({ cf_clearance: 'FAKE_cf_1', PHPSESSID: 'FAKE_sess_1' });
    const lines = warnLines(warn).filter((l) => l.startsWith('[CF-COOKIE]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('last-good');
    // the bad mtime is remembered: a second poll on the SAME bad file neither re-reads nor re-warns
    expect(store.poll()).toBe(false);
    expect(lines).toHaveLength(1);
    warn.mockRestore();
  });

  it('skips malformed host entries (no cookies object / non-string values / empty values) and keeps the valid ones', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = build(JSON.stringify({
      'good.test': { cookies: { cf_clearance: 'FAKE_cf_1', empty: '', num: 42 as unknown as string, 'bad name': 'x', 'a=b': 'y' } },
      'nocookies.test': { userAgent: 'UA only' },      // no cookies object → dropped
      'notobject.test': 'nope',                        // entry is not an object → dropped
      'badvalue.test': { cookies: { 'cf_clearance': 'has; semicolon' } }, // unsendable value → cookie dropped, host dropped
      '': { cookies: { x: 'y' } },                     // empty host → dropped
    }));
    store.load();
    expect(store.cookiesFor('https://good.test/')).toEqual({ cf_clearance: 'FAKE_cf_1' }); // empty + non-string dropped
    expect(store.cookiesFor('https://nocookies.test/')).toBeUndefined();
    expect(store.userAgentFor('https://nocookies.test/')).toBeUndefined();
    expect(store.cookiesFor('https://notobject.test/')).toBeUndefined();
    expect(store.cookiesFor('https://badvalue.test/')).toBeUndefined();
    expect(store.view().map((v) => v.host)).toEqual(['good.test']);
    // the skip is reported by NAME only
    const all = warnLines(warn).join('\n');
    expect(all).toContain('badvalue.test');
    expect(all).not.toContain('has; semicolon');
    warn.mockRestore();
  });

  it('exactly one skipped host is reported in the singular', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = build(JSON.stringify({ 'good.test': { cookies: { a: 'FAKE_cf_1' } }, 'bad.test': { cookies: 'nope' } }));
    store.load();
    expect(store.view().map((v) => v.host)).toEqual(['good.test']);
    expect(warnLines(warn).find((l) => l.includes('skipped'))).toContain('skipped 1 malformed host entry: bad.test');
    warn.mockRestore();
  });

  it('an explicit empty path also disables the store (no fs access)', () => {
    const f = fakeFs(FILE_V1);
    const store = new CfCookieStore({ path: '', fs: f.fs });
    store.load();
    store.start();
    expect(store.view()).toEqual([]);
    expect(f.reads()).toBe(0);
    store.stop();
  });

  it('an unreadable file reports the error message when there is no errno code, and stringifies a non-Error throw', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const plain = new CfCookieStore({
      path: '/x/cf.json',
      fs: { openSync: () => 7, fstatSync: () => ({ mtimeMs: 1 }), readFileSync: () => { throw new Error('permission denied'); }, closeSync: () => {} },
    });
    plain.load();
    expect(warnLines(warn).at(-1)).toContain('(permission denied)');
    const weird = new CfCookieStore({
      path: '/x/cf.json',
      fs: { openSync: () => { throw 'disk on fire'; }, fstatSync: () => ({ mtimeMs: 1 }), readFileSync: () => 'unreached', closeSync: () => {} },
    });
    weird.load();
    expect(warnLines(warn).at(-1)).toContain('(disk on fire)');
    expect(weird.view()).toEqual([]);
    warn.mockRestore();
  });
});

/**
 * The load is ONE descriptor: open once, take the mtime by fstat on that fd and the bytes from the
 * same fd, close it. A path stat followed by a separate path read is a check-then-use race (CodeQL
 * js/file-system-race): the two calls can land on different versions of the file, so the store would
 * remember one version's mtime for another version's bytes — and when the mtime is the FRESHER of
 * the two, the poller never reloads and the re-minted cookies never go live.
 */
describe('CfCookieStore — one descriptor: the mtime and the bytes come from the SAME open file', () => {
  it('load() opens once and takes both the mtime and the body from that fd: open → fstat → read → close, never a path stat/read', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { f, store } = build(FILE_V1);
    store.load();
    expect(f.calls()).toEqual(['open', 'fstat', 'read', 'close']);
    expect(f.openFds()).toBe(0); // the descriptor is released, always
    log.mockRestore();
  });

  it('a poll on an unchanged file costs one open/fstat/close and never a read', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { f, store } = build(FILE_V1);
    store.load();
    expect(store.poll()).toBe(false);
    expect(f.calls().slice(4)).toEqual(['open', 'fstat', 'close']);
    expect(f.reads()).toBe(1); // the body was read once, by load()
    expect(f.openFds()).toBe(0);
    log.mockRestore();
  });

  it('a file REPLACED the instant its mtime is observed cannot splice the new bytes onto the old mtime: this load is that descriptor\'s own snapshot, and the next poll picks the replacement up', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { f, store } = build(FILE_V1);
    f.raceOnMtime(FILE_V2); // a re-mint lands between the mtime observation and the read
    store.load();
    // the bytes belong to the descriptor that reported the mtime — NOT to the version that replaced
    // the file after it was opened (a path stat + a separate path read would have spliced V2's bytes
    // under V1's mtime, and the mirror-image race stamps STALE bytes with the FRESH mtime forever)
    expect(store.cookiesFor('https://myfigurecollection.net/x')).toEqual({ cf_clearance: 'FAKE_cf_1', PHPSESSID: 'FAKE_sess_1' });
    // nothing is lost: the replacement carries a different mtime, so the very next poll loads it
    expect(store.poll()).toBe(true);
    expect(store.cookiesFor('https://myfigurecollection.net/x')).toEqual({ cf_clearance: 'FAKE_cf_ROTATED', tfaTrust: 'FAKE_tfa_1' });
    log.mockRestore();
  });

  it('the descriptor is released even when the read throws — never a leaked fd on an unreadable file', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const closed: number[] = [];
    const store = new CfCookieStore({
      path: '/x/cf.json',
      fs: {
        openSync: () => 7,
        fstatSync: () => ({ mtimeMs: 1 }),
        readFileSync: () => { throw Object.assign(new Error('io error'), { code: 'EIO' }); },
        closeSync: (fd: number) => { closed.push(fd); },
      },
    });
    store.load();
    expect(closed).toEqual([7]);
    expect(store.view()).toEqual([]);
    expect(warnLines(warn).at(-1)).toContain('(EIO)');
    warn.mockRestore();
  });

  it('a close that itself fails does not lose the load it completed', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const store = new CfCookieStore({
      path: '/x/cf.json',
      fs: {
        openSync: () => 7,
        fstatSync: () => ({ mtimeMs: 1 }),
        readFileSync: () => FILE_V1,
        closeSync: () => { throw Object.assign(new Error('bad fd'), { code: 'EBADF' }); },
      },
    });
    expect(() => store.load()).not.toThrow();
    expect(store.cookiesFor('https://anitoysgk.com/x')).toEqual({ cf_clearance: 'FAKE_cf_2' });
    log.mockRestore();
  });
});

describe('CfCookieStore — host normalization + parent-domain fallback', () => {
  it('normalizes file keys (case, leading www.) and matches the url host exactly', () => {
    const { store } = build(FILE_V1);
    store.load();
    expect(store.cookiesFor('https://myfigurecollection.net/item/1')).toEqual({ cf_clearance: 'FAKE_cf_1', PHPSESSID: 'FAKE_sess_1' });
    expect(store.cookiesFor('https://www.myfigurecollection.net/item/1')).toEqual({ cf_clearance: 'FAKE_cf_1', PHPSESSID: 'FAKE_sess_1' });
    expect(store.cookiesFor('https://WWW.MyFigureCollection.NET/item/1')).toEqual({ cf_clearance: 'FAKE_cf_1', PHPSESSID: 'FAKE_sess_1' });
    expect(store.userAgentFor('https://www.myfigurecollection.net/item/1')).toBe('Mozilla/5.0 FAKE-MINT-UA');
    expect(store.view().map((v) => v.host).sort()).toEqual(['anitoysgk.com', 'myfigurecollection.net']);
  });

  it('falls back to a parent domain (a.b.example → b.example → example) so subdomains of a minted apex are covered', () => {
    const { store } = build(FILE_V1);
    store.load();
    expect(store.cookiesFor('https://static.cdn.anitoysgk.com/img.png')).toEqual({ cf_clearance: 'FAKE_cf_2' });
    expect(store.cookiesFor('https://api.anitoysgk.com/v1/items')).toEqual({ cf_clearance: 'FAKE_cf_2' });
    // a mere suffix is NOT a parent: never bleed cookies across registrable domains
    expect(store.cookiesFor('https://other-anitoysgk.com/x')).toBeUndefined();
    expect(store.cookiesFor('https://anitoysgk.com.evil.test/x')).toBeUndefined();
  });

  it('unknown host / unparseable url → undefined for cookies and UA', () => {
    const { store } = build(FILE_V1);
    store.load();
    expect(store.cookiesFor('https://example.com/')).toBeUndefined();
    expect(store.userAgentFor('https://example.com/')).toBeUndefined();
    expect(store.cookiesFor('not a url')).toBeUndefined();
    expect(store.userAgentFor('not a url')).toBeUndefined();
    // a single-label host (no dot) has no parent to fall back to
    expect(store.cookiesFor('http://localhost:3050/health')).toBeUndefined();
  });

  it('returns a COPY of the cookie map — a caller merging/mutating it cannot alter the store', () => {
    const { store } = build(FILE_V1);
    store.load();
    const first = store.cookiesFor('https://anitoysgk.com/x')!;
    first.cf_clearance = 'MUTATED';
    (first as Record<string, string>).injected = 'x';
    expect(store.cookiesFor('https://anitoysgk.com/x')).toEqual({ cf_clearance: 'FAKE_cf_2' });
  });
});

describe('CfCookieStore — hot reload on mtime (unref\'d poll)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('start() loads once, then a changed mtime is picked up on the next tick; an unchanged mtime is never re-read', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { f, store } = build(FILE_V1, { intervalMs: 30_000 });
    store.start();
    expect(f.reads()).toBe(1);
    expect(store.cookiesFor('https://myfigurecollection.net/x')).toEqual({ cf_clearance: 'FAKE_cf_1', PHPSESSID: 'FAKE_sess_1' });

    jest.advanceTimersByTime(30_000); // same mtime → no reload
    expect(f.reads()).toBe(1);

    f.write(FILE_V2);                 // a re-mint synced into the Secret → new mtime
    jest.advanceTimersByTime(30_000);
    expect(f.reads()).toBe(2);
    expect(store.cookiesFor('https://myfigurecollection.net/x')).toEqual({ cf_clearance: 'FAKE_cf_ROTATED', tfaTrust: 'FAKE_tfa_1' });
    expect(store.cookiesFor('https://anitoysgk.com/x')).toBeUndefined(); // dropped host is gone
    // the loaded line names hosts + cookie NAMES + ua pin — never a value
    const loaded = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[CF-COOKIE] loaded'));
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toContain('loaded 2 host(s)');
    expect(loaded[0]).toContain('myfigurecollection.net(cf_clearance,PHPSESSID ua=pinned)');
    expect(loaded[0]).toContain('anitoysgk.com(cf_clearance)');
    expect(loaded[1]).toContain('loaded 1 host(s)');
    for (const v of VALUES) expect(loaded.join('\n')).not.toContain(v);
    store.stop();
    log.mockRestore();
  });

  it('a reload RESETS stale marks (a re-minted file is presumed fresh); stop() ends polling; start() is idempotent', () => {
    const { f, store } = build(FILE_V1, { intervalMs: 30_000, now: () => 5_000 });
    store.start();
    store.start(); // second start must not double the timer
    expect(store.markStale('anitoysgk.com', 'impersonate', 'challenge page')).toBe(true);
    expect(store.view().find((v) => v.host === 'anitoysgk.com')?.stale).toBe(true);

    f.write(FILE_V1); // same content, new mtime (a re-sync)
    jest.advanceTimersByTime(30_000);
    expect(store.view().find((v) => v.host === 'anitoysgk.com')?.stale).toBe(false);
    expect(f.reads()).toBe(2); // exactly one reload for one mtime change (not two timers)

    store.stop();
    f.write(FILE_V2);
    jest.advanceTimersByTime(120_000);
    expect(f.reads()).toBe(2); // stopped: no further reload
    expect(store.cookiesFor('https://anitoysgk.com/x')).toEqual({ cf_clearance: 'FAKE_cf_2' });
  });

  it('the poll timer is unref\'d so it never keeps the process alive', () => {
    const { store } = build(FILE_V1, { intervalMs: 30_000 });
    const spy = jest.spyOn(global, 'setInterval');
    store.start();
    const timer = spy.mock.results[0]?.value as { hasRef?: () => boolean } | undefined;
    expect(timer).toBeDefined();
    expect(typeof timer!.hasRef === 'function' ? timer!.hasRef() : false).toBe(false);
    store.stop();
    spy.mockRestore();
  });

  it('a file that disappears is read as empty; one that reappears is loaded again', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { f, store } = build(FILE_V1, { intervalMs: 30_000 });
    store.start();
    f.remove();
    jest.advanceTimersByTime(30_000);
    expect(store.cookiesFor('https://anitoysgk.com/x')).toBeUndefined();
    expect(store.view()).toEqual([]);
    f.write(FILE_V1);
    jest.advanceTimersByTime(30_000);
    expect(store.cookiesFor('https://anitoysgk.com/x')).toEqual({ cf_clearance: 'FAKE_cf_2' });
    store.stop();
  });
});

describe('CfCookieStore — stale / fresh transitions + view()', () => {
  it('markStale on a host WITH cookies flips stale (once, logged once by NAME); markFresh clears it', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    let clock = 1_700_000_000_000;
    const { store } = build(FILE_V1, { now: () => clock });
    store.load();
    clock += 60_000;

    expect(store.markStale('www.MyFigureCollection.net', 'browser', 'challenge page via browser transport')).toBe(true);
    expect(store.markStale('myfigurecollection.net', 'browser', 'challenge page via browser transport')).toBe(false); // already stale → no-op
    const stale = warnLines(warn).filter((l) => l.includes('[CF-COOKIE] STALE'));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('STALE myfigurecollection.net via browser');
    expect(stale[0]).toContain('[cf_clearance,PHPSESSID]');
    expect(stale[0]).toContain('re-mint');
    for (const v of VALUES) expect(stale[0]).not.toContain(v);

    const row = store.view().find((v) => v.host === 'myfigurecollection.net')!;
    expect(row.stale).toBe(true);
    expect(row.staleSince).toBe(new Date(clock).toISOString());
    expect(row.staleReason).toBe('challenge page via browser transport');
    // the other host is untouched
    expect(store.view().find((v) => v.host === 'anitoysgk.com')!.stale).toBe(false);

    expect(store.markFresh('www.myfigurecollection.net')).toBe(true);
    expect(store.markFresh('myfigurecollection.net')).toBe(false); // already fresh → no-op
    const fresh = store.view().find((v) => v.host === 'myfigurecollection.net')!;
    expect(fresh.stale).toBe(false);
    expect(fresh).not.toHaveProperty('staleSince');
    expect(fresh).not.toHaveProperty('staleReason');
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[CF-COOKIE] FRESH myfigurecollection.net'))).toHaveLength(1);
    warn.mockRestore();
    log.mockRestore();
  });

  it('markStale / markFresh on a host WITHOUT stored cookies is a silent no-op (never a log, never a row)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = build(FILE_V1);
    store.load();
    expect(store.markStale('example.com', 'http', 'challenge page')).toBe(false);
    expect(store.markFresh('example.com')).toBe(false);
    expect(warnLines(warn).filter((l) => l.includes('STALE'))).toHaveLength(0);
    expect(store.view().map((v) => v.host)).not.toContain('example.com');
    warn.mockRestore();
  });

  it('markStale resolves through the same parent-domain fallback as cookiesFor (a subdomain challenge marks the apex entry)', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = build(FILE_V1);
    store.load();
    expect(store.markStale('api.anitoysgk.com', 'impersonate', 'challenge page')).toBe(true);
    expect(store.view().find((v) => v.host === 'anitoysgk.com')!.stale).toBe(true);
  });

  it('view() carries host / cookieNames / userAgentPinned / loadedAt / mintedAt / expiresAt / stale — and NO cookie or UA value', () => {
    const clock = 1_700_000_000_000;
    const { store } = build(FILE_V1, { now: () => clock });
    store.load();
    const view = store.view();
    expect(view).toEqual(expect.arrayContaining([
      {
        host: 'myfigurecollection.net',
        cookieNames: ['cf_clearance', 'PHPSESSID'],
        userAgentPinned: true,
        loadedAt: new Date(clock).toISOString(),
        mintedAt: '2026-09-06T00:00:00.000Z',
        expiresAt: '2026-09-07T00:00:00.000Z',
        stale: false,
      },
      { host: 'anitoysgk.com', cookieNames: ['cf_clearance'], userAgentPinned: false, loadedAt: new Date(clock).toISOString(), stale: false },
    ]));
    const json = JSON.stringify(view);
    for (const v of VALUES) expect(json).not.toContain(v);
    expect(json).not.toContain('FAKE-MINT-UA');
    // and the view is a snapshot: mutating it does not reach the store
    view[0].cookieNames.push('injected');
    expect(store.view().every((v) => !v.cookieNames.includes('injected'))).toBe(true);
  });
});

describe('resolveCfCookieFilePath + singleton (CF_COOKIE_FILE)', () => {
  const ORIGINAL = process.env.CF_COOKIE_FILE;
  afterEach(() => {
    resetCfCookieStore();
    if (ORIGINAL === undefined) delete process.env.CF_COOKIE_FILE;
    else process.env.CF_COOKIE_FILE = ORIGINAL;
  });

  it('resolveCfCookieFilePath: unset / blank → undefined (disabled); a value is trimmed', () => {
    expect(resolveCfCookieFilePath({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveCfCookieFilePath({ CF_COOKIE_FILE: '' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveCfCookieFilePath({ CF_COOKIE_FILE: '   ' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveCfCookieFilePath({ CF_COOKIE_FILE: ' /var/run/fc/cf-cookies/cf-cookies.json ' } as NodeJS.ProcessEnv)).toBe('/var/run/fc/cf-cookies/cf-cookies.json');
  });

  it('getCfCookieStore() is a lazily-loaded singleton reading CF_COOKIE_FILE (real fs, fixture with FAKE values); reset drops it', () => {
    process.env.CF_COOKIE_FILE = join(__dirname, '../fixtures/cfCookies/cf-cookies.json');
    resetCfCookieStore();
    const a = getCfCookieStore();
    expect(getCfCookieStore()).toBe(a);
    expect(a.cookiesFor('https://www.myfigurecollection.net/item/1')).toEqual({ cf_clearance: 'FAKE_cf_fixture_1', PHPSESSID: 'FAKE_sess_fixture_1' });
    expect(a.userAgentFor('https://myfigurecollection.net/')).toBe('Mozilla/5.0 FAKE-FIXTURE-MINT-UA');
    expect(a.cookiesFor('https://shop.anitoysgk.com/')).toEqual({ cf_clearance: 'FAKE_cf_fixture_2' });
    resetCfCookieStore();
    expect(getCfCookieStore()).not.toBe(a);
  });

  it('with CF_COOKIE_FILE unset the singleton is disabled (byte-identical engine behavior)', () => {
    delete process.env.CF_COOKIE_FILE;
    resetCfCookieStore();
    const s = getCfCookieStore();
    expect(s.cookiesFor('https://myfigurecollection.net/')).toBeUndefined();
    expect(s.view()).toEqual([]);
    s.start(); // harmless when disabled
    s.stop();
  });
});

/**
 * The challenge-site helpers: the gate every cooldown.open / clean-fetch site uses. They consult
 * cookiesFor(url) FIRST so a host the store knows nothing about is never signalled (its challenge is
 * an egress matter, not a cookie one), and they forward the store's own transition result.
 */
describe('markStaleIfStored / markFreshIfStored — signal only for a host WITH stored cookies', () => {
  const fake = (has: boolean, transition = true) => ({
    cookiesFor: jest.fn(() => (has ? { cf_clearance: 'FAKE_cf_1' } : undefined)),
    userAgentFor: jest.fn(() => undefined),
    markStale: jest.fn(() => transition),
    markFresh: jest.fn(() => transition),
  });

  it('host WITH cookies → markStale(host, lane, reason) is forwarded and its transition result returned', () => {
    const store = fake(true);
    expect(markStaleIfStored(store, 'https://www.anitoysgk.com/p/1', 'anitoysgk.com', 'impersonate', 'challenge page')).toBe(true);
    expect(store.cookiesFor).toHaveBeenCalledWith('https://www.anitoysgk.com/p/1');
    expect(store.markStale).toHaveBeenCalledWith('anitoysgk.com', 'impersonate', 'challenge page');
    // an already-stale host reports no transition (the store's own once-only semantics pass through)
    expect(markStaleIfStored(fake(true, false), 'https://anitoysgk.com/p/2', 'anitoysgk.com', 'http', 'again')).toBe(false);
  });

  it('host WITHOUT cookies → markStale is never called, false', () => {
    const store = fake(false);
    expect(markStaleIfStored(store, 'https://unknown.example/p', 'unknown.example', 'http', 'challenge page')).toBe(false);
    expect(store.markStale).not.toHaveBeenCalled();
  });

  it('markFreshIfStored mirrors it: forwarded (and its result returned) only for a host WITH cookies', () => {
    const withCookies = fake(true);
    expect(markFreshIfStored(withCookies, 'https://anitoysgk.com/p/3', 'anitoysgk.com')).toBe(true);
    expect(withCookies.markFresh).toHaveBeenCalledWith('anitoysgk.com');
    expect(markFreshIfStored(fake(true, false), 'https://anitoysgk.com/p/3', 'anitoysgk.com')).toBe(false);
    const without = fake(false);
    expect(markFreshIfStored(without, 'https://unknown.example/p', 'unknown.example')).toBe(false);
    expect(without.markFresh).not.toHaveBeenCalled();
  });

  it('end to end on a REAL store: stale flips view().stale once, fresh clears it, an unknown host is untouched', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { fs } = fakeFs(FILE_V1);
    const store = new CfCookieStore({ path: '/x/cf-cookies.json', fs, now: () => 5_000 });
    store.load();
    expect(markStaleIfStored(store, 'https://www.anitoysgk.com/p/1', 'anitoysgk.com', 'impersonate', 'challenge page via impersonate transport')).toBe(true);
    expect(markStaleIfStored(store, 'https://www.anitoysgk.com/p/1', 'anitoysgk.com', 'impersonate', 'challenge page via impersonate transport')).toBe(false);
    expect(store.view().find((v) => v.host === 'anitoysgk.com')).toMatchObject({ stale: true, staleReason: 'challenge page via impersonate transport' });
    expect(markStaleIfStored(store, 'https://unknown.example/p', 'unknown.example', 'http', 'x')).toBe(false);
    expect(markFreshIfStored(store, 'https://anitoysgk.com/p/2', 'anitoysgk.com')).toBe(true);
    expect(store.view().find((v) => v.host === 'anitoysgk.com')).toMatchObject({ stale: false });
    expect(store.view().find((v) => v.host === 'myfigurecollection.net')).toMatchObject({ stale: false });
  });
});
