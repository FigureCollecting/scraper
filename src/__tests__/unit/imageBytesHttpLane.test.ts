/**
 * The plain-HTTP image BYTES lane — the sibling of the string `http` transport, for the one thing
 * the string lanes cannot carry: an image body. Two rules are pinned here:
 *   - every EXPECTED outcome is a typed result, never a throw (a 404, a non-image body, a timeout),
 *     because the caller's decision differs per outcome and an exception erases the difference;
 *   - the lane REFUSES residential egress exactly as `refuseHttpLaneResidentialEgress` does for the
 *     string lane — Node's global fetch cannot proxy, so a residential image must ride impit or the
 *     gated tab. It is refused BEFORE the network, never fetched from the node IP.
 */
import { ARCHIVAL_IMAGE_ACCEPT, createHttpBytesFetch } from '../../services/images/httpBytesFetch';
import {
  IMAGE_CHROME_UA,
  classifyImageBytes,
  isPlainHeaderValue,
  resolveImageAccept,
  resolveImageUserAgent,
} from '../../services/images/imageBytes';
import { DEFAULT_PROFILE } from '../../services/impitFetch';
import { buildImageHostPolicy, chooseImageLane, type ImageHostRule } from '../../services/images/imageHostPolicy';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

type FakeInit = { headers: Record<string, string>; signal?: AbortSignal };

interface FakeResponseInit {
  status?: number;
  contentType?: string | null;
  body?: Buffer;
  url?: string;
  headers?: Record<string, string>;
}

