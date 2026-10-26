/**
 * GAL-RES: the gallery run's byte meter. It counts the body bytes each response is read for, at the transport (both lanes), and on a
 * run with a byte budget it reads a body through its stream and stops past the per-file cap, so one response can never be read for
 * more than the reservation the budget gate holds back for it.
 */
import type { ImpitLike, ImpitResponseLike } from '../../services/impitFetch';
import {
  READ_CHUNK_ALLOWANCE, createByteMeter, meterFetch, meterImpit, readCapped,
} from '../../services/images/galleryBytes';
import type { BytesFetchImpl, BytesResponseLike } from '../../services/images/httpBytesFetch';

/** A ReadableStream that hands out the given chunks in order, recording whether it was cancelled. */
function chunked(sizes: number[], fill = 0x61): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean; pulled: () => number } {
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= sizes.length) { controller.close(); return; }
      controller.enqueue(new Uint8Array(sizes[i++]!).fill(fill));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, cancelled: () => cancelled, pulled: () => i };
}

describe('createByteMeter', () => {
  it('counts what it is told, and with no budget is never spent', () => {
    const m = createByteMeter({ capBytes: 1000 });
    m.add(300);
    m.add(200);
    expect(m.read()).toBe(500);
    expect(m.max).toBeUndefined();
    expect(m.capBytes).toBeUndefined();
    expect(m.spent()).toBeUndefined();
  });

  it('reserves the per-file cap plus one transport chunk for every request', () => {
    expect(createByteMeter({ max: 10 ** 9, capBytes: 1000 }).reserve).toBe(1000 + READ_CHUNK_ALLOWANCE);
    expect(createByteMeter({ max: 10 ** 9, capBytes: 1000, allowance: 50 }).reserve).toBe(1050);
    expect(READ_CHUNK_ALLOWANCE).toBe(1024 * 1024);
  });

  it('is spent once the budget has no room left for one more full reservation, and says so in numbers', () => {
    const m = createByteMeter({ max: 2500, capBytes: 1000, allowance: 100 });
    expect(m.capBytes).toBe(1000);
    expect(m.spent()).toBeUndefined();
    m.add(1400); // 1400 + 1100 = 2500: still fits
    expect(m.spent()).toBeUndefined();
    m.add(1); // 1401 + 1100 > 2500
    expect(m.spent()).toMatch(/1401 of 2500 bytes read.*1100/);
  });
});

describe('readCapped', () => {
  it('reads a body to its end when it stays within the cap, counting every chunk', async () => {
    const s = chunked([100, 200, 300]);
    const counted: number[] = [];
    const b = await readCapped(s.stream, 1000, n => counted.push(n));
    expect(b.length).toBe(600);
    expect(counted).toEqual([100, 200, 300]);
    expect(s.cancelled()).toBe(false);
  });

  it('stops at the first chunk past the cap and cancels the stream: the rest is never pulled', async () => {
    const s = chunked([400, 400, 400, 400, 400]);
    const counted: number[] = [];
    const b = await readCapped(s.stream, 1000, n => counted.push(n));
    expect(b.length).toBe(1200);
    expect(counted).toEqual([400, 400, 400]);
    expect(s.cancelled()).toBe(true);
    expect(s.pulled()).toBe(3);
  });

  it('a cancel that fails does not fail the read: the body past the cap is still refused by its size', async () => {
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(700)); i++; },
      cancel() { throw new Error('the transport is already gone'); },
    }, { highWaterMark: 0 });
    const b = await readCapped(stream, 1000, () => undefined);
    expect(b.length).toBe(1400);
    expect(i).toBe(2);
  });

  it('a stream that errors mid-body rejects with that error; what arrived before it is still counted', async () => {
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n++ === 0) { controller.enqueue(new Uint8Array(250)); return; }
        controller.error(new Error('socket hang up'));
      },
    }, { highWaterMark: 0 });
    const counted: number[] = [];
    await expect(readCapped(stream, 1000, c => counted.push(c))).rejects.toThrow('socket hang up');
    expect(counted).toEqual([250]);
  });
});

const httpRes = (over: Partial<BytesResponseLike> & { body?: ReadableStream<Uint8Array> | null } = {}): BytesResponseLike & { body?: ReadableStream<Uint8Array> | null } => ({
  status: 200, url: 'https://x.example/a.png', headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(7), ...over,
});

