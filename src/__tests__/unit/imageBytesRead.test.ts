/**
 * `bytesRead` on a FAILED image fetch — what the residential budget is actually spending.
 *
 * The budget exists to bound what a domestic line carries, and a line does not care whether the
 * bytes were useful. A body that arrives and is then rejected — a hotlink interstitial, a challenge
 * page, an oversized file, a redirect off the declaring store — crossed the wire exactly like a
 * stored plate did. Booking only successes lets a store whose every image is refused pull far past
 * the day's ceiling while the counter reads zero, which is the opposite of what the ceiling is for.
 *
 * So every lane reports what it actually read, and only what it actually read: a refusal decided
 * BEFORE the body (a declared Content-Length over the cap, a non-2xx with no body taken) reports
 * nothing, because nothing was spent.
 */
import { createHttpBytesFetch } from '../../services/images/httpBytesFetch';
import { createImpitBytesFetch } from '../../services/images/impitBytesFetch';
import type { ImageBytesResult } from '../../services/images/imageBytes';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const HTML = Buffer.from('<html>you are not allowed to hotlink this</html>');

const headers = (entries: Record<string, string>) => ({ get: (name: string) => entries[name.toLowerCase()] ?? null });

const httpLane = (over: Record<string, unknown> = {}, maxBytes?: number) =>
  createHttpBytesFetch({
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    fetchImpl: async () =>
      ({
        status: 200,
        url: 'https://cdn.test/a.jpg',
        headers: headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
        ...over,
      }) as never,
  });

const failed = (result: ImageBytesResult) => {
  if (result.ok) throw new Error('expected a failure');
  return result;
};

describe('the plain-HTTP lane reports what it read', () => {
  it('books a hotlink interstitial that arrived under an image content type', async () => {
    const lane = httpLane({
      headers: headers({ 'content-type': 'text/html' }),
      arrayBuffer: async () => HTML.buffer.slice(HTML.byteOffset, HTML.byteOffset + HTML.byteLength),
    });
    const result = failed(await lane('https://cdn.test/a.jpg'));
    expect(result.reason).toBe('not-image');
    expect(result.bytesRead).toBe(HTML.byteLength);
  });

  it("books a body the caller's final-url guard rejected - it still crossed the wire", async () => {
    const result = failed(await httpLane()('https://cdn.test/a.jpg', { allowFinalUrl: () => false }));
    expect(result.reason).toBe('refused');
    expect(result.bytesRead).toBe(PNG.byteLength);
  });

  it('books a body only MEASURED to be oversized, since it was read to find out', async () => {
    const result = failed(await httpLane({}, 4)('https://cdn.test/a.jpg'));
    expect(result.reason).toBe('too-large');
    expect(result.bytesRead).toBe(PNG.byteLength);
  });

  it('books NOTHING for a body refused on its declared length, which was never read', async () => {
    const lane = httpLane({ headers: headers({ 'content-type': 'image/png', 'content-length': '999999' }) }, 4);
    const result = failed(await lane('https://cdn.test/a.jpg'));
    expect(result.reason).toBe('too-large');
    expect(result.bytesRead).toBeUndefined();
  });

  it('books NOTHING for a non-2xx, whose body this lane never takes', async () => {
    const result = failed(await httpLane({ status: 404 })('https://cdn.test/a.jpg'));
    expect(result.reason).toBe('http-status');
    expect(result.bytesRead).toBeUndefined();
  });
});

describe('the impersonating lane reports what it read', () => {
  const impitLane = (body: Buffer, contentType: string, maxBytes?: number) =>
    createImpitBytesFetch({
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      getImpit: async () =>
        ({
          fetch: async () => ({
            status: 200,
            url: 'https://cdn.test/a.jpg',
            headers: new Map([['content-type', contentType]]),
            bytes: async () => new Uint8Array(body),
          }),
        }) as never,
    });

  it('books a challenge page served under a 200', async () => {
    const result = failed(await impitLane(HTML, 'text/html')('https://cdn.test/a.jpg'));
    expect(result.reason).toBe('not-image');
    expect(result.bytesRead).toBe(HTML.byteLength);
  });

  it('books a body the final-url guard rejected', async () => {
    const result = failed(await impitLane(PNG, 'image/png')('https://cdn.test/a.jpg', { allowFinalUrl: () => false }));
    expect(result.reason).toBe('refused');
    expect(result.bytesRead).toBe(PNG.byteLength);
  });

  it('books a body measured over the cap', async () => {
    const result = failed(await impitLane(PNG, 'image/png', 4)('https://cdn.test/a.jpg'));
    expect(result.reason).toBe('too-large');
    expect(result.bytesRead).toBe(PNG.byteLength);
  });
});
