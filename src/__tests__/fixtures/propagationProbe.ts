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
 * It also sends the server one inbound request carrying a traceparent (through impit, which adds nothing of its own)
 * and records the trace the server continued. Prints one line: `PROBE_RESULT <json>`.
 */
import '../../tracing.js';
import 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ROOT_CONTEXT, context, createTraceState, propagation, trace } from '@opentelemetry/api';
import { Impit } from 'impit';
import { IngestEmitter } from '../../services/ingestEmitter.js';
import { CaptureReporter } from '../../services/captureReporter.js';
import { FailureReporter } from '../../services/failureReporter.js';

const PROBE_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

interface Seen {
  path: string;
  host: string;
  traceparent: string | null;
  tracestate: string | null;
  baggage: string | null;
  inboundTraceId?: string | null;
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
        ...(req.url === '/inbound' ? { inboundTraceId: trace.getSpanContext(context.active())?.traceId ?? null } : {}),
      });
      res.writeHead(200, { 'content-type': req.url?.startsWith('/ingest.v1') ? 'application/proto' : 'text/plain' });
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  const parent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: PROBE_TRACE_ID,
    spanId: '00f067aa0ba902b7',
    traceFlags: 1,
    isRemote: true,
    traceState: createTraceState('fc=probe'),
  });
  const active = propagation.setBaggage(parent, propagation.createBaggage({ probe: { value: 'yes' } }));
  const impit = new Impit({ browser: 'chrome' as never });
  const get = (target: string): Promise<void> =>
    new Promise((resolve, reject) => {
      http.get(target, res => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });

  // The spine clients are made outside the trace, as the server makes them (once, before any item); only their calls
  // are made inside it.
  const spines = ['127.0.0.1', 'localhost'].map(host => {
    const base = `http://${host}:${port}`;
    return {
      base,
      emitter: new IngestEmitter({ baseUrl: base, retryDelayMs: 1 }),
      captures: new CaptureReporter({ baseUrl: base, retryDelayMs: 1 }),
      failures: new FailureReporter({ baseUrl: base, retryDelayMs: 1 }),
    };
  });

  await context.with(active, async () => {
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
  });
  await (await impit.fetch(`http://127.0.0.1:${port}/inbound`, { headers: { traceparent: `00-${INBOUND_TRACE_ID}-b7ad6b7169203331-01` } })).text();

  server.close();
  process.stdout.write(`PROBE_RESULT ${JSON.stringify(seen)}\n`);
  process.exit(0);
}

main().catch(error => {
  process.stderr.write(`probe failed: ${String(error)}\n`);
  process.exit(1);
});