describe('meterFetch (the http lane transport)', () => {
  it('without a budget it counts what the lane reads through the response\'s own arrayBuffer, and passes the rest through', async () => {
    const m = createByteMeter({ capBytes: 1000 });
    const original = httpRes({ arrayBuffer: async () => new ArrayBuffer(321) });
    const inner: BytesFetchImpl = async () => original;
    const res = await meterFetch(inner, m)('https://x.example/a.png', { headers: {} });
    expect(res.status).toBe(200);
    expect(res.url).toBe('https://x.example/a.png');
    expect(res.headers).toBe(original.headers);
    expect(m.read()).toBe(0);
    expect((await res.arrayBuffer()).byteLength).toBe(321);
    expect(m.read()).toBe(321);
  });

  it('a response the lane never reads (a 403) costs nothing', async () => {
    const m = createByteMeter({ max: 10 ** 9, capBytes: 1000 });
    await meterFetch(async () => httpRes({ status: 403 }), m)('u', { headers: {} });
    expect(m.read()).toBe(0);
  });

  it('with a budget it reads the body stream, stops past the cap, and counts the chunks it took', async () => {
    const m = createByteMeter({ max: 10 ** 9, capBytes: 1000, allowance: 600 });
    const s = chunked([500, 500, 500, 500]);
    const res = await meterFetch(async () => httpRes({ body: s.stream, arrayBuffer: async () => { throw new Error('the whole body must not be buffered'); } }), m)('u', { headers: {} });
    expect((await res.arrayBuffer()).byteLength).toBe(1500);
    expect(m.read()).toBe(1500);
    expect(s.cancelled()).toBe(true);
  });

  it('with a budget, a response with no body stream falls back to arrayBuffer and is still counted', async () => {
    const m = createByteMeter({ max: 10 ** 9, capBytes: 1000 });
    const res = await meterFetch(async () => httpRes({ body: null, url: undefined, arrayBuffer: async () => new ArrayBuffer(9) }), m)('u', { headers: {} });
    expect(res.url).toBeUndefined();
    expect((await res.arrayBuffer()).byteLength).toBe(9);
    expect(m.read()).toBe(9);
  });
});

const impitRes = (over: Partial<ImpitResponseLike> & { body?: unknown } = {}): ImpitResponseLike => ({
  status: 200, url: 'https://x.example/a.png', headers: new Headers({ 'content-type': 'image/png' }), text: async () => 'txt', ...over,
});
const session = (res: ImpitResponseLike): ImpitLike & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); return res; } };
};

describe('meterImpit (the impit lane session)', () => {
  it('without a budget it counts bytes() and passes status, url, headers and text through untouched', async () => {
    const m = createByteMeter({ capBytes: 1000 });
    const original = impitRes({ bytes: async () => new Uint8Array(77) });
    const s = session(original);
    const res = await meterImpit(s, m).fetch('https://x.example/a.png', { method: 'GET', headers: { accept: 'image/*' }, redirect: 'manual' });
    expect(s.calls).toEqual([{ url: 'https://x.example/a.png', init: { method: 'GET', headers: { accept: 'image/*' }, redirect: 'manual' } }]);
    expect(res.status).toBe(200);
    expect(res.url).toBe(original.url);
    expect(res.headers).toBe(original.headers);
    expect(await res.text()).toBe('txt');
    expect((await res.bytes!()).byteLength).toBe(77);
    expect(m.read()).toBe(77);
  });

  it('without a budget, a build with only arrayBuffer() is counted through it', async () => {
    const m = createByteMeter({ capBytes: 1000 });
    const res = await meterImpit(session(impitRes({ arrayBuffer: async () => new ArrayBuffer(12) })), m).fetch('u', { method: 'GET' });
    expect(res.bytes).toBeUndefined();
    expect((await res.arrayBuffer!()).byteLength).toBe(12);
    expect(m.read()).toBe(12);
  });

  it('a build with neither binary method stays without one (the lane then answers unsupported), and a missing status, headers or url stays missing', async () => {
    const m = createByteMeter({ capBytes: 1000 });
    const res = await meterImpit(session({ text: async () => '' }), m).fetch('u', { method: 'GET' });
    expect(res.bytes).toBeUndefined();
    expect(res.arrayBuffer).toBeUndefined();
    expect('status' in res).toBe(false);
    expect('headers' in res).toBe(false);
    expect('url' in res).toBe(false);
  });

  it('with a budget it reads the body stream with the cap: a body with no declared length is cut after the first chunk past the cap', async () => {
    const m = createByteMeter({ max: 10 ** 9, capBytes: 1000, allowance: 600 });
    const s = chunked([600, 600, 600, 600]);
    const res = await meterImpit(session(impitRes({ body: s.stream, bytes: async () => { throw new Error('the whole body must not be buffered'); } })), m).fetch('u', { method: 'GET' });
    expect((await res.bytes!()).byteLength).toBe(1200);
    expect(m.read()).toBe(1200);
    expect(s.cancelled()).toBe(true);
  });

  it('with a budget, a response whose body getter is not a stream (or throws) falls back to its own method, counted', async () => {
    const m = createByteMeter({ max: 10 ** 9, capBytes: 1000 });
    const plain = await meterImpit(session(impitRes({ body: 'not a stream', bytes: async () => new Uint8Array(5) })), m).fetch('u', { method: 'GET' });
    expect((await plain.bytes!()).byteLength).toBe(5);
    const throwing = impitRes({ arrayBuffer: async () => new ArrayBuffer(6) });
    Object.defineProperty(throwing, 'body', { get() { throw new Error('consumed'); } });
    const viaGetter = await meterImpit(session(throwing), m).fetch('u', { method: 'GET' });
    expect((await viaGetter.arrayBuffer!()).byteLength).toBe(6);
    expect(m.read()).toBe(11);
  });
});
