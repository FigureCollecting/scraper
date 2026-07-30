/**
 * CaptureSink — the raw-capture side of the fetch path.
 *
 * The scraper observes two byte-streams per fetch and hands each to a sink:
 *   - the WIRE lane: the main document's HTTP response body, buffered in a
 *     `response` listener BEFORE JS runs (the pre-render bytes);
 *   - the DOM lane: `page.content()` AFTER load (the post-JS serialized DOM).
 * API-based rulesets emit an 'api' lane from services.http.
 *
 * A RawCapture carries the bytes + their content hash + minimal provenance; the
 * downstream sink writes the bytes to object storage (content-addressed by
 * sha256) and emits the metadata row to the spine's raw-capture ingest. This
 * module owns only the CONTRACT and the hashing — storage/emit are the sink's
 * job, injected so the capture path is unit-testable without a browser, object
 * store, or spine.
 */
import { createHash } from 'node:crypto';

export type CaptureLane = 'wire' | 'dom' | 'api';

export interface RawCapture {
  /** The URL as requested (entry URL, pre-redirect). */
  url: string;
  /** The resolved URL after redirects, if different from `url`. */
  finalUrl?: string;
  lane: CaptureLane;
  /** Uncompressed body bytes exactly as observed. */
  bytes: Buffer;
  /** Lowercase hex sha256 of the UNCOMPRESSED bytes — the content address. */
  sha256: string;
  statusCode?: number;
  contentType?: string;
  /** ISO-8601 instant the fetch was observed. */
  fetchedAt: string;
}

export interface RawCaptureInput {
  url: string;
  finalUrl?: string;
  lane: CaptureLane;
  bytes: Buffer;
  statusCode?: number;
  contentType?: string;
  /** Defaults to now (ISO) when omitted. */
  fetchedAt?: string;
}

/** A destination for raw captures. Implementations store bytes + emit metadata. */
export interface CaptureSink {
  capture(c: RawCapture): Promise<void>;
}

/** Build a RawCapture, computing the content address from the bytes. */
export function buildRawCapture(input: RawCaptureInput): RawCapture {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const capture: RawCapture = {
    url: input.url,
    lane: input.lane,
    bytes: input.bytes,
    sha256,
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
  };
  if (input.finalUrl !== undefined && input.finalUrl !== input.url) capture.finalUrl = input.finalUrl;
  if (input.statusCode !== undefined) capture.statusCode = input.statusCode;
  if (input.contentType !== undefined) capture.contentType = input.contentType;
  return capture;
}

/** Default sink: drops captures. Used when capture is not configured. */
export class NoopCaptureSink implements CaptureSink {
  async capture(): Promise<void> {
    /* intentionally empty */
  }
}

/** Test sink: retains every capture handed to it. */
export class CollectingCaptureSink implements CaptureSink {
  readonly captures: RawCapture[] = [];
  async capture(c: RawCapture): Promise<void> {
    this.captures.push(c);
  }
}
