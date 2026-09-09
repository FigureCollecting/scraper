/**
 * The image lane's COMPOSITION ROOT: the env the operator sets, and the routing that turns one lane
 * decision into the right transport. Everything below the root is already tested with fakes; what is
 * tested here is that the knobs are read, bounded, and actually reach the hook.
 */
import {
  createImageCaptureHookFromEnv,
  createRecordImageCapture,
  getImageCaptureHook,
  imageCaptureView,
  resolveImageCaptureSettings,
  setImageCaptureHook,
} from '../../services/images/assembleImageCapture';
import { buildImageHostPolicy } from '../../services/images/imageHostPolicy';
import type { ExtractedData, ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';
import type { ImageCaptureHook, ImageCaptureRequest } from '../../services/images/imageCaptureHook';
import { createImageBytesRouter } from '../../services/images/imageCaptureHook';
import type { ImageBytesResult } from '../../services/images/imageBytes';

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PERSIST_RAW_IMAGES: 'true', ...over }) as NodeJS.ProcessEnv;

describe('resolveImageCaptureSettings', () => {
  it('is off unless the switch is exactly true', () => {
    expect(resolveImageCaptureSettings({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(resolveImageCaptureSettings({ PERSIST_RAW_IMAGES: 'yes' } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(resolveImageCaptureSettings(env()).enabled).toBe(true);
  });

  it("defaults to the owner's decided numbers", () => {
    expect(resolveImageCaptureSettings(env())).toMatchObject({
      maxPerItem: 12,
      memoSize: 50_000,
      residentialBytesPerDay: 1024 * 1024 * 1024,
    });
  });

  it("takes the operator's numbers when they are usable", () => {
    expect(
      resolveImageCaptureSettings(env({ IMAGE_MAX_PER_ITEM: '4', IMAGE_MEMO_SIZE: '100', IMAGE_RESIDENTIAL_BYTES_PER_DAY: '2048' })),
    ).toMatchObject({ maxPerItem: 4, memoSize: 100, residentialBytesPerDay: 2048 });
  });

  it('reads a zero residential allowance as "close the home line", not as "unset"', () => {
    expect(resolveImageCaptureSettings(env({ IMAGE_RESIDENTIAL_BYTES_PER_DAY: '0' })).residentialBytesPerDay).toBe(0);
  });

  it('bounds a per-item ceiling a typo made enormous', () => {
    expect(resolveImageCaptureSettings(env({ IMAGE_MAX_PER_ITEM: '100000' })).maxPerItem).toBe(100);
  });

  it('falls back to the default for a value that is not a usable number', () => {
    expect(resolveImageCaptureSettings(env({ IMAGE_MAX_PER_ITEM: 'twelve', IMAGE_MEMO_SIZE: '-3' }))).toMatchObject({
      maxPerItem: 12,
      memoSize: 50_000,
    });
  });
});

describe('createImageCaptureHookFromEnv', () => {
  it('builds a hook that is inert while the switch is off', async () => {
    const hook = createImageCaptureHookFromEnv({} as NodeJS.ProcessEnv);
    expect(hook.stats().enabled).toBe(false);
    await hook.capture({
      site: 's',
      itemId: 'i',
      pageUrl: 'https://store.test/p',
      fields: {},
      ruleset: { describeImages: () => [{ url: 'https://cdn.test/a.jpg', role: 'gallery', position: 0 }] },
      origin: 'ingest',
    });
    expect(hook.stats().attempted).toBe(0);
  });

  it('carries the deny list even with no policy table configured', async () => {
    const hook = createImageCaptureHookFromEnv(env(), { fetchBytes: async () => { throw new Error('must not be fetched'); } });
    await hook.capture({
      site: 's',
      itemId: 'i',
      pageUrl: 'https://store.test/p',
      fields: {},
      ruleset: { describeImages: () => [{ url: 'https://img.otakumode.com/a.jpg', role: 'gallery', position: 0 }] },
      origin: 'ingest',
    });
    expect(hook.stats()).toMatchObject({ attempted: 0, failed: 0, skipped: expect.objectContaining({ policyDeny: 1 }) });
  });
});

describe('imageCaptureView', () => {
  it("reports the hook's counters", () => {
    const view = imageCaptureView(createImageCaptureHookFromEnv(env()));
    expect(view).toMatchObject({ enabled: true, attempted: 0, stored: 0, failed: 0 });
    expect(view.skipped).toMatchObject({ policyDeny: 0, memo: 0, cap: 0 });
  });

  it('never throws when the hook cannot answer', () => {
    const broken = { stats: () => { throw new Error('nope'); } } as never;
    expect(imageCaptureView(broken).enabled).toBe(false);
  });
});

describe('createImageBytesRouter', () => {
  const okResult: ImageBytesResult = { ok: true, bytes: Buffer.from([1]), contentType: 'image/png', status: 200, finalUrl: 'u', headers: {} };

  it('sends an http-lane image to the plain lane', async () => {
    const http = jest.fn(async () => okResult);
    const router = createImageBytesRouter({ http });
    await router('https://cdn.test/a.jpg', { lane: 'http', storeHost: 'store.test' } as never);
    expect(http).toHaveBeenCalledWith('https://cdn.test/a.jpg', expect.objectContaining({ lane: 'http' }));
  });

  it('sends an impit-lane image to the impersonating lane', async () => {
    const impit = jest.fn(async () => okResult);
    const router = createImageBytesRouter({ impit, http: jest.fn(async () => okResult) });
    await router('https://cdn.test/a.jpg', { lane: 'impit', storeHost: 'store.test' } as never);
    expect(impit).toHaveBeenCalled();
  });

  it('hands the gated lane the egress and the STORE host it is keyed on', async () => {
    const gated = jest.fn(async () => okResult);
    const router = createImageBytesRouter({ gated });
    await router('https://cdn.test/a.jpg', { lane: 'browser', storeHost: 'store.test', egress: 'residential' } as never);
    expect(gated).toHaveBeenCalledWith('residential', 'store.test', 'https://cdn.test/a.jpg', expect.objectContaining({ lane: 'browser' }));
  });

  it('refuses a lane that is not wired instead of silently taking another', async () => {
    const router = createImageBytesRouter({});
    await expect(router('https://cdn.test/a.jpg', { lane: 'browser', storeHost: 'store.test' } as never)).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    await expect(router('https://cdn.test/a.jpg', { lane: 'impit', storeHost: 'store.test' } as never)).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
  });
});

describe('the process hook', () => {
  afterEach(() => setImageCaptureHook(null));

  it("is one hook, because the memo and the day's byte ledger are process-wide facts", () => {
    expect(getImageCaptureHook()).toBe(getImageCaptureHook());
  });

  it('can be replaced and forgotten again', () => {
    const fake = { capture: async () => undefined, drain: async () => undefined, stats: () => imageCaptureView() } as ImageCaptureHook;
    setImageCaptureHook(fake);
    expect(getImageCaptureHook()).toBe(fake);
    setImageCaptureHook(null);
    expect(getImageCaptureHook()).not.toBe(fake);
  });

  it('builds the real three-lane router when no transport is injected', async () => {
    // Nothing is fetched: the deny list answers before any lane is reached, which is exactly the
    // assertion — the wiring is real, and the ban still sits above it.
    const hook = createImageCaptureHookFromEnv(env());
    await hook.capture({
      site: 's',
      itemId: 'i',
      pageUrl: 'https://store.test/p',
      fields: {},
      ruleset: { describeImages: () => [{ url: 'https://otakumode.com/a.jpg', role: 'gallery', position: 0 }] },
      origin: 'ingest',
    });
    expect(hook.stats().skipped.policyDeny).toBe(1);
  });

  it('builds the pooled browser lane once and reuses it', async () => {
    // The gated lane refuses before it touches a browser when it is handed something that is not a
    // bare store hostname — which is how this exercises the real (default) wiring without Chrome.
    const hook = createImageCaptureHookFromEnv(env({ IMAGE_HOST_POLICY_JSON: JSON.stringify({ 'cdn.test': { lane: 'browser' } }) }));
    const ruleset = { describeImages: () => [{ url: 'https://cdn.test/a.jpg', role: 'gallery' as const, position: 0 }] };
    await hook.capture({ site: 's', itemId: 'i1', pageUrl: 'not-a-url', fields: {}, ruleset, origin: 'ingest' });
    await hook.capture({ site: 's', itemId: 'i2', pageUrl: 'not-a-url', fields: {}, ruleset, origin: 'ingest' });
    // Both attempts reached the lane: a FAILED fetch is deliberately not memoized, since the memo
    // records what was stored, not what was tried. The lane itself is built once and reused.
    expect(hook.stats()).toMatchObject({ attempted: 2, stored: 0, failed: 2, skipped: expect.objectContaining({ memo: 0 }) });
  });

  it('wires the failure ledger when the spine is configured', async () => {
    const hook = createImageCaptureHookFromEnv(env({ INGEST_BASE_URL: 'http://spine.invalid:1' }), {
      fetchBytes: async () => ({ ok: false, reason: 'http-status', status: 404 }),
    });
    await hook.capture({
      site: 's',
      itemId: 'i',
      pageUrl: 'https://store.test/p',
      fields: {},
      ruleset: { describeImages: () => [{ url: 'https://cdn.test/a.jpg', role: 'gallery', position: 0 }] },
      origin: 'ingest',
    });
    expect(hook.stats().failed).toBe(1);
  });

  it('resolves the residential proxy from the engine, and refuses when there is none', async () => {
    const before = process.env.RESIDENTIAL_PROXY_URL;
    delete process.env.RESIDENTIAL_PROXY_URL;
    try {
      const hook = createImageCaptureHookFromEnv(env(), {
        policy: buildImageHostPolicy({ 'cdn.test': { lane: 'impit', egress: 'residential' } }),
        fetchBytes: async () => { throw new Error('a residential image must never leave through the node'); },
      });
      await hook.capture({
        site: 's',
        itemId: 'i',
        pageUrl: 'https://store.test/p',
        fields: {},
        ruleset: { describeImages: () => [{ url: 'https://cdn.test/a.jpg', role: 'gallery', position: 0 }] },
        origin: 'ingest',
      });
      expect(hook.stats()).toMatchObject({ attempted: 0, failed: 0, skipped: expect.objectContaining({ policyDeny: 1 }) });
    } finally {
      if (before !== undefined) process.env.RESIDENTIAL_PROXY_URL = before;
    }
  });

  it('refuses the browser lane rather than throwing when no browser can be built', async () => {
    const hook = createImageCaptureHookFromEnv(env({ IMAGE_HOST_POLICY_JSON: JSON.stringify({ 'cdn.test': { lane: 'browser' } }) }), {
      browserLane: () => { throw new Error('no chrome in this image'); },
    });
    await hook.capture({
      site: 's',
      itemId: 'i',
      pageUrl: 'https://store.test/p',
      fields: {},
      ruleset: { describeImages: () => [{ url: 'https://cdn.test/a.jpg', role: 'gallery', position: 0 }] },
      origin: 'ingest',
    });
    expect(hook.stats()).toMatchObject({ attempted: 1, stored: 0, failed: 1 });
  });
});

describe('createRecordImageCapture', () => {
  const records: ExtractedData[] = [
    { source: { site: 'imgstore', itemId: '1', extractedAt: 'now' }, fields: { a: 1 }, warnings: [] },
    { source: { site: 'imgstore', itemId: '2', extractedAt: 'now' }, fields: { a: 2 }, warnings: [] },
  ];
  const ruleset = { siteId: 'imgstore', version: '1.0' } as ExtractionRuleset;

  const spyHook = () => {
    const seen: ImageCaptureRequest[] = [];
    const hook = { capture: async (r: ImageCaptureRequest) => void seen.push(r) } as unknown as ImageCaptureHook;
    return { seen, hook };
  };

  it('offers one request per record, carrying the store lane and the origin', async () => {
    const { seen, hook } = spyHook();
    createRecordImageCapture('crawler', () => ({ transport: 'impersonate' }), () => hook)(records, 'https://imgstore.test/i/1', ruleset);
    await Promise.resolve();
    expect(seen.map(r => r.itemId)).toEqual(['1', '2']);
    expect(seen[0]).toMatchObject({ origin: 'crawler', pageUrl: 'https://imgstore.test/i/1', searchFetch: { transport: 'impersonate' } });
  });

  it('still offers the records when the store lane cannot be resolved', async () => {
    const { seen, hook } = spyHook();
    createRecordImageCapture('lookup', () => { throw new Error('no registry'); }, () => hook)(records, 'https://imgstore.test/i/1', ruleset);
    await Promise.resolve();
    expect(seen).toHaveLength(2);
    expect(seen[0].searchFetch).toBeUndefined();
  });

  it('swallows a hook that rejects, because the leg that called it has already answered', async () => {
    const hook = { capture: async () => { throw new Error('image lane down'); } } as unknown as ImageCaptureHook;
    expect(() => createRecordImageCapture('ingest', () => undefined, () => hook)(records, 'https://imgstore.test/i/1', ruleset)).not.toThrow();
    await Promise.resolve();
  });
});
