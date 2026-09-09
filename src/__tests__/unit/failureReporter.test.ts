/**
 * failureReporter — the engine-side Connect client that puts ONE terminal fetch failure into the
 * spine's ledger (ingest.v1.SpineIngest/ReportFetchFailure).
 *
 * The three properties that matter operationally:
 *   1. BEST EFFORT. A failed report never propagates into the item's own outcome — the ledger is
 *      bookkeeping, and losing a bookkeeping row must never turn a classified failure into a crash.
 *   2. ONE ROW PER TERMINAL OUTCOME. `attempts` on the ledger row drives the retry backoff, so a
 *      repeat report is a real cost; a cooldown SKIP is reported once per cooldown window.
 *   3. KILL SWITCH. REPORT_FETCH_FAILURES=false turns every call site into a no-op with no client.
 */
import { ConnectError, Code } from '@connectrpc/connect';
import {
  FailureReporter,
  createFailureReporterFromEnv,
  fetchFailureReportView,
  resetFetchFailureReportStats,
  type FetchFailureClient,
  type FetchFailureReport,
} from '../../services/failureReporter.js';

const baseReport = (over: Partial<FetchFailureReport> = {}): FetchFailureReport => ({
  site: 'mfc',
  itemId: '1234567',
  target: 'https://myfigurecollection.net/item/1234567',
  kind: 'record',
  origin: 'ingest',
  reasonClass: 'timeout',
  ...over,
});

function fakeClient(): { client: FetchFailureClient; calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    client: {
      reportFetchFailure: async (message: any) => {
        calls.push(message);
        return { id: 'row-1', attempts: 1, reviewStatus: 2, reopened: false } as any;
      },
    },
  };
}

beforeEach(() => resetFetchFailureReportStats());