const response = (init: FakeResponseInit = {}) => {
  const headers: Record<string, string> = {
    ...(init.contentType === null ? {} : { 'content-type': init.contentType ?? 'image/png' }),
    ...(init.headers ?? {}),
  };
  return {
    status: init.status ?? 200,
    url: init.url ?? 'https://cdn.example.com/a.png',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => {
      const b = init.body ?? PNG;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
};

describe('createHttpBytesFetch', () => {
  it('returns the body bytes, the served content type, status and final URL', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response({ url: 'https://cdn.example.com/final.png' }));
    const fetchBytes = createHttpBytesFetch({ fetchImpl: fetchImpl as never });

    const result = await fetchBytes('https://cdn.example.com/a.png');

    expect(result).toMatchObject({
      ok: true,
      contentType: 'image/png',
      status: 200,
      finalUrl: 'https://cdn.example.com/final.png',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.bytes.equals(PNG)).toBe(true);
  });

  it('sends the ARCHIVAL Accept, NO user agent of its own, and the referer ONLY when one is given', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response());
    const fetchBytes = createHttpBytesFetch({ fetchImpl: fetchImpl as never });

    await fetchBytes('https://cdn.example.com/a.png');
    // The point of the whole header: NO preference is expressed, so a Polish/Shopify/BigCommerce
    // host has nothing to negotiate on and serves the format it actually stores.
    expect(fetchImpl.mock.calls[0][1].headers.accept).toBe('*/*');
    // The UA is the CALLER's to choose. This lane inventing a Chrome string when none was given is
    // what made the policy table's ua:'default' unreachable; unset, undici sends its own `node`,
    // which is the identity the connection's TLS fingerprint actually belongs to.
    expect(fetchImpl.mock.calls[0][1].headers['user-agent']).toBeUndefined();
    expect(fetchImpl.mock.calls[0][1].headers.referer).toBeUndefined();

    await fetchBytes('https://cdn.example.com/a.png', { referer: 'https://store.example/p/1', userAgent: 'UA/1' });
    expect(fetchImpl.mock.calls[1][1].headers.referer).toBe('https://store.example/p/1');
    expect(fetchImpl.mock.calls[1][1].headers['user-agent']).toBe('UA/1');
  });

  it('takes the operator\'s IMAGE_ACCEPT over the archival default, and ignores an unusable one', async () => {
    const previous = process.env.IMAGE_ACCEPT;
    try {
      process.env.IMAGE_ACCEPT = 'image/tiff, image/*;q=0.5';
      const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response());
      await createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/a.png');
      expect(fetchImpl.mock.calls[0][1].headers.accept).toBe('image/tiff, image/*;q=0.5');

      // A value that would SPLIT the header is not an override; the archival default stands and the
      // refusal is named once rather than sent.
      process.env.IMAGE_ACCEPT = 'image/png\r\nX-Injected: 1';
      const warn = jest.fn();
      const second = jest.fn(async (_url: string, _init: FakeInit) => response());
      await createHttpBytesFetch({ fetchImpl: second as never, warn })('https://cdn.example.com/a.png');
      expect(second.mock.calls[0][1].headers.accept).toBe(ARCHIVAL_IMAGE_ACCEPT);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('IMAGE_ACCEPT'));
    } finally {
      if (previous === undefined) delete process.env.IMAGE_ACCEPT;
      else process.env.IMAGE_ACCEPT = previous;
    }
  });

  it('lets a per-request Accept (the policy table\'s per-host row) beat the lane default', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response());
    await createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/a.png', {
      accept: 'image/png',
    });
    expect(fetchImpl.mock.calls[0][1].headers.accept).toBe('image/png');
  });

  it('sends a UA that tracks the engine\'s impersonation profile, not a frozen old Chrome', async () => {
    const major = /(\d+)/.exec(DEFAULT_PROFILE)?.[1];
    expect(IMAGE_CHROME_UA).toContain(`Chrome/${major}.`);
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response());
    // Driven through the policy token rather than the lane default: a Chrome UA now reaches the wire
    // because a host was CONFIGURED for one (ua:'chrome'), never because the lane assumed it.
    await createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/a.png', {
      userAgent: resolveImageUserAgent('chrome'),
    });
    expect(fetchImpl.mock.calls[0][1].headers['user-agent']).toBe(IMAGE_CHROME_UA);
  });

  it('clamps an absurd per-request budget instead of aborting instantly', async () => {
    // timeoutMs: 0 became AbortSignal.timeout(0), which fires on the next tick — every real fetch
    // would report as a timeout.
    let signal: AbortSignal | undefined;
    const fetchImpl = jest.fn(async (_url: string, init: FakeInit) => {
      signal = init.signal;
      await new Promise(resolve => setTimeout(resolve, 10));
      return response();
    });
    expect(await createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/a.png', { timeoutMs: 0 }))
      .toMatchObject({ ok: true });
    expect(signal?.aborted).toBe(false);
  });

  it('carries a header subset (content-length, etag, last-modified) for provenance', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response({
      headers: { 'content-length': '12', etag: 'W/"abc"', 'last-modified': 'Mon, 08 Sep 2026 00:00:00 GMT', 'set-cookie': 'nope=1' },
    }));
    const result = await createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/a.png');

    if (!result.ok) throw new Error('expected ok');
    expect(result.headers).toEqual({
      'content-type': 'image/png',
      'content-length': '12',
      etag: 'W/"abc"',
      'last-modified': 'Mon, 08 Sep 2026 00:00:00 GMT',
    });
  });

  it('reports a non-2xx as http-status, carrying the status, without reading a body', async () => {
    const res = response({ status: 404 });
    const arrayBuffer = jest.fn(res.arrayBuffer);
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => ({ ...res, arrayBuffer }));
    const result = await createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/missing.png');
    expect(result).toEqual({ ok: false, reason: 'http-status', status: 404 });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('carries the Cloudflare mitigation / retry-after SIGNALS a non-2xx response sent', async () => {
    const withSignal = jest.fn(async (_url: string, _init: FakeInit) => response({ status: 403, headers: { 'cf-mitigated': 'challenge', 'retry-after': '120' } }));
    expect(await createHttpBytesFetch({ fetchImpl: withSignal as never })('https://cdn.example.com/a.png'))
      .toEqual({ ok: false, reason: 'http-status', status: 403, signals: { 'cf-mitigated': 'challenge', 'retry-after': '120' } });

    // A bare 403 carries none — the pacing wrapper reads that as a per-URL verdict, not a throttle.
    const bare = jest.fn(async (_url: string, _init: FakeInit) => response({ status: 403 }));
    expect(await createHttpBytesFetch({ fetchImpl: bare as never })('https://cdn.example.com/a.png'))
      .toEqual({ ok: false, reason: 'http-status', status: 403 });
  });

  it('reports an HTML body served at an image URL as not-image (a hotlink block page is not an image)', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response({ contentType: 'text/html; charset=utf-8', body: Buffer.from('<html>denied</html>') }));
    const result = await createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/a.png');
    expect(result).toMatchObject({ ok: false, reason: 'not-image', status: 200, contentType: 'text/html; charset=utf-8' });
  });

  it('REFUSES a body over the size cap — by content-length before the read, and by length after it', async () => {
    const declared = jest.fn(async (_url: string, _init: FakeInit) => response({ headers: { 'content-length': '999999' } }));
    const result = await createHttpBytesFetch({ fetchImpl: declared as never, maxBytes: 1024 })('https://cdn.example.com/huge.png');
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });

    // A CDN that streams without declaring a length is caught on the bytes it actually produced.
    const undeclared = jest.fn(async (_url: string, _init: FakeInit) => response({ body: Buffer.alloc(4096, 0x41), contentType: 'image/png' }));
    expect(await createHttpBytesFetch({ fetchImpl: undeclared as never, maxBytes: 1024 })('https://cdn.example.com/huge.png'))
      .toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('does not read a body whose declared length is over the cap', async () => {
    const arrayBuffer = jest.fn(async () => new ArrayBuffer(8));
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => ({ ...response({ headers: { 'content-length': '999999' } }), arrayBuffer }));
    await createHttpBytesFetch({ fetchImpl: fetchImpl as never, maxBytes: 1024 })('https://cdn.example.com/huge.png');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('reports an aborted/timed-out fetch as timeout rather than throwing', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => { throw timeout; });
    const result = await createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/a.png');
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('rethrows a genuine transport fault (DNS/connection) — it is not an expected outcome', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => { throw new Error('getaddrinfo ENOTFOUND cdn.example.com'); });
    await expect(createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/a.png'))
      .rejects.toThrow(/ENOTFOUND/);
  });

  it('REFUSES residential egress before the network — the plain lane cannot proxy', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response());
    const result = await createHttpBytesFetch({ fetchImpl: fetchImpl as never })(
      'https://cdn.example.com/a.png',
      { proxyUrl: 'socks5://egress-proxy.fc.svc.cluster.local:1055' },
    );
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect((result as { detail?: string }).detail).toMatch(/SOCKS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('REFUSES a fetch declared residential even when no proxy URL was handed down', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response());
    const result = await createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/a.png', { egress: 'residential' });
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a body that aborts mid-read as timeout, and rethrows a fault mid-read', async () => {
    const res = response();
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const timedOut = jest.fn(async (_url: string, _init: FakeInit) => ({ ...res, arrayBuffer: async () => { throw aborted; } }));
    expect(await createHttpBytesFetch({ fetchImpl: timedOut as never })('https://cdn.example.com/a.png'))
      .toMatchObject({ ok: false, reason: 'timeout' });

    const faulted = jest.fn(async (_url: string, _init: FakeInit) => ({ ...res, arrayBuffer: async () => { throw new Error('ECONNRESET'); } }));
    await expect(createHttpBytesFetch({ fetchImpl: faulted as never })('https://cdn.example.com/a.png'))
      .rejects.toThrow(/ECONNRESET/);
  });

  it('REFUSES bytes that came from a DENIED host after a redirect', async () => {
    const redirected = jest.fn(async (_url: string, _init: FakeInit) => response({ url: 'https://cdn.otakumode.com/i/1.png' }));
    const result = await createHttpBytesFetch({ fetchImpl: redirected as never })('https://cdn.example.com/a.png');
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect((result as { detail?: string }).detail).toMatch(/deny list/);
  });

  it('honours the caller\'s finalUrl guard — a redirect off the declaring store is refused', async () => {
    const redirected = jest.fn(async (_url: string, _init: FakeInit) => response({ url: 'https://tracker.example/i.png' }));
    const result = await createHttpBytesFetch({ fetchImpl: redirected as never })('https://cdn.example.com/a.png', {
      allowFinalUrl: (finalUrl: string) => finalUrl.startsWith('https://cdn.example.com/'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
  });

  it('falls back to the requested URL when the response reports none', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => ({ ...response(), url: '' }));
    const result = await createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/a.png');
    expect(result).toMatchObject({ ok: true, finalUrl: 'https://cdn.example.com/a.png' });
  });

  it('bounds the request with an abort signal', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response());
    await createHttpBytesFetch({ fetchImpl: fetchImpl as never, timeoutMs: 1234 })('https://cdn.example.com/a.png');
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('resolveImageUserAgent', () => {
  it('maps the policy table\'s ua token to a real user agent', () => {
    expect(resolveImageUserAgent('chrome')).toBe(IMAGE_CHROME_UA);
    // 'default' is a refusal to claim a browser, so it resolves to nothing to override with — and
    // the lanes are then obliged to send the transport's own identity rather than one of their own.
    expect(resolveImageUserAgent('default')).toBeUndefined();
    expect(resolveImageUserAgent(undefined)).toBeUndefined();
  });
});

/**
 * The POLICY-to-WIRE seam — where the 2026-09-09 hobby-genki defect actually lived. Neither side was
 * wrong on its own: `chooseImageLane` resolved the operator's ua:'default', `resolveImageUserAgent`
 * turned that into `undefined` meaning "override nothing", and the LANE then read that `undefined` as
 * "so send Chrome". An operator row written precisely to keep a browser identity OFF the wire put one
 * there, and every hobby-genki image 403'd (28 ledger rows).
 *
 * hobby-genki.com has an INVERTED UA gate. Measured 2026-09-09 from the home line against
 * https://hobby-genki.com/101923-large_default/julia-original-character-by-gogoko-16-scale-figure.jpg:
 *   no user-agent header  -> 200, image/jpeg, 27 653 bytes
 *   Chrome/152            -> 403, text/html, 5 972 bytes, cf-mitigated: challenge
 *   Chrome/127            -> 403, text/html, 5 972 bytes, cf-mitigated: challenge
 * The second Chrome is the engine's OWN page-lane UA, so "reuse the page lane's default" is not a fix
 * either: what the gate refuses is a browser CLAIM over a non-browser TLS fingerprint. 'default' has
 * to reach the wire as something that is not a browser.
 */
describe('the image host policy ua token, on the wire', () => {
  /** The caller's own composition (imageCaptureHook), so this covers the SEAM, not one side of it. */
  const sendViaPolicy = async (pageUrl: string, imageUrl: string, rule: ImageHostRule, host: string) => {
    const decision = chooseImageLane(pageUrl, imageUrl, { transport: 'browser' }, buildImageHostPolicy({ [host]: rule }));
    if (!decision.ok) throw new Error(`the lane was refused: ${decision.reason}`);
    const userAgent = resolveImageUserAgent(decision.ua);
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response());
    await createHttpBytesFetch({ fetchImpl: fetchImpl as never })(imageUrl, {
      ...(userAgent !== undefined ? { userAgent } : {}),
    });
    return fetchImpl.mock.calls[0][1].headers;
  };

  it('sends NO browser identity for ua:default — hobby-genki 403s a Chrome UA and 200s without one', async () => {
    const headers = await sendViaPolicy(
      'https://hobby-genki.com/en/101923-julia.html',
      'https://hobby-genki.com/101923-large_default/julia.jpg',
      { lane: 'http', egress: 'direct', referer: false, ua: 'default' },
      'hobby-genki.com',
    );
    // Asserted on the identity that REACHES the CDN, not on the header's presence: an absent header
    // is undici's own `node`, which is equally a non-browser default and equally passes the gate.
    const onTheWire = headers['user-agent'] ?? 'node';
    expect(onTheWire).not.toBe(IMAGE_CHROME_UA);
    expect(onTheWire).not.toMatch(/Mozilla|Chrome/);
  });

  it('still sends IMAGE_CHROME_UA for ua:chrome — the hpoi row that was PROVEN to need it', async () => {
    const headers = await sendViaPolicy(
      'https://www.hpoi.net/hobby/101923',
      'https://rfx.hpoi.net/hobby/101923/cover.jpg',
      { lane: 'http', egress: 'direct', referer: true, ua: 'chrome' },
      'rfx.hpoi.net',
    );
    expect(headers['user-agent']).toBe(IMAGE_CHROME_UA);
  });
});

