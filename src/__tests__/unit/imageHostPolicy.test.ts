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

  it('DROPS the declared egress off-store, and takes the plain lane with no referer', () => {
    const decision = chooseImageLane(PAGE, 'https://cdn11.bigcommerce.com/s-x/images/1.jpg', { transport: 'browser', egress: 'residential' }, empty);
    expect(decision).toEqual({ ok: true, lane: 'http', egress: 'direct', ua: 'default' });
  });

  it('does not treat a look-alike host as the store (the dot in the suffix test is load-bearing)', () => {
    expect(chooseImageLane(PAGE, 'https://evilanitoysgk.com/i/1.jpg', { transport: 'impersonate', egress: 'residential' }, empty))
      .toMatchObject({ ok: true, lane: 'http', egress: 'direct' });
  });

  it('lets the POLICY override the suffix rule in both directions', () => {
    const policy = buildImageHostPolicy({
      // An off-store CDN the operator has decided must ride the store's residential exit.
      'cdn11.bigcommerce.com': { lane: 'impit', egress: 'residential', referer: true },
      // An on-store CDN that must NOT inherit the store's browser lane.
      'cdn.anitoysgk.com': { lane: 'http', egress: 'direct', referer: false, ua: 'default' },
    });

    expect(chooseImageLane(PAGE, 'https://cdn11.bigcommerce.com/s-x/images/1.jpg', { transport: 'http' }, policy))
      .toEqual({ ok: true, lane: 'impit', egress: 'residential', referer: PAGE, ua: 'chrome' });
    expect(chooseImageLane(PAGE, 'https://cdn.anitoysgk.com/i/1.jpg', { transport: 'browser', egress: 'residential' }, policy))
      .toEqual({ ok: true, lane: 'http', egress: 'direct', ua: 'default' });
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

  it('honours an explicit referer:true off-store and referer:false on-store', () => {
    const policy = buildImageHostPolicy({ 'cdn.shopify.com': { referer: true }, 'www.anitoysgk.com': { referer: false } });
    expect(chooseImageLane(PAGE, 'https://cdn.shopify.com/i/1.jpg', { transport: 'http' }, policy))
      .toMatchObject({ ok: true, referer: PAGE });
    expect(chooseImageLane(PAGE, 'https://www.anitoysgk.com/i/1.jpg', { transport: 'browser' }, policy))
      .toEqual({ ok: true, lane: 'browser', egress: 'direct', ua: 'chrome' });
  });
});
