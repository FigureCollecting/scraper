/**
 * SESSION-LOST — the sticky per-host signal that a login-gated host is answering as if we were
 * logged out. Unlike `stale`, a clean page fetch cannot clear it (a dead login with a live
 * cf_clearance still returns clean item pages, which would flap `stale` off within seconds). Only a
 * cookie-file reload carrying NEW values clears it: that is the re-mint the signal asks for.
 */
import {
  CfCookieStore,
  markSessionLostIfStored,
  type CfCookieSessionSignals,
  type CfCookieSource,
} from '../../services/cookieJar';

const FILE = (sess: string, cf = 'FAKE_cf_1') =>
  JSON.stringify({
    'myfigurecollection.net': { cookies: { cf_clearance: cf, PHPSESSID: sess } },
    'anitoysgk.com': { cookies: { cf_clearance: 'FAKE_cf_2' } },
  });

function fakeFs(initial: string) {
  let content: string | undefined = initial;
  let mtimeMs = 1_000;
  const fds = new Map<number, { content: string; mtimeMs: number }>();
  let next = 3;
  return {
    fs: {
      openSync: () => {
        if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        const fd = next++;
        fds.set(fd, { content, mtimeMs });
        return fd;
      },
      fstatSync: (fd: number) => ({ mtimeMs: fds.get(fd)!.mtimeMs }),
      readFileSync: (fd: number) => fds.get(fd)!.content,
      closeSync: (fd: number) => void fds.delete(fd),
    },
    write: (body: string) => {
      content = body;
      mtimeMs += 1;
    },
    remove: () => {
      content = undefined;
    },
  };
}

const build = (initial = FILE('FAKE_sess_1')) => {
  const f = fakeFs(initial);
  const store = new CfCookieStore({ path: '/x/cf-cookies.json', fs: f.fs as never, now: () => 1_700_000_000_000 });
  store.load();
  return { f, store };
};

const mfc = (store: CfCookieStore) => store.view().find(v => v.host === 'myfigurecollection.net')!;

describe('CfCookieStore — sessionLost', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
  });

  it('starts false on every host, beside stale', () => {
    const { store } = build();
    expect(store.view().map(v => [v.host, v.sessionLost])).toEqual([
      ['myfigurecollection.net', false],
      ['anitoysgk.com', false],
    ]);
  });

  it('flips once on a host with stored cookies (subdomains resolve to the entry), logged by NAME only', () => {
    const { store } = build();
    expect(store.markSessionLost('static.myfigurecollection.net', 'impit', 'placeholder body on a login-gated host', 'PHPSESSID')).toBe(true);
    expect(store.markSessionLost('myfigurecollection.net', 'impit', 'again', 'PHPSESSID')).toBe(false);
    expect(mfc(store)).toMatchObject({
      sessionLost: true,
      sessionLostSince: new Date(1_700_000_000_000).toISOString(),
      sessionLostReason: 'placeholder body on a login-gated host',
      stale: false,
    });
    const lines = warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('SESSION LOST'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('myfigurecollection.net');
    expect(lines[0]).not.toContain('FAKE_');
    expect(JSON.stringify(store.view())).not.toContain('FAKE_');
  });

  it('is a no-op on a host without stored cookies', () => {
    const { store } = build();
    expect(store.markSessionLost('unknown.test', 'impit', 'x')).toBe(false);
    expect(store.view().every(v => !v.sessionLost)).toBe(true);
  });

  it('is NOT cleared by markFresh — the clean page fetch that flaps stale', () => {
    const { store } = build();
    store.markStale('myfigurecollection.net', 'impit', 'challenge');
    store.markSessionLost('myfigurecollection.net', 'impit', 'placeholder', 'PHPSESSID');
    expect(store.markFresh('myfigurecollection.net')).toBe(true);
    expect(mfc(store)).toMatchObject({ stale: false, sessionLost: true });
  });

  it('survives a reload with the SAME values (a re-sync, new mtime) — nothing was re-minted', () => {
    const { f, store } = build();
    store.markSessionLost('myfigurecollection.net', 'impit', 'placeholder', 'PHPSESSID');
    f.write(FILE('FAKE_sess_1'));
    expect(store.poll()).toBe(true);
    expect(mfc(store).sessionLost).toBe(true);
  });

  it('survives a reload that rotated only ANOTHER cookie when the session cookie was named', () => {
    const { f, store } = build();
    store.markSessionLost('myfigurecollection.net', 'impit', 'placeholder', 'PHPSESSID');
    f.write(FILE('FAKE_sess_1', 'FAKE_cf_ROTATED'));
    store.poll();
    expect(mfc(store).sessionLost).toBe(true);
  });

  it('is cleared by a reload carrying a NEW session value — the re-mint', () => {
    const { f, store } = build();
    store.markSessionLost('myfigurecollection.net', 'impit', 'placeholder', 'PHPSESSID');
    f.write(FILE('FAKE_sess_2'));
    store.poll();
    expect(mfc(store)).toMatchObject({ sessionLost: false });
    expect(mfc(store)).not.toHaveProperty('sessionLostSince');
  });

  it('with no session cookie named, any changed value of the host clears it', () => {
    const { f, store } = build();
    store.markSessionLost('myfigurecollection.net', 'impit', 'placeholder');
    f.write(FILE('FAKE_sess_1', 'FAKE_cf_ROTATED'));
    store.poll();
    expect(mfc(store).sessionLost).toBe(false);
  });

  it('survives the file vanishing and coming back with the same values', () => {
    const { f, store } = build();
    store.markSessionLost('myfigurecollection.net', 'impit', 'placeholder', 'PHPSESSID');
    f.remove();
    store.poll();
    expect(store.view()).toEqual([]);
    f.write(FILE('FAKE_sess_1'));
    store.poll();
    expect(mfc(store).sessionLost).toBe(true);
  });

  it('a session cookie the entry does not hold falls back to every value', () => {
    const { f, store } = build();
    store.markSessionLost('anitoysgk.com', 'impit', 'x', 'PHPSESSID');
    f.write(FILE('FAKE_sess_1').replace('FAKE_cf_2', 'FAKE_cf_3'));
    store.poll();
    expect(store.view().find(v => v.host === 'anitoysgk.com')!.sessionLost).toBe(false);
  });
});

describe('markSessionLostIfStored', () => {
  const fake = (stored: boolean): CfCookieSource & CfCookieSessionSignals & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
      calls,
      cookiesFor: () => (stored ? { PHPSESSID: 'x' } : undefined),
      userAgentFor: () => undefined,
      markSessionLost: (...args: unknown[]) => {
        calls.push(args);
        return true;
      },
    };
  };

  it('forwards to the store only for a url whose host has stored cookies, keyed by that host', () => {
    const withCookies = fake(true);
    expect(markSessionLostIfStored(withCookies, 'https://static.myfigurecollection.net/a.png', 'impit', 'why', 'PHPSESSID')).toBe(true);
    expect(withCookies.calls).toEqual([['static.myfigurecollection.net', 'impit', 'why', 'PHPSESSID']]);
    const without = fake(false);
    expect(markSessionLostIfStored(without, 'https://a.test/x.png', 'impit', 'why')).toBe(false);
    expect(without.calls).toEqual([]);
  });

  it('ignores a url that does not parse', () => {
    const withCookies = fake(true);
    expect(markSessionLostIfStored(withCookies, 'not a url', 'impit', 'why')).toBe(false);
    expect(withCookies.calls).toEqual([]);
  });
});
