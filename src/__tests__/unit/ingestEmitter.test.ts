/**
 * IngestEmitter tests — wire-mapping fidelity + retry classification against
 * an IN-PROCESS SpineIngest server (connectNodeAdapter on node:http, real
 * Connect-over-HTTP/1.1 on an ephemeral localhost port — the same cleartext
 * HTTP/1.1 the production spine serves, so Linkerd can mesh it). Nothing is
 * mocked at the transport boundary: what the stub service captures is exactly
 * what the spine's real server would decode.
 *
 * Fidelity contract under test (mirrors @figurecollecting/ingest-contract):
 *   - fields_json is the EXACT JSON text of the fields object
 *   - extracted_at passes through byte-identical (raw token, never parsed)
 *   - warnings travel verbatim
 *   - optional source fields (url, rulesetVersion) are ABSENT when absent
 * Retry contract:
 *   - Unavailable  -> bounded exponential backoff (3 tries total)
 *   - InvalidArgument -> NEVER retried (producer bug, loud log)
 *   - Internal     -> at most ONE delayed retry, loud log
 *   - anything else (e.g. DeadlineExceeded) -> no retry
 *   - SUCCESS = RPC resolved OK, even when stats report zero inserts
 */
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  SpineIngest,
  WriteStatsSchema,
  type ExtractedData as WireExtractedData,
  type WriteStats,
} from '@figurecollecting/ingest-contract';
import type { ExtractedData } from '@figurecollecting/scraper-plugin-contract';
import { IngestEmitter, createIngestEmitterFromEnv } from '../../services/ingestEmitter';

type StubImpl = (req: WireExtractedData) => Promise<WriteStats> | WriteStats;

const okStats = (): WriteStats =>
  create(WriteStatsSchema, { sourceId: '11111111-2222-3333-4444-555555555555' });

interface StubServer {
  baseUrl: string;
  captured: WireExtractedData[];
  callCount: () => number;
  close: () => Promise<void>;
}

/** In-process SpineIngest stub: real HTTP/1.1 server, ephemeral port. */
async function startStub(impl: StubImpl): Promise<StubServer> {
  const captured: WireExtractedData[] = [];
  let calls = 0;

  const routes = (router: ConnectRouter) => {
    router.service(SpineIngest, {
      ingest: async (req: WireExtractedData) => {
        calls++;
        captured.push(req);
        return impl(req);
      },
    });
  };

  // Plain node:http server — the same cleartext HTTP/1.1 the production spine
  // (main.ts) serves, and what the emitter's Connect/HTTP/1.1 transport speaks.
  // (A cleartext http2 server, even with allowHTTP1, cannot serve an h1 client:
  // it sends the h2 SETTINGS preface immediately.) Connect keeps the socket
  // alive, so teardown tracks raw connections and destroys them — otherwise
  // server.close() would hang on an idle keep-alive socket.
  const server = http.createServer(connectNodeAdapter({ routes }));
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    callCount: () => calls,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

const codeOf = async (p: Promise<unknown>): Promise<Code | 'OK'> => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return ConnectError.from(e).code;
  }
};

