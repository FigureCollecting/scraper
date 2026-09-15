/**
 * captureReporter — the engine-side Connect client that records ONE stored object into the spine's
 * provenance ledger (ingest.v1.SpineIngest/ReportCapture, contract 0.6.0).
 *
 * The properties that matter operationally mirror the failure reporter, plus two that are this
 * lane's own:
 *   1. BEST EFFORT. A report never throws and never rejects; a lost report is a missing row for
 *      bytes that ARE in the bucket, repaired by the backfill (I5), never a broken scrape.
 *   2. OFF BY DEFAULT. REPORT_CAPTURES must be explicitly on; unset means no reporting at all, so the
 *      feature ships dark and is armed deliberately.
 *   3. UNIMPLEMENTED SELF-DISABLES. Shipped before the server handler exists, the reporter meets
 *      UNIMPLEMENTED, disables itself for the process, logs once, and counts — it never hammers a
 *      server that has no handler.
 *   4. ENGINE_VERSION IS ABSENT ON LANE 'asset'. The server supplies the constant; a value there is a
 *      structural fault (INVALID_ARGUMENT), so the reporter drops it rather than send it.
 */
import { ConnectError, Code } from '@connectrpc/connect';
import {
  CaptureReporter,
  createCaptureReporterFromEnv,
  captureReportView,
  resetCaptureReportStats,
  type CaptureClient,
  type StoredCaptureReport,
} from '../../services/captureReporter.js';

const SHA_HEX = 'a'.repeat(64);

const baseReport = (over: Partial<StoredCaptureReport> = {}): StoredCaptureReport => ({
  site: 'amiami',
  itemId: 'FIGURE-123',
  url: 'https://img.amiami.com/images/product/main/243/FIGURE-123.jpg',
  lane: 'asset',
  sha256: SHA_HEX,
  bytesLen: 40_137,
  storageKey: `raw-img/sha256/aa/${SHA_HEX}.jpg`,
  alreadyStored: false,
  ...over,
});

function fakeClient(): { client: CaptureClient; calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    client: {
      reportCapture: async (message: any) => {
        calls.push(message);
        return { accepted: 1, deduped: 0, warnings: [] } as any;
      },
    },
  };
}

beforeEach(() => resetCaptureReportStats());

