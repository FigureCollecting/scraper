/**
 * The impit image BYTES lane — the sibling of the string `impersonate` transport, and the ONLY
 * non-browser lane that can carry a residential image (impit takes the proxy natively; Node's fetch
 * cannot). The rule this file exists to pin: impit's response is read through a BINARY capability
 * (`bytes()` / `arrayBuffer()`), feature-detected per response, and a build that exposes only
 * `text()` returns a typed 'unsupported' — an image decoded through a utf-8 string is destroyed, and
 * a silently corrupted JPEG is far worse than a refusal.
 */
import { createImpitBytesFetch, createImpitSessionProvider } from '../../services/images/impitBytesFetch';
import { ARCHIVAL_IMAGE_ACCEPT } from '../../services/images/imageBytes';
import type { CookieJarLike, ImpitLike } from '../../services/impitFetch';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

interface FakeResponseInit {
  status?: number;
  contentType?: string;
  body?: Buffer;
  /** Which binary capability the fake exposes: both, arrayBuffer only, or none (text-only). */
  capability?: 'bytes' | 'arrayBuffer' | 'none';
  url?: string;
}

const text = jest.fn(async () => 'never read for an image');

const impitResponse = (init: FakeResponseInit = {}) => {
  const body = init.body ?? PNG;
  const base = {
    status: init.status ?? 200,
    url: init.url,
    headers: { 'content-type': init.contentType ?? 'image/png', 'content-length': String(body.length), 'set-cookie': 'session=1' },
    text,
  };
  if (init.capability === 'none') return base;
  if (init.capability === 'arrayBuffer') {
    return { ...base, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  }
  return { ...base, bytes: async () => new Uint8Array(body) };
};

/** A fake Impit and its jar, recording what it was asked for and what was seeded into it. */
const fakeImpit = (respond: (url: string) => unknown) => {
  const fetch = jest.fn(async (url: string, _init: { method: string; headers?: Record<string, string> }) => respond(url) as never);
  const seeded: string[] = [];
  const jar = { setCookie: jest.fn(async (cookie: string, _url: string) => { seeded.push(cookie); }) } as unknown as CookieJarLike;
  return { impit: { fetch } as unknown as ImpitLike, fetch, jar, seeded };
};

describe('createImpitBytesFetch', () => {
  it('returns the bytes read through impit\'s binary capability, never through text()', async () => {
    const { impit, fetch } = fakeImpit(() => impitResponse());
    const getImpit = jest.fn(async () => impit);
    const result = await createImpitBytesFetch({ getImpit })('https://cdn.anitoysgk.com/a.png');

    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(result.contentType).toBe('image/png');
    expect(result.status).toBe(200);
    // The subset is provenance only: the response's set-cookie never rides along.
    expect(result.headers).toEqual({ 'content-type': 'image/png', 'content-length': '12' });
    expect(text).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1].method).toBe('GET');
  });

  it('falls back to arrayBuffer() when the impit build exposes no bytes()', async () => {
    const { impit } = fakeImpit(() => impitResponse({ capability: 'arrayBuffer' }));
    const result = await createImpitBytesFetch({ getImpit: async () => impit })('https://cdn.anitoysgk.com/a.png');
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(text).not.toHaveBeenCalled();
  });

  it('returns unsupported — and never decodes as utf-8 — when impit exposes only text()', async () => {
    const { impit } = fakeImpit(() => impitResponse({ capability: 'none' }));
    const result = await createImpitBytesFetch({ getImpit: async () => impit })('https://cdn.anitoysgk.com/a.png');
    expect(result).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(text).not.toHaveBeenCalled();
  });

  it('sends the ARCHIVAL Accept, the chrome UA profile, and a referer when asked', async () => {
    const { impit, fetch } = fakeImpit(() => impitResponse());
    const fetchBytes = createImpitBytesFetch({ getImpit: async () => impit });

    await fetchBytes('https://cdn.anitoysgk.com/a.png', { referer: 'https://www.anitoysgk.com/p/1', userAgent: 'UA/2' });

    const headers = fetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.accept).toBe(ARCHIVAL_IMAGE_ACCEPT);
    expect(headers.accept).toBe('*/*');
    expect(headers.referer).toBe('https://www.anitoysgk.com/p/1');
    expect(headers['user-agent']).toBe('UA/2');
  });

  it('takes the operator\'s IMAGE_ACCEPT, and a per-request Accept beats even that', async () => {
    const previous = process.env.IMAGE_ACCEPT;
    try {
      process.env.IMAGE_ACCEPT = 'image/jpeg';
      const { impit, fetch } = fakeImpit(() => impitResponse());
      const fetchBytes = createImpitBytesFetch({ getImpit: async () => impit });

      await fetchBytes('https://cdn.anitoysgk.com/a.png');
      expect((fetch.mock.calls[0][1].headers as Record<string, string>).accept).toBe('image/jpeg');

      await fetchBytes('https://cdn.anitoysgk.com/a.png', { accept: 'image/png' });
      expect((fetch.mock.calls[1][1].headers as Record<string, string>).accept).toBe('image/png');
    } finally {
      if (previous === undefined) delete process.env.IMAGE_ACCEPT;
      else process.env.IMAGE_ACCEPT = previous;
    }
  });

  it('asks for the chrome impersonation profile, and a SEPARATE session per residential proxy', async () => {
    const { impit } = fakeImpit(() => impitResponse());
    const getImpit = jest.fn(async () => impit);
    const fetchBytes = createImpitBytesFetch({ getImpit });

    await fetchBytes('https://cdn.anitoysgk.com/a.png');
    await fetchBytes('https://cdn.anitoysgk.com/a.png', { proxyUrl: 'socks5://p.test:1055' });

    expect(getImpit).toHaveBeenNthCalledWith(1, expect.stringMatching(/^chrome/), undefined);
    expect(getImpit).toHaveBeenNthCalledWith(2, expect.stringMatching(/^chrome/), 'socks5://p.test:1055');
  });

  it('REFUSES residential egress with no proxy — never falling back to the node IP', async () => {
    const { impit, fetch } = fakeImpit(() => impitResponse());
    const result = await createImpitBytesFetch({ getImpit: async () => impit })('https://cdn.anitoysgk.com/a.png', { egress: 'residential' });
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect((result as { detail?: string }).detail).toMatch(/RESIDENTIAL_PROXY_URL/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('SEEDS the stored cf cookies into the session jar and lets the pinned mint UA win', async () => {
    const { impit, fetch, jar, seeded } = fakeImpit(() => impitResponse());
    const store = {
      cookiesFor: jest.fn(() => ({ cf_clearance: 'abc', tfaTrust: 'xyz' })),
      userAgentFor: jest.fn(() => 'MintUA/1'),
    };
    const fetchBytes = createImpitBytesFetch({ getImpit: async () => ({ impit, jar }), cookieStore: store });

    await fetchBytes('https://cdn.anitoysgk.com/a.png', { userAgent: 'CallerUA/9' });

    expect(store.cookiesFor).toHaveBeenCalledWith('https://cdn.anitoysgk.com/a.png');
    expect(seeded.join(' ')).toContain('cf_clearance=abc');
    expect(seeded.join(' ')).toContain('tfaTrust=xyz');
    // cf_clearance is bound to IP + UA, so the mint UA must beat whatever the caller asked for.
    expect((fetch.mock.calls[0][1].headers as Record<string, string>)['user-agent']).toBe('MintUA/1');
  });

  it('seeds nothing and pins no UA for a host the cookie store knows nothing about', async () => {
    const { impit, fetch, jar, seeded } = fakeImpit(() => impitResponse());
    const store = { cookiesFor: jest.fn(() => undefined), userAgentFor: jest.fn(() => undefined) };
    await createImpitBytesFetch({ getImpit: async () => ({ impit, jar }), cookieStore: store })('https://cdn.example.com/a.png', { userAgent: 'CallerUA/9' });
    expect(seeded).toEqual([]);
    expect((fetch.mock.calls[0][1].headers as Record<string, string>)['user-agent']).toBe('CallerUA/9');
  });

  it('bounds the call with the per-request timeoutMs rather than the session-wide budget', async () => {
    const stalled = { fetch: jest.fn(() => new Promise(() => undefined)) } as unknown as ImpitLike;
    const result = await createImpitBytesFetch({ getImpit: async () => stalled })('https://cdn.anitoysgk.com/a.png', { timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('reports a non-2xx as http-status and a non-image body as not-image', async () => {
    const { impit: blocked } = fakeImpit(() => impitResponse({ status: 403 }));
    expect(await createImpitBytesFetch({ getImpit: async () => blocked })('https://cdn.anitoysgk.com/a.png'))
      .toEqual({ ok: false, reason: 'http-status', status: 403 });

    const { impit: challenged } = fakeImpit(() => impitResponse({ contentType: 'text/html', body: Buffer.from('<html>Just a moment</html>') }));
    expect(await createImpitBytesFetch({ getImpit: async () => challenged })('https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: false, reason: 'not-image', contentType: 'text/html' });
  });

  it('carries the mitigation SIGNALS a non-2xx impit response sent', async () => {
    const blocked = {
      status: 403,
      headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
      text,
      bytes: async () => new Uint8Array(),
    };
    const { impit } = fakeImpit(() => blocked);
    expect(await createImpitBytesFetch({ getImpit: async () => impit })('https://cdn.anitoysgk.com/a.png'))
      .toEqual({ ok: false, reason: 'http-status', status: 403, signals: { 'cf-mitigated': 'challenge' } });
  });

  it('REFUSES a body over the size cap, on the declared length and on the bytes read', async () => {
    const declared = {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '999999' },
      text,
      bytes: jest.fn(async () => new Uint8Array(PNG)),
    };
    const { impit: big } = fakeImpit(() => declared);
    expect(await createImpitBytesFetch({ getImpit: async () => big, maxBytes: 1024 })('https://cdn.anitoysgk.com/huge.png'))
      .toMatchObject({ ok: false, reason: 'too-large' });
    expect(declared.bytes).not.toHaveBeenCalled();

    const { impit: undeclared } = fakeImpit(() => impitResponse({ body: Buffer.alloc(4096, 0x41), contentType: 'image/png' }));
    expect(await createImpitBytesFetch({ getImpit: async () => undeclared, maxBytes: 1024 })('https://cdn.anitoysgk.com/huge.png'))
      .toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('reports an impit timeout as timeout, and rethrows a genuine fault', async () => {
    const timedOut = { fetch: async () => { throw new Error('operation timed out'); } } as unknown as ImpitLike;
    expect(await createImpitBytesFetch({ getImpit: async () => timedOut })('https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: false, reason: 'timeout' });

    const faulted = { fetch: async () => { throw new Error('tls handshake failed'); } } as unknown as ImpitLike;
    await expect(createImpitBytesFetch({ getImpit: async () => faulted })('https://cdn.anitoysgk.com/a.png'))
      .rejects.toThrow(/handshake/);
  });

  it('carries the final URL impit reports, and falls back to the requested one', async () => {
    const { impit: redirected } = fakeImpit(() => impitResponse({ url: 'https://cdn.anitoysgk.com/final.png' }));
    expect(await createImpitBytesFetch({ getImpit: async () => redirected })('https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: true, finalUrl: 'https://cdn.anitoysgk.com/final.png' });

    const { impit: plain } = fakeImpit(() => impitResponse());
    expect(await createImpitBytesFetch({ getImpit: async () => plain })('https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: true, finalUrl: 'https://cdn.anitoysgk.com/a.png' });
  });

  it('REFUSES bytes that came from a DENIED host after a redirect', async () => {
    const { impit } = fakeImpit(() => impitResponse({ url: 'https://cdn.otakumode.com/i/1.png' }));
    expect(await createImpitBytesFetch({ getImpit: async () => impit })('https://cdn.anitoysgk.com/a.png'))
      .toMatchObject({ ok: false, reason: 'refused' });
  });

  it('carries the referer only when asked, and no user-agent header when none is given', async () => {
    const { impit, fetch } = fakeImpit(() => impitResponse());
    await createImpitBytesFetch({ getImpit: async () => impit })('https://cdn.anitoysgk.com/a.png');
    const headers = fetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.referer).toBeUndefined();
    expect(headers['user-agent']).toBeUndefined();
  });

  it('accepts a bare impit response that reports no status, headers or url (sniffing the body)', async () => {
    const bare = { bytes: async () => new Uint8Array(PNG), text } as unknown;
    const { impit } = fakeImpit(() => bare);
    const result = await createImpitBytesFetch({ getImpit: async () => impit })('https://cdn.anitoysgk.com/a.png');
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      contentType: 'image/png',
      headers: {},
      finalUrl: 'https://cdn.anitoysgk.com/a.png',
    });
  });

  it('reports a bare non-image response as not-image with no status to report', async () => {
    const bare = { bytes: async () => new Uint8Array(Buffer.from('<html>blocked</html>')), text } as unknown;
    const { impit } = fakeImpit(() => bare);
    expect(await createImpitBytesFetch({ getImpit: async () => impit })('https://cdn.anitoysgk.com/a.png'))
      // The body still crossed the wire, so it is reported for the residential byte budget even
      // though nothing else about this response is known.
      .toEqual({ ok: false, reason: 'not-image', bytesRead: 20 });
  });

  it('reads a Headers-like response header bag as well as a plain object', async () => {
    const bag = new Map([['content-type', 'image/webp'], ['etag', '"v1"']]);
    const withGetter = {
      status: 200,
      headers: { get: (name: string) => bag.get(name.toLowerCase()) ?? null },
      bytes: async () => new Uint8Array(PNG),
      text,
    };
    const { impit } = fakeImpit(() => withGetter);
    const result = await createImpitBytesFetch({ getImpit: async () => impit })('https://cdn.anitoysgk.com/a.webp');
    expect(result).toMatchObject({ ok: true, contentType: 'image/webp', headers: { 'content-type': 'image/webp', etag: '"v1"' } });
  });
});

describe('createImpitSessionProvider (the default session cache)', () => {
  const impitFor = (label: string) => ({ fetch: async () => ({ text: async () => label }) }) as unknown as ImpitLike;

  it('builds ONE Impit per (profile, proxy) and reuses it — a proxied session never shares the direct jar', async () => {
    const makeImpit = jest.fn((browser: string, _jar: unknown, _timeoutMs: number, proxyUrl?: string) => impitFor(`${browser}|${proxyUrl ?? 'direct'}`));
    const provider = createImpitSessionProvider(makeImpit as never);

    const a = await provider('chrome142', undefined);
    const b = await provider('chrome142', undefined);
    const proxied = await provider('chrome142', 'socks5://p.test:1055');

    expect(a.impit).toBe(b.impit);
    expect(a.jar).toBe(b.jar);
    expect(proxied.impit).not.toBe(a.impit);
    expect(makeImpit).toHaveBeenCalledTimes(2);
    expect(makeImpit.mock.calls[1][3]).toBe('socks5://p.test:1055');
  });

  it('keys the cache on an UNAMBIGUOUS (profile, proxy) pair, as the string lane does', async () => {
    const makeImpit = jest.fn((browser: string, _jar: unknown, _timeoutMs: number, proxyUrl?: string) => impitFor(`${browser}|${proxyUrl ?? 'direct'}`));
    const provider = createImpitSessionProvider(makeImpit as never);
    // A space separator would collapse these two onto ONE session — one jar across two egresses.
    const a = await provider('chrome142 socks5://p.test:1055', undefined);
    const b = await provider('chrome142', 'socks5://p.test:1055');
    expect(a.impit).not.toBe(b.impit);
  });

  it('evicts a failed build so the next call retries instead of caching the failure', async () => {
    let attempt = 0;
    const makeImpit = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('impit binary missing');
      return impitFor('second');
    });
    const provider = createImpitSessionProvider(makeImpit as never);

    await expect(provider('chrome142', undefined)).rejects.toThrow(/impit binary missing/);
    await expect(provider('chrome142', undefined)).resolves.toBeDefined();
    expect(makeImpit).toHaveBeenCalledTimes(2);
  });
});
