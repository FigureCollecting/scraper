/**
 * LG-RUNID: a capture the raw capture sink stores later still logs under the run that admitted it.
 *
 * capture() only queues; a worker stores it later, under the capture's stored traceparent (LG-QUEUE-2). fc-shared 1.9.0
 * stamps run_id (the run's trace id) on every line of a server/job run, but withTraceparent restores ONLY the run it is
 * handed: a sink that keeps the traceparent and not the run loses run_id on every line its worker writes. The sink keeps
 * currentRunId() with each capture and hands it back on the restore.
 *
 * Real pieces: fc-shared tracing (AsyncLocalStorage context), runJob and the server/log logger. The object store is a
 * local fake that writes one log line per HEAD and PUT and holds the first HEAD until the test opens its gate, so
 * captures pile up behind one worker. No timers in the test; nothing leaves the process.
 */
import { runJob, type JobRun } from '@figurecollecting/fc-shared/server/job';
import { createLogger, type Logger } from '@figurecollecting/fc-shared/server/log';
import { startTracing, type Tracing } from '@figurecollecting/fc-shared/server/tracing';
import { buildRawCapture, type RawCapture } from '../../services/captureSink';
import { ObjectStoreCaptureSink, type ObjectStore, type RawStoreConfig } from '../../services/objectStoreCaptureSink';
import { keepingExporter, type Line } from '../helpers/jobTelemetry';

const CONFIG: RawStoreConfig = {
  endpoint: 'https://objects.example.test',
  region: 'test-1',
  bucket: 'raw',
  prefix: 'raw-html/',
  imagePrefix: 'raw-img/',
  keyScheme: 'sha256-v1',
  putTimeoutMs: 5_000,
  imagePutTimeoutMs: 5_000,
  concurrency: 1, // one worker: every capture after the first waits for it
};

const page = (id: string): RawCapture =>
  buildRawCapture({ url: `https://shop.example.test/item/${id}`, lane: 'wire', bytes: Buffer.from(`<html>item ${id}</html>`), statusCode: 200 });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR')]);

const image = (itemId: string): RawCapture =>
  buildRawCapture({
    url: `https://cdn.example.test/img/${itemId}.png`,
    lane: 'asset',
    bytes: Buffer.concat([PNG, Buffer.from(itemId)]),
    statusCode: 200,
    contentType: 'image/png',
    fetchedAt: '2026-10-29T00:00:00.000Z',
    sourceItem: { site: 'shop.example.test', itemId },
  });

/** The page's object key, the way the store sees it. */
const keyOf = (c: RawCapture): string => `raw-html/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.html.gz`;

/** A promise the test resolves by hand. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { opened, open };
}

/** A store that logs one line per HEAD and per PUT; the first HEAD waits for `hold` when one is given. */
class LoggingStore implements ObjectStore {
  private held = false;

  constructor(private readonly log: Logger, private readonly hold?: Promise<void>) {}

  async exists(key: string): Promise<boolean> {
    this.log.info({ event: 'store.head', key }, 'head');
    if (this.hold !== undefined && !this.held) {
      this.held = true;
      await this.hold;
    }
    return false;
  }

  async put(key: string): Promise<void> {
    this.log.info({ event: 'store.put', key }, 'put');
  }
}

let tracing: Tracing;
let lines: string[];
let log: Logger;
/** runJob's own job.start / job.end lines go here, not into `lines`. */
const quiet = createLogger({ sink: () => undefined, env: {} });

beforeAll(() => {
  tracing = startTracing('scraper-sink-runid-test', { env: {}, exporter: keepingExporter() });
});

afterAll(async () => {
  await tracing.shutdown();
});

beforeEach(() => {
  lines = [];
  log = createLogger({ service: 'scraper', version: 'test', sink: line => lines.push(line), env: {} });
});