describe('classifyImageBytes', () => {
  it('accepts any image/* content type verbatim', () => {
    expect(classifyImageBytes('image/webp', PNG)).toEqual({ image: true, contentType: 'image/webp' });
    expect(classifyImageBytes('IMAGE/JPEG; charset=binary', PNG)).toEqual({ image: true, contentType: 'IMAGE/JPEG; charset=binary' });
  });

  it('sniffs the magic bytes when the server sent no type or a generic octet-stream', () => {
    expect(classifyImageBytes(undefined, PNG)).toEqual({ image: true, contentType: 'image/png' });
    expect(classifyImageBytes('application/octet-stream', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ image: true, contentType: 'image/jpeg' });
    expect(classifyImageBytes('binary/octet-stream', Buffer.from('GIF89a'))).toEqual({ image: true, contentType: 'image/gif' });
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
    expect(classifyImageBytes('', webp)).toEqual({ image: true, contentType: 'image/webp' });
    const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypavif')]);
    expect(classifyImageBytes(null, avif)).toEqual({ image: true, contentType: 'image/avif' });
    expect(classifyImageBytes(undefined, Buffer.from('BM\u0000\u0000'))).toEqual({ image: true, contentType: 'image/bmp' });
  });

  it('REFUSES image/svg+xml — an image content type whose body is active content', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(classifyImageBytes('image/svg+xml', svg).image).toBe(false);
    expect(classifyImageBytes('image/svg+xml; charset=utf-8', svg).image).toBe(false);
    expect(classifyImageBytes('image/svg', svg).image).toBe(false);
  });

  it('rejects a non-image type, and an untyped body whose bytes are not an image', () => {
    expect(classifyImageBytes('text/html', PNG).image).toBe(false);
    expect(classifyImageBytes('application/json', PNG).image).toBe(false);
    expect(classifyImageBytes(undefined, Buffer.from('<html>')).image).toBe(false);
    expect(classifyImageBytes('application/octet-stream', Buffer.alloc(2)).image).toBe(false);
  });
});

