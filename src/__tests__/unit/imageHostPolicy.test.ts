/**
 * The IMAGE HOST POLICY table and the lane decision it feeds.
 *
 * Which lane an image rides is decided by TWO things, in this order: the operator's table (a host →
 * rule map from the environment) and, absent a rule, the suffix rule the engine already uses for
 * egress — an image on the DECLARING store's own hosts inherits that store's lane and egress; one on
 * a third-party CDN does not (the residential exit is a home line, and it is not spent on a host that
 * never declared it).
 *
 * Two invariants are pinned hard here:
 *   - the table OVERRIDES the suffix rule (that is what it is for: a store's CDN that needs the
 *     browser, an off-store host that must ride the store's egress);
 *   - the DENY list beats everything, including any table entry that tries to re-enable it.
 *     otakumode.com is permanently banned — never crawled, never fetched, never emitted.
 */
import {
  DENIED_IMAGE_HOSTS,
  buildImageHostPolicy,
  chooseImageLane,
  loadImageHostPolicy,
} from '../../services/images/imageHostPolicy';

const PAGE = 'https://www.anitoysgk.com/products/lucy';
const empty = buildImageHostPolicy({});

describe('loadImageHostPolicy', () => {
  it('defaults to the permaban alone — otakumode.com and every host under it', () => {
    const policy = loadImageHostPolicy({} as NodeJS.ProcessEnv);
    expect(policy.ruleFor('otakumode.com')).toEqual({ deny: true });
    expect(policy.ruleFor('cdn.otakumode.com')).toEqual({ deny: true });
    expect(policy.ruleFor('images.cdn.otakumode.com')).toEqual({ deny: true });
    expect(policy.ruleFor('cdn.shopify.com')).toEqual({});
    // A look-alike that merely ENDS with the banned string is a different host.
    expect(policy.ruleFor('nototakumode.com')).toEqual({});
    expect(DENIED_IMAGE_HOSTS).toContain('otakumode.com');
  });

  it('reads an inline table from IMAGE_HOST_POLICY_JSON', () => {
    const policy = loadImageHostPolicy({
      IMAGE_HOST_POLICY_JSON: JSON.stringify({
        'cdn11.bigcommerce.com': { lane: 'http', referer: true },
        'anitoysgk.com': { lane: 'browser', egress: 'residential', ua: 'chrome' },
      }),
    } as NodeJS.ProcessEnv);

    expect(policy.ruleFor('cdn11.bigcommerce.com')).toEqual({ lane: 'http', referer: true });
    expect(policy.ruleFor('cdn.anitoysgk.com')).toEqual({ lane: 'browser', egress: 'residential', ua: 'chrome' });
  });

  it('reads a table from the file named by IMAGE_HOST_POLICY_FILE', () => {
    const readFile = jest.fn(() => JSON.stringify({ 'cdn.shopify.com': { lane: 'http' } }));
    const policy = loadImageHostPolicy({ IMAGE_HOST_POLICY_FILE: '/etc/fc/image-policy.json' } as NodeJS.ProcessEnv, { readFile });
    expect(readFile).toHaveBeenCalledWith('/etc/fc/image-policy.json');
    expect(policy.ruleFor('cdn.shopify.com')).toEqual({ lane: 'http' });
  });

  it('falls back to the defaults with ONE warning when the value is unusable', () => {
    const warn = jest.fn();
    expect(loadImageHostPolicy({ IMAGE_HOST_POLICY_JSON: '{not json' } as NodeJS.ProcessEnv, { warn }).ruleFor('cdn.shopify.com')).toEqual({});
    expect(loadImageHostPolicy({ IMAGE_HOST_POLICY_JSON: '["a list is not a table"]' } as NodeJS.ProcessEnv, { warn }).ruleFor('cdn.shopify.com')).toEqual({});
    const readFile = jest.fn(() => { throw new Error('ENOENT'); });
    expect(loadImageHostPolicy({ IMAGE_HOST_POLICY_FILE: '/missing.json' } as NodeJS.ProcessEnv, { warn, readFile }).ruleFor('x.test')).toEqual({});
    expect(warn).toHaveBeenCalledTimes(3);
    // The permaban survives every unusable value.
    expect(loadImageHostPolicy({ IMAGE_HOST_POLICY_JSON: '{not json' } as NodeJS.ProcessEnv, { warn }).ruleFor('otakumode.com')).toEqual({ deny: true });
  });

  it('drops an unknown or invalid field, keeping the rest of the rule, with a warning', () => {
    const warn = jest.fn();
    const policy = loadImageHostPolicy({
      IMAGE_HOST_POLICY_JSON: JSON.stringify({
        'cdn.test': { lane: 'carrier-pigeon', egress: 'satellite', referer: 'yes', ua: 'firefox', extra: 1 },
        'ok.test': { lane: 'impit' },
      }),
    } as NodeJS.ProcessEnv, { warn });

    expect(policy.ruleFor('cdn.test')).toEqual({});
    expect(policy.ruleFor('ok.test')).toEqual({ lane: 'impit' });
    expect(warn).toHaveBeenCalled();
  });

  it('ignores an entry that is not an object at all, and warns through the console by default', () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const policy = loadImageHostPolicy({
      IMAGE_HOST_POLICY_JSON: JSON.stringify({ 'cdn.test': 'browser', 'list.test': ['browser'], 'ok.test': { lane: 'http' } }),
    } as NodeJS.ProcessEnv);

    expect(policy.ruleFor('cdn.test')).toEqual({});
    expect(policy.ruleFor('list.test')).toEqual({});
    expect(policy.ruleFor('ok.test')).toEqual({ lane: 'http' });
    expect(consoleWarn).toHaveBeenCalledTimes(2);
    consoleWarn.mockRestore();
  });

  it('does not let an unusable entry SHADOW the parent rule it sits under', () => {
    const warn = jest.fn();
    const policy = loadImageHostPolicy({
      IMAGE_HOST_POLICY_JSON: JSON.stringify({ 'example.com': { lane: 'impit' }, 'cdn.example.com': 'browser' }),
    } as NodeJS.ProcessEnv, { warn });

    // The typo'd key is skipped entirely, so the subtree keeps falling through to its parent.
    expect(policy.ruleFor('cdn.example.com')).toEqual({ lane: 'impit' });
    expect(policy.ruleFor('img.cdn.example.com')).toEqual({ lane: 'impit' });
    expect(warn).toHaveBeenCalled();
  });

  it('fails CLOSED on a wrongly-typed deny — a deny list must never be dropped on a typo', () => {
    const warn = jest.fn();
    const policy = loadImageHostPolicy({
      IMAGE_HOST_POLICY_JSON: JSON.stringify({ 'blocked.test': { deny: 'true' } }),
    } as NodeJS.ProcessEnv, { warn });
    expect(policy.ruleFor('blocked.test')).toEqual({ deny: true });
  });

  it('falls through to IMAGE_HOST_POLICY_FILE when the inline JSON is unusable', () => {
    const warn = jest.fn();
    const readFile = jest.fn(() => JSON.stringify({ 'cdn.shopify.com': { lane: 'browser' } }));
    const policy = loadImageHostPolicy(
      { IMAGE_HOST_POLICY_JSON: 'not json', IMAGE_HOST_POLICY_FILE: '/etc/fc/image-policy.json' } as NodeJS.ProcessEnv,
      { warn, readFile },
    );
    expect(readFile).toHaveBeenCalledWith('/etc/fc/image-policy.json');
    expect(policy.ruleFor('cdn.shopify.com')).toEqual({ lane: 'browser' });
  });

  it('matches the LONGEST host suffix, and normalizes case and a leading dot or www.', () => {
    const policy = loadImageHostPolicy({
      IMAGE_HOST_POLICY_JSON: JSON.stringify({
        'example.com': { lane: 'http' },
        '.cdn.example.com': { lane: 'browser' },
        'WWW.Shop.Test': { lane: 'impit' },
      }),
    } as NodeJS.ProcessEnv);

    expect(policy.ruleFor('example.com')).toEqual({ lane: 'http' });
    expect(policy.ruleFor('assets.example.com')).toEqual({ lane: 'http' });
    expect(policy.ruleFor('img.cdn.example.com')).toEqual({ lane: 'browser' });
    expect(policy.ruleFor('Shop.Test')).toEqual({ lane: 'impit' });
    expect(policy.ruleFor('www.shop.test')).toEqual({ lane: 'impit' });
  });

  it('canonicalizes a trailing-dot FQDN, so the permaban cannot be evaded by the absolute spelling', () => {
    const policy = loadImageHostPolicy({} as NodeJS.ProcessEnv);
    // `otakumode.com.` is the root-anchored spelling of the SAME host — DNS resolves it identically.
    expect(policy.ruleFor('otakumode.com.')).toEqual({ deny: true });
    expect(policy.ruleFor('cdn.otakumode.com.')).toEqual({ deny: true });
    // An operator rule must match the dotted spelling too, or the table silently stops applying.
    expect(buildImageHostPolicy({ 'cdn.shopify.com': { lane: 'impit' } }).ruleFor('cdn.shopify.com.')).toEqual({ lane: 'impit' });
  });

  it('cannot be talked out of the permaban — a table entry for a banned host stays denied', () => {
    const policy = loadImageHostPolicy({
      IMAGE_HOST_POLICY_JSON: JSON.stringify({
        'otakumode.com': { lane: 'browser', deny: false },
        'cdn.otakumode.com': { lane: 'http', deny: false },
      }),
    } as NodeJS.ProcessEnv);
    expect(policy.ruleFor('otakumode.com')).toEqual({ deny: true });
    expect(policy.ruleFor('cdn.otakumode.com')).toEqual({ deny: true });
  });

  it('keeps a per-host Accept, and drops one that is not a plain header value', () => {
    const warn = jest.fn();
    const policy = loadImageHostPolicy({
      IMAGE_HOST_POLICY_JSON: JSON.stringify({
        // A host whose masters are only served when the archival Accept is narrowed further.
        'cdn.example.test': { accept: 'image/png, image/jpeg' },
        // Header INJECTION, and a non-string: both dropped, the rest of the rule survives.
        'split.example.test': { lane: 'http', accept: 'image/png\r\nX-Injected: 1' },
        'typed.example.test': { lane: 'http', accept: 7 },
      }),
    } as NodeJS.ProcessEnv, { warn });

    expect(policy.ruleFor('cdn.example.test')).toEqual({ accept: 'image/png, image/jpeg' });
    expect(policy.ruleFor('split.example.test')).toEqual({ lane: 'http' });
    expect(policy.ruleFor('typed.example.test')).toEqual({ lane: 'http' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  /**
   * A browser tab always carries the browser's identity, so `ua: 'default'` — "claim no browser" —
   * is not something the browser lane can deliver. Before this the row passed the loader silently.
   * It did NOT resolve to Chrome: it reached the gated tab with no request UA, so the tab's own
   * rules stood (clean-headful: the real Chrome's UA; headless: the host's mint UA, else the engine
   * default) — the 2026-09-09 hobby-genki inversion was the http lane's `?? IMAGE_CHROME_UA`, not
   * this pairing. It is refused anyway so the token means ONE thing on every lane. The other
   * contradictory pairings this table knows (http+residential, off-store+residential) are TYPED
   * refusals, so this
   * one is too — named at boot, where the operator reads the [IMAGE-POLICY] warnings, and refused at
   * the decision. The row is KEPT rather than dropped: dropping it would let the host fall through
   * to a parent rule and be fetched under an identity the operator never wrote.
   */
  it('warns at boot on a row pairing lane:browser with ua:default, naming the host, and keeps the row for the decision to refuse', () => {
    const warn = jest.fn();
    const policy = loadImageHostPolicy({
      IMAGE_HOST_POLICY_JSON: JSON.stringify({
        'cdn.example.test': { lane: 'browser', ua: 'default' },
        'ok.example.test': { lane: 'impit' },
      }),
    } as NodeJS.ProcessEnv, { warn });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[IMAGE-POLICY\]/);
    expect(warn.mock.calls[0][0]).toMatch(/cdn\.example\.test/);
    expect(warn.mock.calls[0][0]).toMatch(/browser/);
    expect(warn.mock.calls[0][0]).toMatch(/default/);
    expect(policy.ruleFor('cdn.example.test')).toEqual({ lane: 'browser', ua: 'default' });
    expect(policy.ruleFor('ok.example.test')).toEqual({ lane: 'impit' });
  });

  it('does not warn for ua:default on the http or impit lanes, for ua:chrome on the browser lane, or for a row naming no lane', () => {
    const warn = jest.fn();
    loadImageHostPolicy({
      IMAGE_HOST_POLICY_JSON: JSON.stringify({
        'a.test': { lane: 'http', ua: 'default' },
        'b.test': { lane: 'impit', ua: 'default' },
        'c.test': { lane: 'browser', ua: 'chrome' },
        // No lane written: which one this host inherits is a fact about the store's declaration,
        // which the loader does not have — that case is the decision's to refuse.
        'd.test': { ua: 'default' },
      }),
    } as NodeJS.ProcessEnv, { warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn on a deny:true row that also pairs lane:browser with ua:default — its images are refused as denied, not as the pairing', () => {
    const warn = jest.fn();
    const policy = loadImageHostPolicy({
      IMAGE_HOST_POLICY_JSON: JSON.stringify({
        // The deny is answered at the decision BEFORE the lane is even resolved, so a boot line
        // blaming the pairing would send the operator to fix a row whose refusal is the deny they
        // wrote. The lane/ua fields still survive the load, unchanged, for the day the deny is lifted.
        'shut.example.test': { deny: true, lane: 'browser', ua: 'default' },
        // A non-boolean deny reads as deny:true (fail closed) and earns ONE warning — that one, not
        // the pairing's.
        'typo.example.test': { lane: 'browser', ua: 'default', deny: 'yes' },
      }),
    } as NodeJS.ProcessEnv, { warn });

    expect(policy.ruleFor('shut.example.test')).toEqual({ deny: true, lane: 'browser', ua: 'default' });
    expect(policy.ruleFor('typo.example.test')).toEqual({ deny: true, lane: 'browser', ua: 'default' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/non-boolean 'deny'/);
    expect(warn.mock.calls.map(c => c[0]).join('\n')).not.toMatch(/browser-lane-default-ua/);
  });
});

describe('chooseImageLane', () => {
  it('inherits the declaring store\'s lane and egress for an image on the store\'s own hosts', () => {
    const decision = chooseImageLane(PAGE, 'https://cdn.anitoysgk.com/i/1.jpg', { transport: 'browser', egress: 'residential' }, empty);
    expect(decision).toEqual({ ok: true, lane: 'browser', egress: 'residential', referer: PAGE, ua: 'chrome' });
  });

  it('maps the store\'s impersonate transport onto the impit bytes lane', () => {
    expect(chooseImageLane(PAGE, 'https://www.anitoysgk.com/i/1.jpg', { transport: 'impersonate' }, empty))
      .toMatchObject({ ok: true, lane: 'impit', egress: 'direct' });
  });

  it('treats an UNDECLARED store as the browser lane on its own hosts (the ingest default)', () => {
    expect(chooseImageLane(PAGE, 'https://www.anitoysgk.com/i/1.jpg', undefined, empty))
      .toMatchObject({ ok: true, lane: 'browser', egress: 'direct' });
  });

  it('DROPS the declared egress off-store, and takes the plain lane', () => {
    const decision = chooseImageLane(PAGE, 'https://cdn11.bigcommerce.com/s-x/images/1.jpg', { transport: 'browser', egress: 'residential' }, empty);
    expect(decision).toEqual({ ok: true, lane: 'http', egress: 'direct', referer: PAGE, ua: 'default' });
  });

  it('does not treat a look-alike host as the store (the dot in the suffix test is load-bearing)', () => {
    expect(chooseImageLane(PAGE, 'https://evilanitoysgk.com/i/1.jpg', { transport: 'impersonate', egress: 'residential' }, empty))
      .toMatchObject({ ok: true, lane: 'http', egress: 'direct' });
  });

  it('carries a per-host Accept into the decision, and omits it when the row sets none', () => {
    const policy = buildImageHostPolicy({ 'cdn11.bigcommerce.com': { accept: 'image/png' } });

    expect(chooseImageLane(PAGE, 'https://cdn11.bigcommerce.com/s-x/images/1.jpg', { transport: 'http' }, policy))
      .toEqual({ ok: true, lane: 'http', egress: 'direct', referer: PAGE, ua: 'default', accept: 'image/png' });
    expect(chooseImageLane(PAGE, 'https://cdn.shopify.com/i/1.jpg', { transport: 'http' }, policy))
      .not.toHaveProperty('accept');
  });

  it('lets the POLICY override the suffix rule in both directions', () => {
    const policy = buildImageHostPolicy({
      // An off-store CDN the operator has pinned to the impersonating lane.
      'cdn11.bigcommerce.com': { lane: 'impit', referer: true },
      // An on-store CDN that must NOT inherit the store's browser lane.
      'cdn.anitoysgk.com': { lane: 'http', egress: 'direct', referer: false, ua: 'default' },
      // An on-store CDN the operator has put ON the residential exit, overriding a direct store.
      'img.anitoysgk.com': { lane: 'impit', egress: 'residential' },
    });

    expect(chooseImageLane(PAGE, 'https://cdn11.bigcommerce.com/s-x/images/1.jpg', { transport: 'http' }, policy))
      .toEqual({ ok: true, lane: 'impit', egress: 'direct', referer: PAGE, ua: 'chrome' });
    expect(chooseImageLane(PAGE, 'https://cdn.anitoysgk.com/i/1.jpg', { transport: 'browser', egress: 'residential' }, policy))
      .toEqual({ ok: true, lane: 'http', egress: 'direct', ua: 'default' });
    expect(chooseImageLane(PAGE, 'https://img.anitoysgk.com/i/1.jpg', { transport: 'http' }, policy))
      .toEqual({ ok: true, lane: 'impit', egress: 'residential', referer: PAGE, ua: 'chrome' });
  });

  /**
   * A policy row putting an OFF-STORE host on the residential exit cannot work, and the reason is
   * two rules meeting: the exit is scoped to the declaring store's own hosts, so the final-url guard
   * re-asserts `isDeclaringStoreUrl` on whatever the bytes came from and rejects them. The fetch
   * would leave through the home line, download the body, and then be thrown away — every cost of
   * the residential exit paid, nothing kept.
   *
   * So the pairing is refused at the DECISION, before the line is touched. Silently downgrading it
   * to direct would be worse than useless: the operator wrote that row because they believed the
   * host needed the residential exit, and a quiet direct fetch would answer them with a 403 they
   * then have to explain. The refusal names what is wrong instead.
   */
  it('refuses a policy row putting an OFF-STORE host on the residential exit', () => {
    const policy = buildImageHostPolicy({ 'cdn11.bigcommerce.com': { lane: 'impit', egress: 'residential' } });
    const decision = chooseImageLane(PAGE, 'https://cdn11.bigcommerce.com/s-x/images/1.jpg', { transport: 'http' }, policy);

    expect(decision).toMatchObject({ ok: false, reason: 'off-store-residential' });
    expect(!decision.ok && decision.detail).toMatch(/anitoysgk\.com/);
  });

  it('allows the same row on the browser lane too — the refusal is about the EGRESS, not the lane', () => {
    const policy = buildImageHostPolicy({ 'cdn11.bigcommerce.com': { lane: 'browser', egress: 'residential' } });
    expect(chooseImageLane(PAGE, 'https://cdn11.bigcommerce.com/s-x/images/1.jpg', { transport: 'http' }, policy))
      .toMatchObject({ ok: false, reason: 'off-store-residential' });
  });

  it('answers a row contradictory BOTH ways with browser-lane-default-ua first — one reason per deploy', () => {
    // The refusals are ORDERED (http-lane-residential, then browser-lane-default-ua, then
    // off-store-residential): this row surfaces the ua pairing now and the off-store egress only
    // once that is fixed. Pinned so the module header's account of the order stays true.
    const policy = buildImageHostPolicy({ 'cdn11.bigcommerce.com': { lane: 'browser', ua: 'default', egress: 'residential' } });
    expect(chooseImageLane(PAGE, 'https://cdn11.bigcommerce.com/s-x/images/1.jpg', { transport: 'http' }, policy))
      .toMatchObject({ ok: false, reason: 'browser-lane-default-ua' });
  });

  it('still allows an ON-STORE host on the residential exit, which is what the exit is for', () => {
    const policy = buildImageHostPolicy({ 'anitoysgk.com': { lane: 'impit', egress: 'residential' } });
    expect(chooseImageLane(PAGE, 'https://www.anitoysgk.com/i/1.jpg', { transport: 'http' }, policy))
      .toMatchObject({ ok: true, egress: 'residential' });
  });

  it('DENIES a banned host no matter what the store declared', () => {
    const policy = loadImageHostPolicy({} as NodeJS.ProcessEnv);
    expect(chooseImageLane('https://otakumode.com/p/1', 'https://cdn.otakumode.com/i/1.jpg', { transport: 'browser' }, policy))
      .toMatchObject({ ok: false, reason: 'denied' });
    expect(chooseImageLane(PAGE, 'https://otakumode.com/i/1.jpg', { transport: 'http' }, policy))
      .toMatchObject({ ok: false, reason: 'denied' });
  });

  it('refuses the plain lane with residential egress — that pairing has no transport', () => {
    const policy = buildImageHostPolicy({ 'cdn.example.com': { lane: 'http', egress: 'residential' } });
    expect(chooseImageLane(PAGE, 'https://cdn.example.com/i/1.jpg', { transport: 'http' }, policy))
      .toMatchObject({ ok: false, reason: 'http-lane-residential' });
  });

  it('DENIES the trailing-dot and fullwidth-dot spellings of a banned host', () => {
    const policy = loadImageHostPolicy({} as NodeJS.ProcessEnv);
    expect(chooseImageLane(PAGE, 'https://cdn.otakumode.com./i/1.jpg', { transport: 'http' }, policy))
      .toMatchObject({ ok: false, reason: 'denied' });
    // The fullwidth ideographic full stop IDN-normalizes to the same trailing dot.
    expect(chooseImageLane(PAGE, 'https://otakumode.com\u3002/i/1.jpg', { transport: 'http' }, policy))
      .toMatchObject({ ok: false, reason: 'denied' });
  });

  it('refuses a URL whose scheme is not http(s) — file:, data: and blob: are not fetchable images', () => {
    expect(chooseImageLane(PAGE, 'file:///etc/passwd', { transport: 'http' }, empty)).toMatchObject({ ok: false, reason: 'denied' });
    expect(chooseImageLane(PAGE, 'data:image/png;base64,iVBORw0KGgo=', { transport: 'http' }, empty)).toMatchObject({ ok: false, reason: 'denied' });
    expect(chooseImageLane(PAGE, 'blob:https://shop.test/abc', { transport: 'http' }, empty)).toMatchObject({ ok: false, reason: 'denied' });
  });

  it('refuses a URL that does not parse rather than guessing a lane for it', () => {
    expect(chooseImageLane(PAGE, 'not a url', { transport: 'http' }, empty)).toMatchObject({ ok: false, reason: 'denied' });
    expect(chooseImageLane('not a url', 'https://cdn.example.com/i/1.jpg', { transport: 'http' }, empty))
      .toMatchObject({ ok: true, lane: 'http', egress: 'direct' });
  });

  it('sends the declaring page as Referer by DEFAULT, off-store as well as on', () => {
    // Hotlink protection is a THIRD-PARTY-CDN mechanism, so the off-store case is exactly the one
    // that needs the header; a real browser sends a referrer for both.
    expect(chooseImageLane(PAGE, 'https://cdn11.bigcommerce.com/s-x/images/1.jpg', { transport: 'http' }, empty))
      .toMatchObject({ ok: true, lane: 'http', referer: PAGE });
    expect(chooseImageLane(PAGE, 'https://cdn.anitoysgk.com/i/1.jpg', { transport: 'http' }, empty))
      .toMatchObject({ ok: true, referer: PAGE });
  });

  it('honours an explicit referer:true off-store and referer:false on-store', () => {
    const policy = buildImageHostPolicy({ 'cdn.shopify.com': { referer: true }, 'www.anitoysgk.com': { referer: false } });
    expect(chooseImageLane(PAGE, 'https://cdn.shopify.com/i/1.jpg', { transport: 'http' }, policy))
      .toMatchObject({ ok: true, referer: PAGE });
    expect(chooseImageLane(PAGE, 'https://www.anitoysgk.com/i/1.jpg', { transport: 'browser' }, policy))
      .toEqual({ ok: true, lane: 'browser', egress: 'direct', ua: 'chrome' });
  });

  /**
   * `ua: 'default'` means "claim no browser". The http lane delivers it by sending no user agent and
   * the impit lane by sending whatever it already sends (its impersonation profile's, or a pinned
   * mint UA); a browser TAB cannot deliver it at all — its user agent is the browser's own Chrome
   * string whatever the row says. So the pairing is a refusal, in the same shape as
   * http+residential: typed, named, and never a silent resolution to Chrome. (Before, it reached
   * the tab with no request UA and the tab's own rules stood; the inversion was the http lane's
   * `?? IMAGE_CHROME_UA`.)
   */
  it('refuses a row pairing the browser lane with ua:default — a tab cannot claim no browser', () => {
    const policy = buildImageHostPolicy({ 'cdn11.bigcommerce.com': { lane: 'browser', ua: 'default' } });
    const decision = chooseImageLane(PAGE, 'https://cdn11.bigcommerce.com/s-x/images/1.jpg', { transport: 'http' }, policy);

    expect(decision).toMatchObject({ ok: false, reason: 'browser-lane-default-ua' });
    expect(!decision.ok && decision.detail).toMatch(/cdn11\.bigcommerce\.com/);
    expect(!decision.ok && decision.detail).toMatch(/'http' or 'impit'/);
  });

  it('refuses ua:default when the browser lane is INHERITED from the store rather than written in the row', () => {
    // The loader cannot catch this one: which lane an on-store image inherits is a fact about the
    // store's declaration, which no table knows — the same reason off-store-residential is refused
    // at the decision rather than at load.
    const policy = buildImageHostPolicy({ 'cdn.anitoysgk.com': { ua: 'default' } });
    const declaredBrowser = chooseImageLane(PAGE, 'https://cdn.anitoysgk.com/i/1.jpg', { transport: 'browser' }, policy);
    expect(declaredBrowser).toMatchObject({ ok: false, reason: 'browser-lane-default-ua' });
    expect(!declaredBrowser.ok && declaredBrowser.detail).toMatch(/anitoysgk\.com/);
    // An UNDECLARED store is the browser lane on its own hosts (the ingest default) — refused too.
    expect(chooseImageLane(PAGE, 'https://cdn.anitoysgk.com/i/1.jpg', undefined, policy))
      .toMatchObject({ ok: false, reason: 'browser-lane-default-ua' });
  });

  it('still honours ua:default on the http and impit lanes, written in the row or inherited', () => {
    const policy = buildImageHostPolicy({
      'cdn.shopify.com': { lane: 'impit', ua: 'default' },
      'cdn.anitoysgk.com': { ua: 'default' },
    });
    expect(chooseImageLane(PAGE, 'https://cdn.shopify.com/i/1.jpg', { transport: 'browser' }, policy))
      .toMatchObject({ ok: true, lane: 'impit', ua: 'default' });
    expect(chooseImageLane(PAGE, 'https://cdn.anitoysgk.com/i/1.jpg', { transport: 'http' }, policy))
      .toMatchObject({ ok: true, lane: 'http', ua: 'default' });
    expect(chooseImageLane(PAGE, 'https://cdn.anitoysgk.com/i/1.jpg', { transport: 'impersonate' }, policy))
      .toMatchObject({ ok: true, lane: 'impit', ua: 'default' });
  });

  it('NEVER emits browser + default, whatever the row, the store declaration and the host', () => {
    const lanes = [undefined, 'http', 'impit', 'browser'] as const;
    const uas = [undefined, 'chrome', 'default'] as const;
    const transports = [undefined, 'http', 'impersonate', 'browser'] as const;
    const urls = ['https://cdn.anitoysgk.com/i/1.jpg', 'https://cdn11.bigcommerce.com/s-x/images/1.jpg'];
    let decisions = 0;
    for (const lane of lanes) for (const ua of uas) for (const transport of transports) for (const url of urls) {
      const row = { ...(lane !== undefined ? { lane } : {}), ...(ua !== undefined ? { ua } : {}) };
      const policy = buildImageHostPolicy({ 'cdn.anitoysgk.com': row, 'cdn11.bigcommerce.com': row });
      const decision = chooseImageLane(PAGE, url, transport !== undefined ? { transport } : undefined, policy);
      decisions += 1;
      if (decision.ok) expect(`${decision.lane}+${decision.ua}`).not.toBe('browser+default');
      else {
        // Nothing else in this sweep can refuse: no deny, no residential egress. So a refusal is this
        // one, and only ever for a row that asked for `default`.
        expect(decision.reason).toBe('browser-lane-default-ua');
        expect(ua).toBe('default');
      }
    }
    expect(decisions).toBe(lanes.length * uas.length * transports.length * urls.length);
  });
});
