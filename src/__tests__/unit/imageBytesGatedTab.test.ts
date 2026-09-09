/**
 * The GATED-TAB image BYTES lane — a tab of the per-egress gated browser navigated straight at the
 * image URL, for the cohort whose CDN is behind the same Cloudflare gate as its store. It reuses the
 * page lane's own recipe rather than restating it: `withPage({ challengeGated: true })` is what puts
 * the fetch on the long-lived browser's DEFAULT context (a created context never clears the
 * challenge), and the bytes are read with the SAME document-only main-frame guard the page lane uses
 * — the LAST main-frame document response, so a challenge or redirect that precedes the real one is
 * not what gets stored.
 *
 * The gated key is the STORE host, not the CDN's: the image rides the session the store's own
 * clearance lives in.
 */
import { createGatedTabBytesFetch } from '../../services/images/gatedTabBytesFetch';
import { ChallengeLaneUnavailableError } from '../../services/browserChallenge';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);

const MAIN_FRAME = { id: 'main' };
const OTHER_FRAME = { id: 'other' };

interface FakeRespInit {
  status?: number;
  contentType?: string;
  body?: Buffer;
  url?: string;
  resourceType?: string;
  frame?: unknown;
  bufferFails?: boolean;
}

const resp = (init: FakeRespInit = {}) => ({
  status: () => init.status ?? 200,
  url: () => init.url ?? 'https://cdn.anitoysgk.com/a.png',
  headers: (): Record<string, string> => ({ 'content-type': init.contentType ?? 'image/png', 'content-length': '12' }),
  buffer: async () => {
    if (init.bufferFails) throw new Error('Could not load body for this request');
    return init.body ?? PNG;
  },
  request: () => ({ resourceType: () => init.resourceType ?? 'document' }),
  frame: () => (init.frame === undefined ? MAIN_FRAME : init.frame),
});

/**
 * A fake page whose `goto` emits the given responses on the response listener (in order) and then
 * resolves with the last of them — the shape puppeteer produces for a navigation.
 */
const fakePage = (responses: ReturnType<typeof resp>[], gotoThrows?: Error) => {
  const handlers: ((r: unknown) => void)[] = [];
  const setExtraHTTPHeaders = jest.fn(async (_h: Record<string, string>) => undefined);
  const off = jest.fn();
  return {
    page: {
      on: (_event: string, handler: (r: unknown) => void) => { handlers.push(handler); },
      off,
      mainFrame: () => MAIN_FRAME,
      setExtraHTTPHeaders,
      goto: jest.fn(async (_url: string, _opts?: unknown) => {
        if (gotoThrows) throw gotoThrows;
        for (const r of responses) handlers.forEach(h => h(r));
        return responses.length > 0 ? responses[responses.length - 1] : null;
      }),
    },
    setExtraHTTPHeaders,
    off,
  };
};

const laneFor = (page: unknown) => {
  const withPage = jest.fn(async (fn: (p: never) => Promise<unknown>, _options?: unknown) => fn(page as never));
  return { lane: { withPage } as never, withPage };
};