describe('IngestEmitter', () => {
  let stub: StubServer | null = null;

  afterEach(async () => {
    if (stub) {
      await stub.close();
      stub = null;
    }
  });

  const makeEmitter = (baseUrl: string, overrides: Record<string, unknown> = {}) =>
    new IngestEmitter({ baseUrl, timeoutMs: 5000, retryDelayMs: 1, ...overrides });

  describe('wire mapping fidelity', () => {
    it('maps source 1:1, fields as exact JSON text, and warnings verbatim', async () => {
      stub = await startStub(() => okStats());
      const emitter = makeEmitter(stub.baseUrl);

      const fields = {
        name: 'Kitagawa Marin',
        jan: '4530956107891',
        // precision-bearing raw token beyond float64 — must survive as string
        productCode: '9007199254740993',
        releases: [{ date: '2026-06-01', price: '25,000' }],
      };
      const extracted: ExtractedData = {
        source: {
          site: 'mfc',
          itemId: '1450976',
          url: 'https://myfigurecollection.net/item/1450976',
          extractedAt: '2026-06-15T00:00:00.123456Z',
          rulesetVersion: 'mfc@1.2',
        },
        fields,
        warnings: ['producer saw layout drift', 'µs precision noted'],
      };

      await emitter.send(extracted);

      expect(stub.captured).toHaveLength(1);
      const wire = stub.captured[0];
      expect(wire.source?.site).toBe('mfc');
      expect(wire.source?.itemId).toBe('1450976');
      expect(wire.source?.url).toBe('https://myfigurecollection.net/item/1450976');
      expect(wire.source?.rulesetVersion).toBe('mfc@1.2');
      // fields_json is the EXACT JSON text of ONE JSON object
      expect(wire.fieldsJson).toBe(JSON.stringify(fields));
      // warnings pass through verbatim
      expect([...wire.warnings]).toEqual(['producer saw layout drift', 'µs precision noted']);
    });

    it('passes extractedAt through byte-identical, even a weird-but-PG-valid token', async () => {
      stub = await startStub(() => okStats());
      const emitter = makeEmitter(stub.baseUrl);

      await emitter.send({
        source: { site: 'mfc', itemId: '1', extractedAt: '20260605T090000Z' },
        fields: {},
        warnings: [],
      });

      // raw string token: never parsed, never reformatted
      expect(stub.captured[0].source?.extractedAt).toBe('20260605T090000Z');
    });

    it('leaves optional url and rulesetVersion ABSENT on the wire when absent', async () => {
      stub = await startStub(() => okStats());
      const emitter = makeEmitter(stub.baseUrl);

      await emitter.send({
        source: { site: 'amiami', itemId: 'FIGURE-999', extractedAt: '2026-07-24T00:00:00.000Z' },
        fields: { name: 'x' },
        warnings: [],
      });

      expect(stub.captured[0].source?.url).toBeUndefined();
      expect(stub.captured[0].source?.rulesetVersion).toBeUndefined();
    });

    it('treats an all-deduped WriteStats (inserted=0) as SUCCESS and returns it', async () => {
      // post-commit retry legitimately returns deduped counts — that is success
      stub = await startStub(() =>
        create(WriteStatsSchema, {
          sourceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          claims: { emitted: 12, inserted: 0, deduped: 12, quarantined: 0, dropped: 0 },
        })
      );
      const emitter = makeEmitter(stub.baseUrl);

      const stats = await emitter.send({
        source: { site: 'mfc', itemId: '2', extractedAt: '2026-07-24T00:00:00.000Z' },
        fields: { name: 'dupe' },
        warnings: [],
      });

      expect(stats.claims?.inserted).toBe(0);
      expect(stats.claims?.deduped).toBe(12);
      // productId absent (unstorable anchor) is a valid success shape
      expect(stats.productId).toBeUndefined();
      expect(stub.callCount()).toBe(1);
    });
  });

  describe('retry classification', () => {
    const sample: ExtractedData = {
      source: { site: 'mfc', itemId: '3', extractedAt: '2026-07-24T00:00:00.000Z' },
      fields: { name: 'retry probe' },
      warnings: [],
    };

    it('retries UNAVAILABLE with backoff and succeeds on a later attempt', async () => {
      let failures = 2;
      stub = await startStub(() => {
        if (failures-- > 0) throw new ConnectError('spine unavailable', Code.Unavailable);
        return okStats();
      });
      const emitter = makeEmitter(stub.baseUrl);

      const stats = await emitter.send(sample);
      expect(stats.sourceId).toBe('11111111-2222-3333-4444-555555555555');
      expect(stub.callCount()).toBe(3);
    });

    it('gives up on UNAVAILABLE after 3 total tries', async () => {
      stub = await startStub(() => {
        throw new ConnectError('spine unavailable', Code.Unavailable);
      });
      const emitter = makeEmitter(stub.baseUrl);

      await expect(codeOf(emitter.send(sample))).resolves.toBe(Code.Unavailable);
      expect(stub.callCount()).toBe(3);
    });

    it('NEVER retries INVALID_ARGUMENT and logs it loudly (producer bug)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      stub = await startStub(() => {
        throw new ConnectError('fields_json is not valid JSON text', Code.InvalidArgument);
      });
      const emitter = makeEmitter(stub.baseUrl);

      await expect(codeOf(emitter.send(sample))).resolves.toBe(Code.InvalidArgument);
      expect(stub.callCount()).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('producer bug'));
    });

    it('retries INTERNAL at most once, then fails', async () => {
      stub = await startStub(() => {
        throw new ConnectError('ingest failed: broken', Code.Internal);
      });
      const emitter = makeEmitter(stub.baseUrl);

      await expect(codeOf(emitter.send(sample))).resolves.toBe(Code.Internal);
      expect(stub.callCount()).toBe(2);
    });

    it('recovers when INTERNAL clears on the single delayed retry', async () => {
      let first = true;
      stub = await startStub(() => {
        if (first) {
          first = false;
          throw new ConnectError('ingest failed: transient', Code.Internal);
        }
        return okStats();
      });
      const emitter = makeEmitter(stub.baseUrl);

      const stats = await emitter.send(sample);
      expect(stats.sourceId).toBe('11111111-2222-3333-4444-555555555555');
      expect(stub.callCount()).toBe(2);
    });

    it('applies the per-call timeout and does NOT retry deadline expiry', async () => {
      stub = await startStub(async () => {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return okStats();
      });
      const emitter = makeEmitter(stub.baseUrl, { timeoutMs: 100 });

      await expect(codeOf(emitter.send(sample))).resolves.toBe(Code.DeadlineExceeded);
      expect(stub.callCount()).toBe(1);
    });
  });

  describe('createIngestEmitterFromEnv', () => {
    it('returns null when INGEST_BASE_URL is unset (new path disabled)', () => {
      expect(createIngestEmitterFromEnv({})).toBeNull();
      expect(createIngestEmitterFromEnv({ INGEST_BASE_URL: '' })).toBeNull();
    });

    it('builds an emitter when INGEST_BASE_URL is set', () => {
      const emitter = createIngestEmitterFromEnv({ INGEST_BASE_URL: 'http://spine.internal:50051' });
      expect(emitter).toBeInstanceOf(IngestEmitter);
    });
  });
});
