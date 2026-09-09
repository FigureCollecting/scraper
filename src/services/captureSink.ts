/**
 * CaptureSink — the raw-capture side of the fetch path.
 *
 * The scraper observes two byte-streams per fetch and hands each to a sink:
 *   - the WIRE lane: the main document's HTTP response body, buffered in a
 *     `response` listener BEFORE JS runs (the pre-render bytes);
 *   - the DOM lane: `page.content()` AFTER load (the post-JS serialized DOM).
 * API-based rulesets emit an 'api' lane from services.http.
 * The ASSET lane carries a referenced binary (a product image) rather than a page
 * body: same content-addressing, plus the provenance that says which item page
 * referenced it and where in that page's image list it sat.
 *
 * A RawCapture carries the bytes + their content hash + minimal provenance; the
 * downstream sink writes the bytes to object storage (content-addressed by
 * sha256) and emits the metadata row to the spine's raw-capture ingest. This
 * module owns only the CONTRACT and the hashing — storage/emit are the sink's
 * job, injected so the capture path is unit-testable without a browser, object
 * store, or spine.
 */
import { createHash } from 'node:crypto';

export type CaptureLane = 'wire' | 'dom' | 'api' | 'asset';

/** The item a captured asset belongs to (asset lane only). */
export interface CaptureSourceItem {
  /** The DECLARING store's site key (e.g. `myfigurecollection.net`). */
  site: string;
  /** That store's own id for the item. */
  itemId: string;
}

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
  /** The type the server DECLARED, when it declared one; else the type that was sniffed. */
  contentType?: string;
  /**
   * `Content-Encoding` the response carried, when it carried one.
   *
   * A witness that the body on the wire was not the body on disk. Kept because the stored bytes
   * cannot say it afterwards — and on the asset lane, where the whole point is holding the
   * merchant's ORIGINAL, "is this the original or a rendition of it" is the question the archive
   * exists to answer.
   */
  contentEncoding?: string;
  /**
   * `Vary` the response carried, when it carried one. `Vary: Accept` is a server saying in as many
   * words that it CHOSE this representation from the request header — the negotiation these lanes'
   * archival Accept exists to avoid, recorded when it happened anyway.
   */
  vary?: string;
  /** ISO-8601 instant the fetch was observed. */
  fetchedAt: string;
  /** Asset lane: the item whose page referenced these bytes. */
  sourceItem?: CaptureSourceItem;
  /** Asset lane: the page URL that referenced these bytes. */
  sourceUrl?: string;
  /** Asset lane: 0-based index of this asset in the referencing page's list. */
  position?: number;
  /**
   * Asset lane: what the referencing page said this image IS, in the contract's
   * store-agnostic vocabulary (`ImageRole`). Kept because the bytes alone cannot
   * say it: a product plate and a box shot are the same JPEG to an object store,
   * and a later renderer choosing a hero image needs the distinction the ruleset
   * already made.
   */
  role?: string;
}

export interface RawCaptureInput {
  url: string;
  finalUrl?: string;
  lane: CaptureLane;
  bytes: Buffer;
  statusCode?: number;
  contentType?: string;
  contentEncoding?: string;
  vary?: string;
  /** Defaults to now (ISO) when omitted. */
  fetchedAt?: string;
  sourceItem?: CaptureSourceItem;
  sourceUrl?: string;
  position?: number;
  role?: string;
}

/**
 * Why a sink could not take a capture. All three are TRANSIENT — the sink had no room
 * for this capture right now — which is the whole point of naming them: a caller that
 * keeps a per-url memo must not record a refused capture as done, or the bytes are lost
 * AND the retry is suppressed. A kill switch or a typed skip is NOT a refusal: the sink
 * resolved the capture, and offering it again would change nothing.
 *
 * `assetReserve` is the queue saying it still has room, but not for THIS lane: the
 * asset lane is held to a share of the budget so that page bodies — irreplaceable
 * provenance behind claims already written, where an image is simply re-fetched on the
 * next pass — always have somewhere to land. Named apart from the two full-queue
 * reasons because the operator response differs: one means the store is behind, the
 * other means the reservation is doing its job.
 */
export type CaptureRefusal = 'queueFull' | 'queueBytesFull' | 'assetReserve';

/** What a sink says about a capture it was offered. */
export interface CaptureAdmission {
  /** False only when the sink could not take it and offering it AGAIN could succeed. */
  admitted: boolean;
  reason?: CaptureRefusal;
}

/**
 * A destination for raw captures. Implementations store bytes + emit metadata.
 *
 * `capture` may answer with a {@link CaptureAdmission}; a sink that returns nothing is
 * read as having accepted, so the Noop/Collecting sinks and every test fake stay valid.
 */
export interface CaptureSink {
  capture(c: RawCapture): Promise<void | CaptureAdmission>;
  /**
   * Wait for everything already accepted to reach the store. Optional, because a
   * sink that writes synchronously has nothing to drain — but a QUEUEING sink does,
   * and at SIGTERM that queue is write-once bytes with no retry anywhere behind it.
   */
  flush?(): Promise<void>;
}

/** The shared "the sink took it" answer — no allocation per capture. */
export const CAPTURE_ADMITTED: CaptureAdmission = Object.freeze({ admitted: true });

/** True unless the sink explicitly refused. Absent/void answers mean accepted. */
export function wasAdmitted(result: void | CaptureAdmission): boolean {
  return !result || result.admitted !== false;
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
  if (input.contentEncoding !== undefined) capture.contentEncoding = input.contentEncoding;
  if (input.vary !== undefined) capture.vary = input.vary;
  if (input.sourceItem !== undefined) capture.sourceItem = input.sourceItem;
  if (input.sourceUrl !== undefined) capture.sourceUrl = input.sourceUrl;
  if (input.position !== undefined) capture.position = input.position;
  if (input.role !== undefined) capture.role = input.role;
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