describe('resolveImageAccept', () => {
  const withEnv = <T>(value: string | undefined, run: () => T): T => {
    const previous = process.env.IMAGE_ACCEPT;
    if (value === undefined) delete process.env.IMAGE_ACCEPT;
    else process.env.IMAGE_ACCEPT = value;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.IMAGE_ACCEPT;
      else process.env.IMAGE_ACCEPT = previous;
    }
  };

  it('is the archival header when the operator set nothing, or set only whitespace', () => {
    expect(withEnv(undefined, () => resolveImageAccept())).toBe(ARCHIVAL_IMAGE_ACCEPT);
    expect(withEnv('   ', () => resolveImageAccept())).toBe(ARCHIVAL_IMAGE_ACCEPT);
    // Pinned to the exact string, because the VALUE is the behavior. Anything that names a media
    // range — `image/*` included — can be read as a preference by a strict q-value negotiator and
    // answered with a re-encode; `*/*` has nothing in it to prefer.
    expect(ARCHIVAL_IMAGE_ACCEPT).toBe('*/*');
  });

  it('names an unusable value through the console when no warn sink was injected', () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(withEnv('image/png\nX: 1', () => resolveImageAccept())).toBe(ARCHIVAL_IMAGE_ACCEPT);
      expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('IMAGE_ACCEPT'));
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('refuses a header value that is empty, over-long, or outside printable ASCII', () => {
    expect(isPlainHeaderValue('')).toBe(false);
    expect(isPlainHeaderValue('image/*'.padEnd(257, 'x'))).toBe(false);
    expect(isPlainHeaderValue('image/*'.padEnd(256, 'x'))).toBe(true);
    expect(isPlainHeaderValue('image/png\u0000')).toBe(false);
    expect(isPlainHeaderValue('image/png, image/jpeg\t')).toBe(true);
  });
});
