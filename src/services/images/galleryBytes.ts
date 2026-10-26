/**
 * galleryBytes — what a gallery run READS, counted at the transport, and the byte budget a run may be held to (GAL-RES).
 *
 * The meter sits between each lane and its transport (the http lane's fetch, the impit lane's session), so it sees every body a lane
 * takes, whatever the lane then decides about it: an image stored, a body that turned out not to be an image, a placeholder, a body cut
 * at the size cap. A response the lane never reads (a 403, a declared length over the cap) costs nothing, as on the wire.
 *
 * With no budget it only counts, through the response's own body method, so a run without GALLERY_MAX_BYTES reads exactly as before.
 * With a budget (GALLERY_MAX_BYTES, required on residential egress) two things change:
 *   - a body is read through its STREAM and the read stops at the first chunk past the per-file cap: a body that declares no length can
 *     no longer be read for more than the cap plus that one chunk (the lane then refuses it as too large, as it would have anyway);
 *   - a request goes out only while the budget still holds a full RESERVATION for it, the cap plus {@link READ_CHUNK_ALLOWANCE}. So
 *     the run stops between files, before one that could cross the budget, never in the middle of one, and what it read never exceeds
 *     the budget. The price is that up to one reservation of the budget is left unused.
 *
 * bytesRead counts response BODY bytes taken from the transport. Headers, TLS and what the socket had buffered past a cut are below it.
 */
import type { ImpitLike, ImpitResponseLike } from '../impitFetch.js';
import type { BytesFetchImpl, BytesResponseLike } from './httpBytesFetch.js';

/**
 * Room for the one transport chunk a capped read may take past the cap before it stops. Measured on loopback (2026-10-26) the impit
 * body stream handed out chunks of up to 504 KiB; undici's are at most 64 KiB.
 */
export const READ_CHUNK_ALLOWANCE = 1024 * 1024;

export interface GalleryByteMeter {
  /** GALLERY_MAX_BYTES; undefined on a run with no budget (the meter then only counts). */
  readonly max: number | undefined;
  /** On a budgeted run, the per-file cap a capped read stops past; undefined when the lanes read as they always have. */
  readonly capBytes: number | undefined;
  /** What one request may read: the per-file cap plus one chunk. A request goes out only while this much of the budget is left. */
  readonly reserve: number;
  read(): number;
  add(n: number): void;
  /** Why no further request may go out (the budget has no room for one more reservation), or undefined. */
  spent(): string | undefined;
}

export function createByteMeter(opts: { max?: number; capBytes: number; allowance?: number }): GalleryByteMeter {
  const reserve = opts.capBytes + (opts.allowance ?? READ_CHUNK_ALLOWANCE);
  let read = 0;
  return {
    max: opts.max,
    capBytes: opts.max === undefined ? undefined : opts.capBytes,
    reserve,
    read: () => read,
    add(n) { read += n; },
    spent() {
      if (opts.max === undefined || read + reserve <= opts.max) return undefined;
      return `byte budget reached: ${read} of ${opts.max} bytes read, and one more request may read up to ${reserve}`;
    },
  };
}

/**
 * Read a body through its stream, counting every chunk as it arrives, and stop at the first chunk that takes it past `cap` (the stream
 * is cancelled, so the rest is never pulled). A stream that errors rejects with that error; the chunks before it stay counted.
 */
export async function readCapped(body: ReadableStream<Uint8Array>, cap: number, count: (n: number) => void): Promise<Buffer> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    count(value.byteLength);
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(parts, total);
}

/** The body stream of a response, when it has one (a test double, or an impit build without the getter, may not). */
function streamOf(res: unknown): ReadableStream<Uint8Array> | undefined {
  try {
    const body = (res as { body?: unknown }).body;
    return body instanceof ReadableStream ? (body as ReadableStream<Uint8Array>) : undefined;
  } catch {
    return undefined;
  }
}

const arrayBufferOf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** The http lane's transport, metered: the lane reads the body through `arrayBuffer()`, which is where it is counted (and capped). */
export function meterFetch(inner: BytesFetchImpl, meter: GalleryByteMeter): BytesFetchImpl {
  return async (url, init) => {
    const res = await inner(url, init);
    const cap = meter.capBytes;
    const metered: BytesResponseLike = {
      status: res.status,
      ...(res.url !== undefined ? { url: res.url } : {}),
      headers: res.headers,
      arrayBuffer: async () => {
        const body = cap !== undefined ? streamOf(res) : undefined;
        if (body !== undefined && cap !== undefined) return arrayBufferOf(await readCapped(body, cap, n => meter.add(n)));
        const ab = await res.arrayBuffer();
        meter.add(ab.byteLength);
        return ab;
      },
    };
    return metered;
  };
}

/** The impit lane's session, metered: the lane reads the body through `bytes()` (else `arrayBuffer()`), counted (and capped) here. */
export function meterImpit(impit: ImpitLike, meter: GalleryByteMeter): ImpitLike {
  return {
    async fetch(url, init) {
      const res = await impit.fetch(url, init);
      const cap = meter.capBytes;
      const out: { -readonly [K in keyof ImpitResponseLike]: ImpitResponseLike[K] } = {
        text: () => res.text(),
        ...(res.status !== undefined ? { status: res.status } : {}),
        ...(res.headers !== undefined ? { headers: res.headers } : {}),
        ...(res.url !== undefined ? { url: res.url } : {}),
      };
      const body = cap !== undefined ? streamOf(res) : undefined;
      if (body !== undefined && cap !== undefined) {
        out.bytes = async () => new Uint8Array(await readCapped(body, cap, n => meter.add(n)));
      } else if (typeof res.bytes === 'function') {
        out.bytes = async () => {
          const b = await res.bytes!();
          meter.add(b.byteLength);
          return b;
        };
      } else if (typeof res.arrayBuffer === 'function') {
        out.arrayBuffer = async () => {
          const ab = await res.arrayBuffer!();
          meter.add(ab.byteLength);
          return ab;
        };
      }
      return out;
    },
  };
}
