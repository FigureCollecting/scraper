/**
 * Child-process probe for tracingPropagation.test.ts (run under tsx with NODE_ENV=production; never by jest itself).
 *
 * Loads the SERVICE's tracing the way src/index.ts does (first import), then express (CommonJS: its require of
 * node:http is what lets the http instrumentation patch node:http in this ESM process, as in the server), and makes
 * the kinds of outgoing requests the service makes from inside an active trace that also carries tracestate and
 * baggage: global fetch (undici: store pages, image bytes), node:http (CommonJS clients such as the object store's),
 * impit (the native TLS-impersonation lane) and the spine's Ingest, ReportCapture and ReportFetchFailure calls (Connect
 * over HTTP/1.1, through the real emitter and ledger reporters). They all go to a local
 * server that records the W3C headers each request arrived with. 127.0.0.1 stands in for a store, CDN or image host
 * (not on the propagation allowlist), localhost for an in-cluster host (on it).
 *
 * It makes the same requests again inside a run (fc-shared's run key, fc.run_id), under paths prefixed /run.
 *
 * It also sends the server inbound requests (through impit, which adds nothing of its own): one carrying a
 * traceparent, one also carrying the run as baggage fc.run_id, and records the trace and the run the server's handler
 * saw. Then it POSTs /ingest/scrape to the real ingest route over a real ScrapeQueue on a durable store in a temp dir,
 * once with a run in the baggage and once without, and reads back each row's queue_items.run_id. The queue is in test
 * mode, so an enqueue writes its row and never starts the dispatch loop: nothing is fetched.
 * Prints two lines: `PROBE_RESULT <json>` (every request the recording server saw) and `PROBE_QUEUE <json>`.
 */