/** The store's lines whose key passes `match`, as [event, run_id] pairs (run_id 'none' when the line has none). */
function storeLines(match: (key: string) => boolean): Array<[unknown, unknown]> {
  return lines
    .map(l => JSON.parse(l) as Line)
    .filter(l => match(String(l['key'])))
    .map(l => [l['event'], l['run_id'] ?? 'none']);
}

const storeLinesFor = (c: RawCapture): Array<[unknown, unknown]> => storeLines(key => key === keyOf(c));

const inRun = <T>(name: string, fn: (run: JobRun) => T | Promise<T>): Promise<T> => runJob(name, fn, { logger: quiet, env: {} });

describe('ObjectStoreCaptureSink: a stored capture keeps its run (LG-RUNID)', () => {
  it("logs a capture's store lines with the run_id of the run that admitted it, after that run has ended", async () => {
    const sink = new ObjectStoreCaptureSink(new LoggingStore(log), CONFIG);
    const c = page('a1');
    const runId = await inRun('run-a', run => {
      void sink.capture(c);
      return run.runId;
    });
    await sink.flush();

    expect(runId).toMatch(/^[0-9a-f]{32}$/);
    expect(storeLinesFor(c)).toEqual([['store.head', runId], ['store.put', runId]]);
  });

  it("keeps the run of a capture admitted inside one of the run's items (run.item)", async () => {
    const sink = new ObjectStoreCaptureSink(new LoggingStore(log), CONFIG);
    const c = page('i1');
    const runId = await inRun('run-a', async run => {
      await run.item(() => void sink.capture(c));
      return run.runId;
    });
    await sink.flush();

    expect(storeLinesFor(c)).toEqual([['store.head', runId], ['store.put', runId]]);
  });

  it("keeps the run of an image capture, which waits on the asset lane's own queue", async () => {
    const sink = new ObjectStoreCaptureSink(new LoggingStore(log), CONFIG);
    const runId = await inRun('run-a', run => {
      void sink.capture(image('img-1'));
      return run.runId;
    });
    await sink.flush();

    expect(storeLines(key => key.startsWith('raw-img/'))).toEqual([['store.head', runId], ['store.put', runId]]);
  });

  it('logs a capture admitted outside any run with no run_id, though a run admitted the one before it on the same worker', async () => {
    const hold = gate();
    const sink = new ObjectStoreCaptureSink(new LoggingStore(log, hold.opened), CONFIG);
    const first = page('r1');
    const outside = page('o1');
    const runId = await inRun('run-a', run => {
      void sink.capture(first); // starts the only worker, which waits at its HEAD
      return run.runId;
    });
    void sink.capture(outside); // queued behind it, in no run
    hold.open();
    await sink.flush();

    expect(storeLinesFor(first)).toEqual([['store.head', runId], ['store.put', runId]]);
    expect(storeLinesFor(outside)).toEqual([['store.head', 'none'], ['store.put', 'none']]);
  });

  it("logs a capture run A admitted with A's run_id when the worker takes it while run B is active, never B's", async () => {
    const hold = gate();
    const sink = new ObjectStoreCaptureSink(new LoggingStore(log, hold.opened), CONFIG);
    const a1 = page('a1');
    const a2 = page('a2');
    const b1 = page('b1');
    const runA = await inRun('run-a', run => {
      void sink.capture(a1); // the worker takes it and waits at its HEAD
      void sink.capture(a2); // queued behind it
      return run.runId;
    });
    const runB = await inRun('run-b', async run => {
      void sink.capture(b1); // queued behind A's
      // Run B is active while the worker goes on to A's second capture and then B's own.
      hold.open();
      await sink.flush();
      return run.runId;
    });

    expect(runA).not.toBe(runB);
    expect(storeLinesFor(a1)).toEqual([['store.head', runA], ['store.put', runA]]);
    expect(storeLinesFor(a2)).toEqual([['store.head', runA], ['store.put', runA]]);
    expect(storeLinesFor(b1)).toEqual([['store.head', runB], ['store.put', runB]]);
  });
});
