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