import '../../tracing.js';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT_CONTEXT, context, createTraceState, propagation, trace, type SpanContext } from '@opentelemetry/api';
import { currentRunId, withTraceparent } from '@figurecollecting/fc-shared/server/job';
import type { ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';
import { Impit } from 'impit';
import { IngestEmitter } from '../../services/ingestEmitter.js';
import { CaptureReporter } from '../../services/captureReporter.js';
import { FailureReporter } from '../../services/failureReporter.js';
import { createIngestRouter } from '../../routes/ingest.js';
import { ScrapeQueue } from '../../services/scrapeQueue.js';
import { QUEUE_DB_FILE, openQueueStore } from '../../services/queueStore.js';

const PROBE_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const RUN_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SHOP = 'shop.example.test';

interface Seen {
  path: string;
  host: string;
  traceparent: string | null;
  tracestate: string | null;
  baggage: string | null;
  inboundTraceId?: string | null;
  inboundRunId?: string | null;
  inboundBaggageKeys?: string[];
}

/** Matches every probe url; the queue never runs it (test mode). */
const RULESET: ExtractionRuleset = {
  siteId: 'probe-shop',
  version: '1.0.0',
  extract: () => {
    throw new Error('the probe never processes an item');
  },
  validate: () => ({ valid: true, errors: [], warnings: [] }),
};

/** POST /ingest/scrape through the real route into a durable queue; each url's status and stored run_id. */
async function probeIngestRoute(impit: Impit): Promise<Array<{ url: string; status: number; runId: string | null }>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propagation-probe-queue-'));
  const queue = new ScrapeQueue(true);
  queue.setQueueStore(openQueueStore({ dir }));
  queue.setIngestEmitter({ send: async () => undefined });
  queue.setPluginRegistry({ getRulesetForUrl: url => (new URL(url).hostname === SHOP ? RULESET : undefined), allStores: () => [] });
  const app = express();
  app.use(express.json());
  app.use('/', createIngestRouter(() => queue));
  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    const statuses = new Map<string, number>();
    for (const [item, baggage] of [['in-run', `fc.run_id=${RUN_ID}`], ['no-run', undefined]] as const) {
      const url = `https://${SHOP}/item/${item}`;
      const res = await impit.fetch(`http://127.0.0.1:${port}/ingest/scrape`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          traceparent: `00-${INBOUND_TRACE_ID}-b7ad6b7169203331-01`,
          ...(baggage === undefined ? {} : { baggage }),
        },
        body: JSON.stringify({ url }),
      });
      await res.text();
      statuses.set(url, res.status);
    }
    queue.closeQueueStore();
    const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE), { readOnly: true });
    const rows = db.prepare('SELECT url, run_id FROM queue_items ORDER BY url').all() as unknown as Array<{ url: string; run_id: string | null }>;
    db.close();
    return rows.map(r => ({ url: r.url, status: statuses.get(r.url) ?? 0, runId: r.run_id }));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const h = req.headers;
      seen.push({
        path: req.url ?? '',
        host: String(h.host).replace(/:\d+$/, ''),
        traceparent: (h.traceparent as string | undefined) ?? null,
        tracestate: (h.tracestate as string | undefined) ?? null,
        baggage: (h.baggage as string | undefined) ?? null,
        ...(req.url?.startsWith('/inbound')
          ? {
              inboundTraceId: trace.getSpanContext(context.active())?.traceId ?? null,
              inboundRunId: currentRunId() ?? null,
              inboundBaggageKeys: (propagation.getBaggage(context.active())?.getAllEntries() ?? []).map(([key]) => key),
            }
          : {}),
      });
      res.writeHead(200, { 'content-type': req.url?.includes('/ingest.v1.') ? 'application/proto' : 'text/plain' });
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  const probeSpan: SpanContext = {
    traceId: PROBE_TRACE_ID,
    spanId: '00f067aa0ba902b7',
    traceFlags: 1,
    isRemote: true,
    traceState: createTraceState('fc=probe'),
  };
  const probeBaggage = propagation.createBaggage({ probe: { value: 'yes' } });
  const active = propagation.setBaggage(trace.setSpanContext(ROOT_CONTEXT, probeSpan), probeBaggage);
  // The same trace and baggage inside a run, as the queue restores an item's run (withTraceparent's runId).
  const inRun = withTraceparent(
    `00-${PROBE_TRACE_ID}-00f067aa0ba902b7-01`,
    () => propagation.setBaggage(trace.setSpanContext(context.active(), probeSpan), probeBaggage),
    { runId: RUN_ID },
  );
  const impit = new Impit({ browser: 'chrome' as never });
  const get = (target: string): Promise<void> =>
    new Promise((resolve, reject) => {
      http.get(target, res => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });

  // The spine clients are made outside the trace, as the server makes them (once, before any item); only their calls
  // are made inside it. `prefix` keeps the run's requests apart from the others.
  const spinesAt = (prefix: string) => ['127.0.0.1', 'localhost'].map(host => {
    const base = `http://${host}:${port}${prefix}`;
    return {
      base,
      emitter: new IngestEmitter({ baseUrl: base, retryDelayMs: 1 }),
      captures: new CaptureReporter({ baseUrl: base, retryDelayMs: 1 }),
      failures: new FailureReporter({ baseUrl: base, retryDelayMs: 1 }),
    };
  });

  const callEverything = async (spines: ReturnType<typeof spinesAt>): Promise<void> => {
    for (const { base, emitter, captures, failures } of spines) {
      await (await fetch(`${base}/fetch`)).text();
      await get(`${base}/http`);
      await (await impit.fetch(`${base}/impit`)).text();
      await emitter.send({
        source: { site: 'probe', itemId: '1', extractedAt: '2026-10-28T00:00:00Z' },
        fields: {},
        warnings: [],
      });
      const sha = 'ab'.repeat(32);
      await captures.report({
        site: 'probe', itemId: '1', url: `${base}/img/1.png`, lane: 'asset', sha256: sha, bytesLen: 1,
        storageKey: `raw-img/sha256/ab/${sha}.png`, fetchedAt: '2026-10-28T00:00:00Z', alreadyStored: false,
      });
      await failures.report({
        site: 'probe', itemId: '1', target: `${base}/item/1`, kind: 'record', origin: 'ingest', reasonClass: 'timeout',
      });
    }
  };
  const plain = spinesAt('');
  const run = spinesAt('/run');
  await context.with(active, () => callEverything(plain));
  await context.with(inRun, () => callEverything(run));
  const inbound = `00-${INBOUND_TRACE_ID}-b7ad6b7169203331-01`;
  await (await impit.fetch(`http://127.0.0.1:${port}/inbound`, { headers: { traceparent: inbound } })).text();
  await (await impit.fetch(`http://127.0.0.1:${port}/inbound-run`, { headers: { traceparent: inbound, baggage: `fc.run_id=${RUN_ID},k=v` } })).text();
  const queued = await probeIngestRoute(impit);

  server.close();
  process.stdout.write(`PROBE_RESULT ${JSON.stringify(seen)}\n`);
  process.stdout.write(`PROBE_QUEUE ${JSON.stringify(queued)}\n`);
  process.exit(0);
}

main().catch(error => {
  process.stderr.write(`probe failed: ${String(error)}\n`);
  process.exit(1);
});