describe('createGatedTabBytesFetch', () => {
  it('returns the main-document bytes, and closes over the LAST document response of the navigation', async () => {
    const challenge = resp({ status: 403, contentType: 'text/html', body: Buffer.from('<html>Just a moment</html>'), url: 'https://cdn.anitoysgk.com/a.png' });
    const served = resp({ url: 'https://cdn.anitoysgk.com/final.png' });
    const { page } = fakePage([challenge, served]);
    const { lane } = laneFor(page);

    const result = await createGatedTabBytesFetch(lane)('residential', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png', {
      proxyUrl: 'socks5://p.test:1055',
    });

    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(result.contentType).toBe('image/png');
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe('https://cdn.anitoysgk.com/final.png');
    expect(result.headers).toEqual({ 'content-type': 'image/png', 'content-length': '12' });
  });

  it('WAITS OUT a Cloudflare interstitial and returns the image the challenge cleared into', async () => {
    // The page lane's own rule: `goto` resolves on the interstitial at domcontentloaded, so leaving
    // right then both misses the image AND cancels the challenge script mid-run — the attempt still
    // spends that exit IP's Cloudflare reputation and the browser never earns the clearance.
    const challenge = resp({ status: 200, contentType: 'text/html', body: Buffer.from('<html>Just a moment...</html>') });
    const image = resp({ url: 'https://cdn.anitoysgk.com/cleared.png' });
    const handlers: ((r: unknown) => void)[] = [];
    let titleCalls = 0;
    const page = {
      on: (_event: string, handler: (r: unknown) => void) => { handlers.push(handler); },
      off: jest.fn(),
      mainFrame: () => MAIN_FRAME,
      goto: jest.fn(async () => { handlers.forEach(h => h(challenge)); return challenge; }),
      // Two polls of the interstitial, then the store's own document — with the post-challenge
      // navigation delivering the image on the same response listener.
      title: jest.fn(async () => {
        titleCalls += 1;
        if (titleCalls <= 2) return 'Just a moment...';
        handlers.forEach(h => h(image));
        return 'Lucy figure';
      }),
    };

    const result = await createGatedTabBytesFetch(laneFor(page).lane, { challenge: { pollMs: 1 } })(
      'residential', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png', { proxyUrl: 'socks5://p.test:1055' },
    );

    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(result.finalUrl).toBe('https://cdn.anitoysgk.com/cleared.png');
    expect(page.title).toHaveBeenCalled();
  });

  it('reports the interstitial as not-image when the challenge never clears, rather than hanging', async () => {
    const challenge = resp({ status: 200, contentType: 'text/html', body: Buffer.from('<html>Just a moment...</html>') });
    const handlers: ((r: unknown) => void)[] = [];
    const page = {
      on: (_event: string, handler: (r: unknown) => void) => { handlers.push(handler); },
      off: jest.fn(),
      mainFrame: () => MAIN_FRAME,
      goto: jest.fn(async () => { handlers.forEach(h => h(challenge)); return challenge; }),
      title: jest.fn(async () => 'Just a moment...'),
    };
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await createGatedTabBytesFetch(laneFor(page).lane, { challenge: { pollMs: 1, timeoutMs: 5 } })(
      'direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png',
    );

    expect(result).toMatchObject({ ok: false, reason: 'not-image', contentType: 'text/html' });
    (console.warn as jest.Mock).mockRestore();
  });

  it('ignores responses that are not the main frame\'s document (subresources, other frames)', async () => {
    const subresource = resp({ resourceType: 'image', body: Buffer.from('not the document') });
    const otherFrame = resp({ frame: OTHER_FRAME, body: Buffer.from('another frame') });
    const served = resp();
    const { page } = fakePage([subresource, otherFrame, served]);
    const { lane } = laneFor(page);

    const result = await createGatedTabBytesFetch(lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png');
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.bytes.equals(PNG)).toBe(true);
  });

  it('opens the tab on the STORE host\'s gated session, with the egress proxy, and detaches its listener', async () => {
    const { page, off } = fakePage([resp()]);
    const { lane, withPage } = laneFor(page);

    await createGatedTabBytesFetch(lane)('residential', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png', {
      proxyUrl: 'socks5://p.test:1055',
      challengeGated: true,
    });

    expect(withPage.mock.calls[0][1]).toMatchObject({
      targetUrl: 'https://anitoysgk.com/',
      challengeGated: true,
      proxyServer: 'socks5://p.test:1055',
    });
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('takes the gate from the STORE, not from the lane — an ungated store gets no challengeGated', async () => {
    // Hardcoding it pinned every browser-lane image to the gated browser, and on a headless engine
    // (the default) withPage refuses a DECLARED gate outright — so every ungated store's images came
    // back refused with a message about a gate that store never declared.
    const { page } = fakePage([resp()]);
    const { lane, withPage } = laneFor(page);

    await createGatedTabBytesFetch(lane)('direct', 'shop.example', 'https://shop.example/cdn/shop/files/x.jpg');

    expect(withPage.mock.calls[0][1]).not.toHaveProperty('challengeGated');
  });

  it('seeds the host\'s stored cookies onto the tab and hands withPage the resolved user agent', async () => {
    const { page } = fakePage([resp()]);
    const setCookie = jest.fn(async (..._cookies: unknown[]) => undefined);
    const { lane, withPage } = laneFor({ ...page, setCookie });
    const store = { cookiesFor: jest.fn(() => ({ cf_clearance: 'abc' })), userAgentFor: jest.fn(() => 'MintUA/1') };

    await createGatedTabBytesFetch(lane, { cookieStore: store })('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png');

    expect(store.cookiesFor).toHaveBeenCalledWith('https://cdn.anitoysgk.com/a.png');
    expect(setCookie).toHaveBeenCalledWith(expect.objectContaining({ name: 'cf_clearance', value: 'abc', domain: '.cdn.anitoysgk.com' }));
    expect(withPage.mock.calls[0][1]).toMatchObject({ userAgent: 'MintUA/1' });
  });

  it('sets no cookie at all for a host the store knows nothing about', async () => {
    const { page } = fakePage([resp()]);
    const setCookie = jest.fn(async (..._cookies: unknown[]) => undefined);
    const { lane } = laneFor({ ...page, setCookie });
    const store = { cookiesFor: jest.fn(() => undefined), userAgentFor: jest.fn(() => undefined) };

    await createGatedTabBytesFetch(lane, { cookieStore: store })('direct', 'shop.example', 'https://cdn.example/a.png');

    expect(setCookie).not.toHaveBeenCalled();
  });

  it('sends the image Accept and the referer as extra headers on the tab', async () => {
    const { page, setExtraHTTPHeaders } = fakePage([resp()]);
    const { lane } = laneFor(page);

    await createGatedTabBytesFetch(lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png', {
      referer: 'https://www.anitoysgk.com/p/1',
    });

    expect(setExtraHTTPHeaders).toHaveBeenCalledWith(expect.objectContaining({
      accept: expect.stringContaining('image/webp'),
      referer: 'https://www.anitoysgk.com/p/1',
    }));
  });

  it('reports a non-2xx document as http-status and a non-image document as not-image', async () => {
    const blocked = fakePage([resp({ status: 403, contentType: 'text/html', body: Buffer.from('<html>nope</html>') })]);
    expect(await createGatedTabBytesFetch(laneFor(blocked.page).lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png'))
      .toEqual({ ok: false, reason: 'http-status', status: 403 });

    const html = fakePage([resp({ contentType: 'text/html', body: Buffer.from('<html>hotlink denied</html>') })]);
    expect(await createGatedTabBytesFetch(laneFor(html.page).lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: false, reason: 'not-image', status: 200, contentType: 'text/html' });
  });

  it('carries the mitigation SIGNALS a non-2xx document sent', async () => {
    const blocked = {
      ...resp({ status: 503 }),
      headers: () => ({ 'content-type': 'text/html', 'retry-after': '30' }),
    };
    const { page } = fakePage([blocked]);
    expect(await createGatedTabBytesFetch(laneFor(page).lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png'))
      .toEqual({ ok: false, reason: 'http-status', status: 503, signals: { 'retry-after': '30' } });
  });

  it('reports a navigation that yields no document, or whose body is gone, as unsupported', async () => {
    const nothing = fakePage([]);
    expect(await createGatedTabBytesFetch(laneFor(nothing.page).lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: false, reason: 'unsupported' });

    const gone = fakePage([resp({ bufferFails: true })]);
    expect(await createGatedTabBytesFetch(laneFor(gone.page).lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('REFUSES a document over the size cap', async () => {
    const huge = { ...resp({ body: Buffer.alloc(4096, 0x41) }), headers: () => ({ 'content-type': 'image/png', 'content-length': '4096' }) };
    const { page } = fakePage([huge]);
    expect(await createGatedTabBytesFetch(laneFor(page).lane, { maxBytes: 1024 })('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/huge.png'))
      .toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('reports a navigation timeout as timeout, and rethrows a genuine browser fault', async () => {
    const timedOut = fakePage([], Object.assign(new Error('Navigation timeout of 20000 ms exceeded'), { name: 'TimeoutError' }));
    expect(await createGatedTabBytesFetch(laneFor(timedOut.page).lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: false, reason: 'timeout' });

    const crashed = fakePage([], new Error('Target closed'));
    await expect(createGatedTabBytesFetch(laneFor(crashed.page).lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png'))
      .rejects.toThrow(/Target closed/);
  });

  it('REFUSES residential egress with no proxy configured — never falling back to the node IP', async () => {
    const { page } = fakePage([resp()]);
    const { lane, withPage } = laneFor(page);

    const result = await createGatedTabBytesFetch(lane, { proxyUrlFor: () => undefined })(
      'residential', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png',
    );

    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect((result as { detail?: string }).detail).toMatch(/RESIDENTIAL_PROXY_URL/);
    expect(withPage).not.toHaveBeenCalled();
  });

  it('resolves the residential proxy from the engine when the caller names none', async () => {
    const { page } = fakePage([resp()]);
    const { lane, withPage } = laneFor(page);

    await createGatedTabBytesFetch(lane, { proxyUrlFor: () => 'socks5://engine.test:1055' })(
      'residential', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png',
    );

    expect(withPage.mock.calls[0][1]).toMatchObject({ proxyServer: 'socks5://engine.test:1055' });
  });

  it('REFUSES bytes that came from a DENIED host after a redirect', async () => {
    const { page } = fakePage([resp({ url: 'https://cdn.otakumode.com/i/1.png' })]);
    expect(await createGatedTabBytesFetch(laneFor(page).lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: false, reason: 'refused' });
  });

  it('falls back to the served response body when the event-time buffer could not be read', async () => {
    let attempt = 0;
    const flaky = {
      ...resp(),
      buffer: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('body not yet available');
        return PNG;
      },
    };
    const { page } = fakePage([flaky]);
    const result = await createGatedTabBytesFetch(laneFor(page).lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png');
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.bytes.equals(PNG)).toBe(true);
  });

  it('drives a page that cannot set extra headers, and refuses residential egress the engine has no proxy for', async () => {
    const { page } = fakePage([resp()]);
    const bare = { ...page, setExtraHTTPHeaders: undefined };
    expect(await createGatedTabBytesFetch(laneFor(bare).lane)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: true });

    // No proxyUrlFor injected: the engine's own RESIDENTIAL_PROXY_URL is unset under test.
    expect(await createGatedTabBytesFetch(laneFor(page).lane)('residential', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: false, reason: 'refused' });
  });

  it('reports a refused challenge lane (no clean-headful profile) as refused, not as a throw', async () => {
    const withPage = jest.fn(async () => { throw new ChallengeLaneUnavailableError('https://cdn.anitoysgk.com/a.png'); });
    const result = await createGatedTabBytesFetch({ withPage } as never)('direct', 'anitoysgk.com', 'https://cdn.anitoysgk.com/a.png');
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect((result as { detail?: string }).detail).toMatch(/clean-headful/);
  });
});
