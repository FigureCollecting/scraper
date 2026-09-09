/**
 * sessionCanary — the mfc scrape session's entitlement watchdog (owner rule, 2026-09-09).
 *
 * myfigurecollection.net answers 404 to an NSFW / NSFW+ item when the requesting session is not
 * entitled (age gate, or scrape-account cookies that have gone stale) and gives no other signal, so
 * a 404 there cannot be read as "the item is gone". The canary separates the two WITHOUT guessing:
 * a KNOWN NSFW+ item and a KNOWN-good SFW item are observed together, and only the pair
 * (canary 404 + control 200) proves the session lost its entitlement.
 *
 * This module holds the RULE and the FLAG. It never fetches: the initiator wires the two
 * observations in later, which is why every case here is a pure call.
 */
import {
  resolveCanaryItemId,
  observeSessionCanary,
  observeMfcItemFetch,
  sessionCanaryView,
  resetSessionCanary,
} from '../../services/sessionCanary';

describe('resolveCanaryItemId — MFC_SESSION_CANARY_ITEM', () => {
  it('reads the configured item id', () => {
    expect(resolveCanaryItemId({ MFC_SESSION_CANARY_ITEM: '123456' } as NodeJS.ProcessEnv)).toBe('123456');
  });

  it('trims incidental whitespace', () => {
    expect(resolveCanaryItemId({ MFC_SESSION_CANARY_ITEM: '  123456  ' } as NodeJS.ProcessEnv)).toBe('123456');
  });

  it.each([undefined, '', '   '])('is undefined when unset or blank (%s) — the canary is simply off', (raw) => {
    expect(resolveCanaryItemId({ MFC_SESSION_CANARY_ITEM: raw } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('observeSessionCanary — only the PAIR is proof', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    resetSessionCanary();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); resetSessionCanary(); });

  it('marks the session stale when the NSFW canary 404s while the SFW control is served', () => {
    const verdict = observeSessionCanary({ canaryStatus: 404, controlStatus: 200 });

    expect(verdict).toBe('stale');
    const view = sessionCanaryView();
    expect(view.stale).toBe(true);
    expect(view.site).toBe('mfc');
    expect(view.staleSince).toEqual(expect.any(String));
    expect(view.staleReason).toContain('entitle');
  });

  it('logs the transition ONCE, not on every repeat observation', () => {
    observeSessionCanary({ canaryStatus: 404, controlStatus: 200 });
    observeSessionCanary({ canaryStatus: 404, controlStatus: 200 });

    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[MFC SESSION]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('re-mint');
  });

  it('clears the flag when the canary is served again', () => {
    observeSessionCanary({ canaryStatus: 404, controlStatus: 200 });
    expect(sessionCanaryView().stale).toBe(true);

    expect(observeSessionCanary({ canaryStatus: 200, controlStatus: 200 })).toBe('fresh');
    const view = sessionCanaryView();
    expect(view.stale).toBe(false);
    expect(view.staleSince).toBeUndefined();
  });

  it('says nothing when the CONTROL is also failing — that is a store or egress fault, not entitlement', () => {
    expect(observeSessionCanary({ canaryStatus: 404, controlStatus: 503 })).toBe('inconclusive');
    expect(sessionCanaryView().stale).toBe(false);
  });

  it('says nothing about a canary status that is neither served nor 404', () => {
    expect(observeSessionCanary({ canaryStatus: 500, controlStatus: 200 })).toBe('inconclusive');
    expect(sessionCanaryView().stale).toBe(false);
  });

  it('leaves an EXISTING stale flag standing on an inconclusive round (never silently recovers)', () => {
    observeSessionCanary({ canaryStatus: 404, controlStatus: 200 });
    observeSessionCanary({ canaryStatus: 404, controlStatus: 503 });
    expect(sessionCanaryView().stale).toBe(true);
  });
});

describe('sessionCanaryView — the /health/detailed shape', () => {
  beforeEach(() => resetSessionCanary());

  it('reports a never-observed canary as not stale, with no timestamps', () => {
    expect(sessionCanaryView()).toEqual({ site: 'mfc', stale: false, configured: false });
  });

  it('reports whether an item id is configured, never the id itself', () => {
    const view = sessionCanaryView({ MFC_SESSION_CANARY_ITEM: '123456' } as NodeJS.ProcessEnv);
    expect(view.configured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('123456');
  });
});

/**
 * THE QUEUE-DRIVEN CANARY (owner rule, 2026-09-09). The pairing above needs no dedicated fetch: the
 * ingest queue already fetches mfc items all day, and every one of those fetches now surfaces a
 * status. A 404 on the configured NSFW+ canary id plus a 200 on ANY other mfc item within the same
 * hour is the same proof, paid for by traffic that was happening anyway.
 *
 * The hour matters: a 200 from yesterday says nothing about the session now, and two observations
 * that never overlap must never be read as a pair.
 */
describe('observeMfcItemFetch — the pair assembled from ordinary queue traffic', () => {
  const ENV = { MFC_SESSION_CANARY_ITEM: '777777' } as NodeJS.ProcessEnv;
  const CANARY = 'https://myfigurecollection.net/item/777777';
  const OTHER = 'https://myfigurecollection.net/item/12345';
  const T0 = Date.UTC(2026, 8, 9, 4, 0, 0);
  let warn: jest.SpyInstance;

  beforeEach(() => {
    resetSessionCanary();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); resetSessionCanary(); });

  it('flags the session stale on a canary 404 after a 200 on another mfc item', () => {
    observeMfcItemFetch(OTHER, 200, { env: ENV, now: T0 });
    const verdict = observeMfcItemFetch(CANARY, 404, { env: ENV, now: T0 + 60_000 });

    expect(verdict).toBe('stale');
    expect(sessionCanaryView(ENV).stale).toBe(true);
  });

  it('flags it in the other order too (the canary 404 arriving first)', () => {
    observeMfcItemFetch(CANARY, 404, { env: ENV, now: T0 });
    expect(observeMfcItemFetch(OTHER, 200, { env: ENV, now: T0 + 5 * 60_000 })).toBe('stale');
  });

  it('does NOT pair observations more than an hour apart', () => {
    observeMfcItemFetch(OTHER, 200, { env: ENV, now: T0 });
    expect(observeMfcItemFetch(CANARY, 404, { env: ENV, now: T0 + 61 * 60_000 })).toBe('inconclusive');
    expect(sessionCanaryView(ENV).stale).toBe(false);
  });

  it('does not flag on a canary 404 alone — no proof the store is even healthy', () => {
    expect(observeMfcItemFetch(CANARY, 404, { env: ENV, now: T0 })).toBe('inconclusive');
    expect(sessionCanaryView(ENV).stale).toBe(false);
  });

  it('clears the flag the moment the canary itself is served', () => {
    observeMfcItemFetch(OTHER, 200, { env: ENV, now: T0 });
    observeMfcItemFetch(CANARY, 404, { env: ENV, now: T0 + 60_000 });
    expect(sessionCanaryView(ENV).stale).toBe(true);

    expect(observeMfcItemFetch(CANARY, 200, { env: ENV, now: T0 + 2 * 60_000 })).toBe('fresh');
    expect(sessionCanaryView(ENV).stale).toBe(false);
  });

  it('ignores a 404 on an ordinary item — only the CANARY id is the entitlement probe', () => {
    observeMfcItemFetch(OTHER, 200, { env: ENV, now: T0 });
    expect(observeMfcItemFetch(OTHER, 404, { env: ENV, now: T0 + 60_000 })).toBe('inconclusive');
    expect(sessionCanaryView(ENV).stale).toBe(false);
  });

  it('ignores every other store', () => {
    observeMfcItemFetch('https://store.example.test/product/1', 200, { env: ENV, now: T0 });
    expect(observeMfcItemFetch('https://store.example.test/item/777777', 404, { env: ENV, now: T0 + 60_000 }))
      .toBe('inconclusive');
    expect(sessionCanaryView(ENV).stale).toBe(false);
  });

  it('is inert when no canary id is configured', () => {
    observeMfcItemFetch(OTHER, 200, { env: {} as NodeJS.ProcessEnv, now: T0 });
    expect(observeMfcItemFetch(CANARY, 404, { env: {} as NodeJS.ProcessEnv, now: T0 + 60_000 })).toBe('inconclusive');
    expect(sessionCanaryView().stale).toBe(false);
  });

  it('is inert when the lane surfaced no status, and never throws on a junk URL', () => {
    expect(observeMfcItemFetch(CANARY, undefined, { env: ENV, now: T0 })).toBe('inconclusive');
    expect(() => observeMfcItemFetch('not a url', 404, { env: ENV, now: T0 })).not.toThrow();
  });

  it('logs the transition exactly once across many observations', () => {
    observeMfcItemFetch(OTHER, 200, { env: ENV, now: T0 });
    observeMfcItemFetch(CANARY, 404, { env: ENV, now: T0 + 60_000 });
    observeMfcItemFetch(CANARY, 404, { env: ENV, now: T0 + 120_000 });
    observeMfcItemFetch(OTHER, 200, { env: ENV, now: T0 + 180_000 });

    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[MFC SESSION]'))).toHaveLength(1);
  });
});
