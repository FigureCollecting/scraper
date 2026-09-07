import { jest } from '@jest/globals';
import type { Browser, BrowserContext } from 'puppeteer';
import {
  CONTEXT_IDLE_TTL_MS,
  MAX_CONTEXT_AGE_MS,
  MAX_PERSISTENT_CONTEXTS,
  PersistentContextCache,
  persistentContextKey,
} from '../../services/persistentContexts';

/**
 * The clearance is the asset. Cloudflare binds it to (IP, UA, context), so a fresh context re-earns
 * the challenge every time; a kept context serves clean 200s for its window. These pin the bounds
 * that make keeping it safe: 25 min max age (inside the ~30 min window), 10 min idle, 6 contexts.
 */
describe('PersistentContextCache', () => {
  const browser = { connected: true } as unknown as Browser;
  const makeContext = (id: string) => ({ id } as unknown as BrowserContext);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-07T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keys one session per (host, egress)', () => {
    expect(persistentContextKey('WWW.Anitoysgk.com', 'residential')).toBe('www.anitoysgk.com|residential');
    expect(persistentContextKey('www.anitoysgk.com', 'direct')).not.toBe(persistentContextKey('www.anitoysgk.com', 'residential'));
  });

  it('reuses a stored context within its TTL instead of opening a new one', () => {
    const cache = new PersistentContextCache();
    const context = makeContext('c1');
    const { entry } = cache.store('www.anitoysgk.com|residential', { browser, context, inUse: 0 });

    jest.advanceTimersByTime(9 * 60_000);
    const reused = cache.acquire('www.anitoysgk.com|residential');

    expect(reused.entry).toBe(entry);
    expect(reused.entry?.context).toBe(context);
    expect(reused.evicted).toEqual([]);
    expect(cache.size()).toBe(1);
  });

  it('evicts a context older than the 25 min max age, even if it was just used', () => {
    const cache = new PersistentContextCache();
    const { entry } = cache.store('a|residential', { browser, context: makeContext('c1'), inUse: 0 });

    // Kept warm by use, but age is measured from CREATION (the clearance expires on its own clock).
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(6 * 60_000);
      const touched = cache.acquire('a|residential');
      if (touched.entry) cache.release(touched.entry);
    }
    jest.advanceTimersByTime(MAX_CONTEXT_AGE_MS);
    const after = cache.acquire('a|residential');

    expect(after.entry).toBeUndefined();
    expect(after.evicted).toContain(entry);
    expect(cache.size()).toBe(0);
  });

  it('evicts a context idle beyond the 10 min TTL', () => {
    const cache = new PersistentContextCache();
    const { entry } = cache.store('b|direct', { browser, context: makeContext('c2'), inUse: 0 });

    jest.advanceTimersByTime(CONTEXT_IDLE_TTL_MS);
    const after = cache.acquire('b|direct');

    expect(after.entry).toBeUndefined();
    expect(after.evicted).toEqual([entry]);
  });

  it('caps at 6 contexts, evicting the least-recently-used', () => {
    const cache = new PersistentContextCache();
    const stored = [];
    for (let i = 0; i < MAX_PERSISTENT_CONTEXTS; i++) {
      stored.push(cache.store(`host${i}|direct`, { browser, context: makeContext(`c${i}`), inUse: 0 }).entry);
      jest.advanceTimersByTime(1000);
    }
    // Touch the oldest so it is no longer the LRU victim.
    const touched = cache.acquire('host0|direct');
    if (touched.entry) cache.release(touched.entry);

    const seventh = cache.store('host6|direct', { browser, context: makeContext('c6'), inUse: 0 });

    expect(cache.size()).toBe(MAX_PERSISTENT_CONTEXTS);
    expect(seventh.evicted).toEqual([stored[1]]); // host1 is now the least-recently-used
    expect(cache.acquire('host6|direct').entry).toBeDefined();
  });

  it('never evicts a context a fetch is still using', () => {
    const cache = new PersistentContextCache({ maxEntries: 1 });
    const inFlight = cache.store('busy|direct', { browser, context: makeContext('c1'), inUse: 1 });

    const second = cache.store('other|direct', { browser, context: makeContext('c2'), inUse: 0 });

    expect(second.evicted).toEqual([]); // the busy one survived the cap
    expect(cache.size()).toBe(2);

    // Once released it becomes a victim the cap can take, and the cap re-asserts down to 1.
    cache.release(inFlight.entry);
    const third = cache.store('third|direct', { browser, context: makeContext('c3'), inUse: 0 });
    expect(third.evicted).toContain(inFlight.entry);
    expect(cache.size()).toBe(1);
  });

  it('does not hand back a context whose browser is gone', () => {
    const dead = { connected: false } as unknown as Browser;
    const cache = new PersistentContextCache();
    cache.store('gone|direct', { browser: dead, context: makeContext('c1'), inUse: 0 });

    const after = cache.acquire('gone|direct');

    expect(after.entry).toBeUndefined();
    expect(after.evicted).toEqual([]); // nothing to close: the context died with its browser
    expect(cache.size()).toBe(0);
  });

  it('drops every entry belonging to a retired browser', () => {
    const other = { connected: true } as unknown as Browser;
    const cache = new PersistentContextCache();
    cache.store('x|direct', { browser, context: makeContext('c1'), inUse: 0 });
    cache.store('y|direct', { browser: other, context: makeContext('c2'), inUse: 0 });

    cache.dropBrowser(browser);

    expect(cache.size()).toBe(1);
    expect(cache.acquire('y|direct').entry).toBeDefined();
  });

  it('drain() hands back everything and empties the cache (shutdown)', () => {
    const cache = new PersistentContextCache();
    const first = cache.store('x|direct', { browser, context: makeContext('c1'), inUse: 0 }).entry;
    const second = cache.store('y|residential', { browser, context: makeContext('c2'), inUse: 1 }).entry;

    const drained = cache.drain();

    expect(drained).toEqual([first, second]); // in-use contexts are closed on shutdown too
    expect(cache.size()).toBe(0);
  });

  it('replacing a key hands back the context it displaced', () => {
    const cache = new PersistentContextCache();
    const first = cache.store('x|direct', { browser, context: makeContext('c1'), inUse: 0 }).entry;

    const replacement = cache.store('x|direct', { browser, context: makeContext('c2'), inUse: 0 });

    expect(replacement.evicted).toEqual([first]);
    expect(cache.size()).toBe(1);
  });

  /**
   * Two concurrent fetches to the same gated host both miss the cache and both open a context. The
   * SECOND one to finish opening must not displace the first: that entry is mid-navigation, and the
   * caller closes whatever `store` returns as evicted — closing it would kill the in-flight fetch
   * ('Target closed') and throw away the clearance it was about to earn.
   */
  it('never displaces an IN-USE entry: the late caller joins it and its duplicate is evicted', () => {
    const cache = new PersistentContextCache();
    const winner = makeContext('c1');
    const duplicate = makeContext('c2');
    const first = cache.store('www.anitoysgk.com|residential', { browser, context: winner, inUse: 1 });

    const second = cache.store('www.anitoysgk.com|residential', { browser, context: duplicate, inUse: 1 });

    expect(second.entry).toBe(first.entry);
    expect(second.entry.context).toBe(winner);
    expect(second.evicted.map((e) => e.context)).toEqual([duplicate]);
    expect(second.entry.inUse).toBe(2);
    expect(cache.size()).toBe(1);

    cache.release(second.entry);
    cache.release(first.entry);
    expect(first.entry.inUse).toBe(0);
  });

  it('evicts a mid-flight RETAINED context rather than the in-use entry it would replace', () => {
    const cache = new PersistentContextCache();
    const inFlight = makeContext('c1');
    const retained = makeContext('c2');
    const first = cache.store('a|direct', { browser, context: inFlight, inUse: 1 });

    const retain = cache.store('a|direct', { browser, context: retained, inUse: 0 });

    expect(retain.entry).toBe(first.entry);
    expect(retain.evicted.map((e) => e.context)).toEqual([retained]);
    expect(first.entry.inUse).toBe(1); // a retain claims nothing
  });

  it('still replaces an in-use entry whose browser has died (nothing to close it on)', () => {
    const dead = { connected: false } as unknown as Browser;
    const cache = new PersistentContextCache();
    const stale = makeContext('c1');
    const first = cache.store('a|direct', { browser: dead, context: stale, inUse: 1 });

    const replacement = cache.store('a|direct', { browser, context: makeContext('c2'), inUse: 1 });

    expect(replacement.entry).not.toBe(first.entry);
    expect(replacement.evicted).toEqual([first.entry]);
  });
});
