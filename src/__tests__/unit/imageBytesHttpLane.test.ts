/**
 * The plain-HTTP image BYTES lane — the sibling of the string `http` transport, for the one thing
 * the string lanes cannot carry: an image body. Two rules are pinned here:
 *   - every EXPECTED outcome is a typed result, never a throw (a 404, a non-image body, a timeout),
 *     because the caller's decision differs per outcome and an exception erases the difference;
 *   - the lane REFUSES residential egress exactly as `refuseHttpLaneResidentialEgress` does for the
 *     string lane — Node's global fetch cannot proxy, so a residential image must ride impit or the
 *     gated tab. It is refused BEFORE the network, never fetched from the node IP.
 */
import { createHttpBytesFetch, IMAGE_ACCEPT } from '../../services/images/httpBytesFetch';
import { classifyImageBytes } from '../../services/images/imageBytes';

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

  it('sends the image Accept header and a desktop UA, and the referer ONLY when one is given', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response());
    const fetchBytes = createHttpBytesFetch({ fetchImpl: fetchImpl as never });

    await fetchBytes('https://cdn.example.com/a.png');
    expect(fetchImpl.mock.calls[0][1].headers.accept).toBe(IMAGE_ACCEPT);
    expect(fetchImpl.mock.calls[0][1].headers['user-agent']).toMatch(/Mozilla/);
    expect(fetchImpl.mock.calls[0][1].headers.referer).toBeUndefined();

    await fetchBytes('https://cdn.example.com/a.png', { referer: 'https://store.example/p/1', userAgent: 'UA/1' });
    expect(fetchImpl.mock.calls[1][1].headers.referer).toBe('https://store.example/p/1');
    expect(fetchImpl.mock.calls[1][1].headers['user-agent']).toBe('UA/1');
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

  it('reports an HTML body served at an image URL as not-image (a hotlink block page is not an image)', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: FakeInit) => response({ contentType: 'text/html; charset=utf-8', body: Buffer.from('<html>denied</html>') }));
    const result = await createHttpBytesFetch({ fetchImpl: fetchImpl as never })('https://cdn.example.com/a.png');
    expect(result).toMatchObject({ ok: false, reason: 'not-image', status: 200, contentType: 'text/html; charset=utf-8' });
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

  it('rejects a non-image type, and an untyped body whose bytes are not an image', () => {
    expect(classifyImageBytes('text/html', PNG).image).toBe(false);
    expect(classifyImageBytes('application/json', PNG).image).toBe(false);
    expect(classifyImageBytes(undefined, Buffer.from('<html>')).image).toBe(false);
    expect(classifyImageBytes('application/octet-stream', Buffer.alloc(2)).image).toBe(false);
  });
});