describe('CaptureReporter — the wire message', () => {
  it('maps an asset capture onto a one-capture batch', async () => {
    const { client, calls } = fakeClient();
    const reporter = new CaptureReporter({ client, now: () => 1_700_000_000_000 });

    await reporter.report(
      baseReport({
        contentType: 'image/jpeg',
        finalUrl: 'https://cdn.amiami.com/x.jpg',
        httpStatus: 200,
        role: 'gallery',
        position: 2,
        sourceUrl: 'https://www.amiami.com/eng/detail/?gcode=FIGURE-123',
        sourceClass: 'manufacturer_press',
        contentLevel: 'general',
      }),
    );

    expect(calls).toHaveLength(1);
    const cap = calls[0].captures[0];
    expect(calls[0].captures).toHaveLength(1);
    expect(cap.source.site).toBe('amiami');
    expect(cap.source.itemId).toBe('FIGURE-123');
    expect(cap.source.url).toBe('https://img.amiami.com/images/product/main/243/FIGURE-123.jpg');
    expect(cap.lane).toBe('asset');
    // sha travels as RAW BYTES, exactly 32 of them
    expect(cap.blobSha256).toBeInstanceOf(Uint8Array);
    expect(cap.blobSha256).toHaveLength(32);
    expect(Buffer.from(cap.blobSha256).toString('hex')).toBe(SHA_HEX);
    expect(Number(cap.bytesLen)).toBe(40_137);
    expect(cap.storageKey).toBe(`raw-img/sha256/aa/${SHA_HEX}.jpg`);
    expect(cap.contentType).toBe('image/jpeg');
    expect(cap.role).toBe('gallery');
    expect(cap.position).toBe(2);
    expect(cap.sourceUrl).toBe('https://www.amiami.com/eng/detail/?gcode=FIGURE-123');
    expect(cap.sourceClass).toBe('manufacturer_press');
    expect(cap.contentLevel).toBe('general');
    expect(cap.alreadyStored).toBe(false);
  });

  it("OMITS engine_version entirely on lane 'asset', even when a caller supplies one", async () => {
    const { client, calls } = fakeClient();
    const reporter = new CaptureReporter({ client });

    // A producer bug: an engine version on the asset lane is INVALID_ARGUMENT at the shell. The
    // reporter must not let it reach the wire.
    await reporter.report(baseReport({ engineVersion: 'chrome142' } as Partial<StoredCaptureReport>));

    expect(calls[0].captures[0].engineVersion).toBeUndefined();
  });

  it('stamps extracted_at from the injected clock when the caller supplies none', async () => {
    const { client, calls } = fakeClient();
    const reporter = new CaptureReporter({ client, now: () => 1_700_000_000_000 });

    await reporter.report(baseReport());

    expect(calls[0].captures[0].source.extractedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('passes a caller-supplied extracted_at through verbatim (it is part of the capture key)', async () => {
    const { client, calls } = fakeClient();
    const reporter = new CaptureReporter({ client, now: () => 1_700_000_000_000 });

    await reporter.report(baseReport({ fetchedAt: '2026-09-14T00:00:00.000Z' }));

    expect(calls[0].captures[0].source.extractedAt).toBe('2026-09-14T00:00:00.000Z');
  });

  it('omits optional fields rather than sending zeros/empties', async () => {
    const { client, calls } = fakeClient();
    const reporter = new CaptureReporter({ client });

    await reporter.report(baseReport({ itemId: undefined }));
    const cap = calls[0].captures[0];

    expect(cap.contentType).toBeUndefined();
    expect(cap.finalUrl).toBeUndefined();
    expect(cap.httpStatus).toBeUndefined();
    expect(cap.role).toBeUndefined();
    expect(cap.position).toBeUndefined();
    expect(cap.sourceUrl).toBeUndefined();
    expect(cap.sourceClass).toBeUndefined();
    expect(cap.contentLevel).toBeUndefined();
    expect(cap.source.itemId).toBe(''); // proto default; contract reads empty as "no native id"
  });

  it('carries position 0 as present, not dropped — absent and zero are different facts', async () => {
    const { client, calls } = fakeClient();
    const reporter = new CaptureReporter({ client });

    await reporter.report(baseReport({ position: 0 }));

    expect(calls[0].captures[0].position).toBe(0);
  });
});

describe('CaptureReporter — structural guards (kept off the server error budget)', () => {
  it('refuses a report with no storage_key rather than send one the shell rejects', async () => {
    const { client, calls } = fakeClient();
    const reporter = new CaptureReporter({ client });

    await reporter.report(baseReport({ storageKey: '' }));

    expect(calls).toHaveLength(0);
    expect(captureReportView().failed).toBe(1);
  });

  it('refuses a report with no site or no url', async () => {
    const { client, calls } = fakeClient();
    const reporter = new CaptureReporter({ client });

    await reporter.report(baseReport({ site: '' }));
    await reporter.report(baseReport({ url: '' }));

    expect(calls).toHaveLength(0);
    expect(captureReportView().failed).toBe(2);
  });

  it('refuses a sha that is not 32 bytes (64 hex chars)', async () => {
    const { client, calls } = fakeClient();
    const reporter = new CaptureReporter({ client });

    await reporter.report(baseReport({ sha256: 'abc' }));

    expect(calls).toHaveLength(0);
    expect(captureReportView().failed).toBe(1);
  });
});

describe('CaptureReporter — best effort', () => {
  it('never throws when the spine refuses the batch', async () => {
    const client: CaptureClient = {
      reportCapture: async () => {
        throw new ConnectError('bad producer', Code.InvalidArgument);
      },
    };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = new CaptureReporter({ client });

    await expect(reporter.report(baseReport())).resolves.toBeUndefined();
    expect(captureReportView().failed).toBe(1);
    expect(captureReportView().reported).toBe(0);
  });

  it('never throws when the client throws a non-Connect error', async () => {
    const client: CaptureClient = {
      reportCapture: async () => {
        throw new TypeError('boom');
      },
    };
    const reporter = new CaptureReporter({ client });

    await expect(reporter.report(baseReport())).resolves.toBeUndefined();
    expect(captureReportView().failed).toBe(1);
  });

  it('retries UNAVAILABLE up to three tries then gives up quietly', async () => {
    let tries = 0;
    const client: CaptureClient = {
      reportCapture: async () => {
        tries++;
        throw new ConnectError('down', Code.Unavailable);
      },
    };
    const reporter = new CaptureReporter({ client, retryDelayMs: 0 });

    await reporter.report(baseReport());

    expect(tries).toBe(3);
    expect(captureReportView().failed).toBe(1);
  });

  it('retries INTERNAL exactly once', async () => {
    let tries = 0;
    const client: CaptureClient = {
      reportCapture: async () => {
        tries++;
        throw new ConnectError('server fault', Code.Internal);
      },
    };
    const reporter = new CaptureReporter({ client, retryDelayMs: 0 });

    await reporter.report(baseReport());

    expect(tries).toBe(2);
  });

  it('never retries INVALID_ARGUMENT — a producer bug repeats', async () => {
    let tries = 0;
    const client: CaptureClient = {
      reportCapture: async () => {
        tries++;
        throw new ConnectError('bad', Code.InvalidArgument);
      },
    };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = new CaptureReporter({ client, retryDelayMs: 0 });

    await reporter.report(baseReport());

    expect(tries).toBe(1);
  });

  it('counts a successful report', async () => {
    const { client } = fakeClient();
    const reporter = new CaptureReporter({ client });

    await reporter.report(baseReport());
    await reporter.report(baseReport({ url: 'https://x/2', storageKey: `raw-img/sha256/aa/${SHA_HEX}.png` }));

    expect(captureReportView().reported).toBe(2);
    expect(captureReportView().failed).toBe(0);
  });
});

describe('CaptureReporter — UNIMPLEMENTED self-disables for the process', () => {
  it('disables after the first UNIMPLEMENTED, logging once and never calling the server again', async () => {
    let tries = 0;
    const client: CaptureClient = {
      reportCapture: async () => {
        tries++;
        throw new ConnectError('no handler yet', Code.Unimplemented);
      },
    };
    const warns: string[] = [];
    const reporter = new CaptureReporter({ client, warn: (m) => warns.push(m) });

    await reporter.report(baseReport());
    await reporter.report(baseReport({ url: 'https://x/2' }));
    await reporter.report(baseReport({ url: 'https://x/3' }));

    expect(tries).toBe(1); // called once, then disabled — never retried, never called again
    expect(captureReportView().disabled).toBe(true);
    expect(warns.filter((w) => /UNIMPLEMENTED|disabl/i.test(w))).toHaveLength(1); // logged exactly once
  });
});

describe('CaptureReporter — one log line per host per hour', () => {
  it('logs a dropped report at most once per host per hour, but counts every one', async () => {
    const client: CaptureClient = {
      reportCapture: async () => {
        throw new ConnectError('boom', Code.Internal);
      },
    };
    const warns: string[] = [];
    let clock = 1_000_000;
    const reporter = new CaptureReporter({ client, retryDelayMs: 0, warn: (m) => warns.push(m), now: () => clock });

    const sameHost = () => baseReport({ url: 'https://img.amiami.com/a.jpg' });
    await reporter.report(sameHost());
    await reporter.report(sameHost());
    await reporter.report(sameHost());

    expect(warns).toHaveLength(1); // one line for the host inside the hour
    expect(captureReportView().failed).toBe(3); // but every drop is counted

    clock += 3_600_001; // an hour later
    await reporter.report(sameHost());
    expect(warns).toHaveLength(2);
  });
});

describe('createCaptureReporterFromEnv — OFF by default', () => {
  it('is null when REPORT_CAPTURES is unset — reporting ships dark', () => {
    expect(createCaptureReporterFromEnv({ INGEST_BASE_URL: 'http://spine:50051' } as NodeJS.ProcessEnv)).toBeNull();
    expect(captureReportView().enabled).toBe(false);
  });

  it('is null without INGEST_BASE_URL even when REPORT_CAPTURES is true', () => {
    expect(createCaptureReporterFromEnv({ REPORT_CAPTURES: 'true' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it.each(['true', '1', 'yes', 'on'])('builds a reporter when REPORT_CAPTURES=%s and the base url is set', (value) => {
    const reporter = createCaptureReporterFromEnv({
      INGEST_BASE_URL: 'http://spine:50051',
      REPORT_CAPTURES: value,
    } as NodeJS.ProcessEnv);
    expect(reporter).not.toBeNull();
    expect(captureReportView().enabled).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', '', '   '])('stays null when REPORT_CAPTURES=%s', (value) => {
    expect(
      createCaptureReporterFromEnv({ INGEST_BASE_URL: 'http://spine:50051', REPORT_CAPTURES: value } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('builds a real-transport reporter, honoring REPORT_CAPTURE_TIMEOUT_MS and ignoring a nonsense value', () => {
    const on = { INGEST_BASE_URL: 'http://spine:50051', REPORT_CAPTURES: 'true' };
    expect(createCaptureReporterFromEnv({ ...on, REPORT_CAPTURE_TIMEOUT_MS: '2500' } as NodeJS.ProcessEnv)).not.toBeNull();
    expect(createCaptureReporterFromEnv({ ...on, REPORT_CAPTURE_TIMEOUT_MS: 'nope' } as NodeJS.ProcessEnv)).not.toBeNull();
  });
});

describe('CaptureReporter — default logger', () => {
  it('routes a dropped report through console.warn when no warn is injected', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client: CaptureClient = {
      reportCapture: async () => {
        throw new ConnectError('boom', Code.Internal);
      },
    };
    const reporter = new CaptureReporter({ client, retryDelayMs: 0 });

    await reporter.report(baseReport());

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('captureReportView', () => {
  it('starts at zero and is a copy, not the live counter', () => {
    const view = captureReportView();
    expect(view).toEqual({ enabled: false, reported: 0, failed: 0, disabled: false });
    view.reported = 99;
    expect(captureReportView().reported).toBe(0);
  });
});