describe('FailureReporter — the wire message', () => {
  it('maps a record failure onto the contract message', async () => {
    const { client, calls } = fakeClient();
    const reporter = new FailureReporter({ client, now: () => 1_700_000_000_000 });

    await reporter.report(
      baseReport({
        reasonClass: 'http_5xx',
        httpStatus: 503,
        message: 'upstream unwell',
        transport: 'impersonate',
        rulesetVersion: '0.9.15',
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].source.site).toBe('mfc');
    expect(calls[0].source.itemId).toBe('1234567');
    expect(calls[0].source.url).toBe('https://myfigurecollection.net/item/1234567');
    expect(calls[0].source.rulesetVersion).toBe('0.9.15');
    expect(calls[0].kind).toBe(1); // FETCH_KIND_RECORD
    expect(calls[0].reasonClass).toBe(4); // FETCH_REASON_CLASS_HTTP_5XX
    expect(calls[0].origin).toBe(4); // FETCH_ORIGIN_INGEST
    expect(calls[0].httpStatus).toBe(503);
    expect(calls[0].transport).toBe('impersonate');
    expect(calls[0].message).toBe('upstream unwell');
  });

  it('sends the canonical fc: target for a listing and leaves item_id empty', async () => {
    const { client, calls } = fakeClient();
    const reporter = new FailureReporter({ client });

    await reporter.report(
      baseReport({ kind: 'listing', origin: 'crawler', itemId: undefined, target: 'fc:listing/anitoysgk?axis=listing&page=3' }),
    );

    expect(calls[0].source.url).toBe('fc:listing/anitoysgk?axis=listing&page=3');
    expect(calls[0].source.itemId).toBe('');
    expect(calls[0].kind).toBe(2); // FETCH_KIND_LISTING
    expect(calls[0].origin).toBe(1); // FETCH_ORIGIN_CRAWLER
  });

  it('trims the message to 1 KB and strips log-forgery characters', async () => {
    const { client, calls } = fakeClient();
    const reporter = new FailureReporter({ client });

    await reporter.report(baseReport({ message: 'a\nb' + 'x'.repeat(4000) }));

    expect(calls[0].message.length).toBe(1024);
    expect(calls[0].message).not.toContain('\n');
  });

  it('omits an absent status, transport and hint rather than sending zeros', async () => {
    const { client, calls } = fakeClient();
    const reporter = new FailureReporter({ client });

    await reporter.report(baseReport());

    expect(calls[0].httpStatus).toBeUndefined();
    expect(calls[0].transport).toBeUndefined();
    expect(calls[0].nextRetryHint).toBeUndefined();
  });

  it('stamps extractedAt from the injected clock when the caller supplies none', async () => {
    const { client, calls } = fakeClient();
    const reporter = new FailureReporter({ client, now: () => 1_700_000_000_000 });

    await reporter.report(baseReport());

    expect(calls[0].source.extractedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe('FailureReporter — cooldown is reported once per window', () => {
  it('reports the first cooldown skip and suppresses the rest of the window', async () => {
    const { client, calls } = fakeClient();
    let clock = 1_000_000;
    const reporter = new FailureReporter({ client, now: () => clock });
    const cooldown = baseReport({ reasonClass: 'cooldown', nextRetryHint: new Date(1_000_000 + 600_000).toISOString() });

    await reporter.report(cooldown);
    await reporter.report(cooldown);
    await reporter.report(cooldown);

    expect(calls).toHaveLength(1);
    expect(fetchFailureReportView().suppressed).toBe(2);
  });

  it('reports again once the window has elapsed', async () => {
    const { client, calls } = fakeClient();
    let clock = 1_000_000;
    const reporter = new FailureReporter({ client, now: () => clock });
    const cooldown = baseReport({ reasonClass: 'cooldown', nextRetryHint: new Date(1_000_000 + 600_000).toISOString() });

    await reporter.report(cooldown);
    clock = 1_000_000 + 600_001;
    await reporter.report(cooldown);

    expect(calls).toHaveLength(2);
  });

  it('keys the window per target, so a second cooling item is still reported', async () => {
    const { client, calls } = fakeClient();
    const reporter = new FailureReporter({ client, now: () => 1_000_000 });
    const hint = new Date(1_600_000).toISOString();

    await reporter.report(baseReport({ reasonClass: 'cooldown', nextRetryHint: hint }));
    await reporter.report(baseReport({ reasonClass: 'cooldown', nextRetryHint: hint, target: 'https://x/2', itemId: '2' }));

    expect(calls).toHaveLength(2);
  });

  it('never suppresses a non-cooldown reason for the same target', async () => {
    const { client, calls } = fakeClient();
    const reporter = new FailureReporter({ client, now: () => 1_000_000 });

    await reporter.report(baseReport({ reasonClass: 'cooldown', nextRetryHint: new Date(1_600_000).toISOString() }));
    await reporter.report(baseReport({ reasonClass: 'timeout' }));

    expect(calls).toHaveLength(2);
  });
});

describe('FailureReporter — best effort', () => {
  it('never throws when the spine refuses the report', async () => {
    const client: FetchFailureClient = {
      reportFetchFailure: async () => {
        throw new ConnectError('bad producer', Code.InvalidArgument);
      },
    };
    const reporter = new FailureReporter({ client });

    await expect(reporter.report(baseReport())).resolves.toBeUndefined();
    expect(fetchFailureReportView().failed).toBe(1);
    expect(fetchFailureReportView().reported).toBe(0);
  });

  it('never throws when the client throws a non-Connect error', async () => {
    const client: FetchFailureClient = {
      reportFetchFailure: async () => {
        throw new TypeError('boom');
      },
    };
    const reporter = new FailureReporter({ client });

    await expect(reporter.report(baseReport())).resolves.toBeUndefined();
    expect(fetchFailureReportView().failed).toBe(1);
  });

  it('retries UNAVAILABLE up to three tries and then gives up quietly', async () => {
    let tries = 0;
    const client: FetchFailureClient = {
      reportFetchFailure: async () => {
        tries++;
        throw new ConnectError('down', Code.Unavailable);
      },
    };
    const reporter = new FailureReporter({ client, retryDelayMs: 0 });

    await reporter.report(baseReport());

    expect(tries).toBe(3);
    expect(fetchFailureReportView().failed).toBe(1);
  });

  it('retries INTERNAL exactly once', async () => {
    let tries = 0;
    const client: FetchFailureClient = {
      reportFetchFailure: async () => {
        tries++;
        throw new ConnectError('server fault', Code.Internal);
      },
    };
    const reporter = new FailureReporter({ client, retryDelayMs: 0 });

    await reporter.report(baseReport());

    expect(tries).toBe(2);
  });

  it('never retries INVALID_ARGUMENT — a producer bug repeats', async () => {
    let tries = 0;
    const client: FetchFailureClient = {
      reportFetchFailure: async () => {
        tries++;
        throw new ConnectError('bad', Code.InvalidArgument);
      },
    };
    const reporter = new FailureReporter({ client, retryDelayMs: 0 });

    await reporter.report(baseReport());

    expect(tries).toBe(1);
  });

  it('counts a successful report', async () => {
    const { client } = fakeClient();
    const reporter = new FailureReporter({ client });

    await reporter.report(baseReport());
    await reporter.report(baseReport({ target: 'https://x/2' }));

    expect(fetchFailureReportView().reported).toBe(2);
    expect(fetchFailureReportView().failed).toBe(0);
  });

  it('refuses a report with no site rather than sending one the spine must reject', async () => {
    const { client, calls } = fakeClient();
    const reporter = new FailureReporter({ client });

    await reporter.report(baseReport({ site: '' }));
    await reporter.report(baseReport({ target: '' }));

    expect(calls).toHaveLength(0);
    expect(fetchFailureReportView().failed).toBe(2);
  });
});

describe('createFailureReporterFromEnv', () => {
  it('is null without INGEST_BASE_URL — reporting is simply off', () => {
    expect(createFailureReporterFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(fetchFailureReportView().enabled).toBe(false);
  });

  it('builds a reporter when the ingest base URL is configured', () => {
    const reporter = createFailureReporterFromEnv({ INGEST_BASE_URL: 'http://spine:50051' } as NodeJS.ProcessEnv);
    expect(reporter).not.toBeNull();
    expect(fetchFailureReportView().enabled).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off'])('is null when REPORT_FETCH_FAILURES=%s', (value) => {
    const reporter = createFailureReporterFromEnv({
      INGEST_BASE_URL: 'http://spine:50051',
      REPORT_FETCH_FAILURES: value,
    } as NodeJS.ProcessEnv);
    expect(reporter).toBeNull();
    expect(fetchFailureReportView().enabled).toBe(false);
  });

  it('defaults to ON when REPORT_FETCH_FAILURES is unset or empty', () => {
    expect(createFailureReporterFromEnv({ INGEST_BASE_URL: 'http://spine:50051' } as NodeJS.ProcessEnv)).not.toBeNull();
    expect(
      createFailureReporterFromEnv({ INGEST_BASE_URL: 'http://spine:50051', REPORT_FETCH_FAILURES: '   ' } as NodeJS.ProcessEnv),
    ).not.toBeNull();
    expect(
      createFailureReporterFromEnv({ INGEST_BASE_URL: 'http://spine:50051', REPORT_FETCH_FAILURES: 'true' } as NodeJS.ProcessEnv),
    ).not.toBeNull();
  });
});

describe('fetchFailureReportView', () => {
  it('starts at zero and is a copy, not the live counter', () => {
    const view = fetchFailureReportView();
    expect(view).toEqual({ enabled: false, reported: 0, failed: 0, suppressed: 0 });
    view.reported = 99;
    expect(fetchFailureReportView().reported).toBe(0);
  });
});

describe('FailureReporter — drain (the CronJob entrypoints exit the moment the pass resolves)', () => {
  /** A client that only answers when the test releases it, on a later macrotask. */
  function gatedClient() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: any[] = [];
    const client: FetchFailureClient = {
      reportFetchFailure: async (message: any) => {
        await gate;
        calls.push(message);
        return { id: 'row-1', attempts: 1, reviewStatus: 2, reopened: false } as any;
      },
    };
    return { client, calls, release };
  }

  it('waits for a fire-and-forget report that has not reached the wire yet', async () => {
    const { client, calls, release } = gatedClient();
    const reporter = new FailureReporter({ client });

    // Exactly what every emit point does: fire, never await.
    void reporter.report(baseReport()).catch(() => {});

    let drained = false;
    const draining = reporter.drain(5_000).then(() => { drained = true; });

    await Promise.resolve();
    expect(drained).toBe(false); // process.exit(0) here would destroy the report
    expect(calls).toHaveLength(0);

    release();
    await draining;
    expect(drained).toBe(true);
    expect(calls).toHaveLength(1);
    expect(fetchFailureReportView().reported).toBe(1);
  });

  it('returns immediately with nothing in flight', async () => {
    const { client } = fakeClient();
    await expect(new FailureReporter({ client }).drain(50)).resolves.toBeUndefined();
  });

  it('gives up at the deadline rather than holding the pass open on a hung spine', async () => {
    const { client } = gatedClient(); // never released
    const reporter = new FailureReporter({ client });
    void reporter.report(baseReport()).catch(() => {});

    const started = Date.now();
    await reporter.drain(20);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('never rejects, even when every in-flight report fails', async () => {
    const client: FetchFailureClient = {
      reportFetchFailure: async () => { throw new ConnectError('nope', Code.InvalidArgument); },
    };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = new FailureReporter({ client });
    void reporter.report(baseReport()).catch(() => {});
    await expect(reporter.drain(1_000)).resolves.toBeUndefined();
    expect(fetchFailureReportView().failed).toBe(1);
  });
});
