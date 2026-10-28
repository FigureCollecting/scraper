/**
 * The gallery-capture Job on fc-shared's server logging (LG-ADOPT-2): a run is one root trace, one job.start and one
 * job.end carrying the run's exit code and report counts; every line the run prints is a JSON line; a probe's evidence is
 * one line per request, as fields; a crashed run is written once, on job.end (code=error); and no image request carries a
 * traceparent. ONE TRACE PER ITEM (LG-ITEM-1): each worklist item the run captures is its own root trace (item.capture,
 * linked to the run), so its lines and the capture reports it files with the ingest server carry the ITEM's trace; the
 * run's own lines (refusals, the report) stay on the run's. The image host is a fake transport and the ingest server a
 * stand-in on localhost: nothing here reaches a store.
 */
import { startTracing } from '@figurecollecting/fc-shared/server/tracing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGalleryJob } from '../../services/images/galleryJob';
import { buildImageHostPolicy } from '../../services/images/imageHostPolicy';
import type { ImageBytesFetcher } from '../../services/images/imageBytes';
import { CaptureReporter } from '../../services/captureReporter';
import { GALLERY_CAPTURE, createServiceLogger } from '../../telemetry';
import { HEX32, fakeSpine, keepingExporter, parseLines, traceIdOf, type Line } from '../helpers/jobTelemetry';

const HOST = 'img.shop.example';
const U = (n: number) => `https://${HOST}/pictures/${n}.png`;
const item = (id: string, nums: number[]) =>
  JSON.stringify({ site: 'shop', itemId: id, pageUrl: `https://shop.example/item/${id}`, rank: 0, entries: nums.map((n, i) => ({ position: i, src: U(n) })) });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('runGalleryJob', () => {
  let dir: string;
  let work: string;
  let ledger: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-job-'));
    work = path.join(dir, 'wl.jsonl');
    ledger = path.join(dir, 'ledger.jsonl');
    writeFileSync(work, [item('1', [1, 2]), item('2', [3])].join('\n') + '\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sentHeaders: Array<Record<string, string>> = [];
  const deps = (over: Record<string, unknown> = {}) => {
    sentHeaders.length = 0;
    const out: string[] = [];
    const env = {
      IMAGE_HOST_RATE_JSON: JSON.stringify({ [HOST]: { intervalMs: 100 } }), GALLERY_ALLOWED_HOSTS: HOST, RAW_STORE_IMAGE_MAX_BYTES: '10485760',
      GALLERY_LOCK_PATH: path.join(dir, 'gallery-capture.lock'),
    } as NodeJS.ProcessEnv;
    return {
      out,
      lines: (): Line[] => parseLines(out),
      deps: {
        env,
        logger: createServiceLogger(GALLERY_CAPTURE, { env, sink: l => out.push(l) }),
        policy: buildImageHostPolicy({ [HOST]: { lane: 'http', egress: 'direct' } }),
        baseFetch: async (url: string, init?: { headers?: Record<string, string> }) => {
          sentHeaders.push({ ...init?.headers });
          const h = new Map<string, string>([['content-type', 'image/png']]);
          return { status: 200, url, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) };
        },
        makeHook: (fetchBytes: ImageBytesFetcher) => ({
          async capture(req: { ruleset: { describeImages?: (f: Record<string, unknown>) => Array<{ url: string }> }; fields: Record<string, unknown> }) {
            for (const r of req.ruleset.describeImages!(req.fields)) await fetchBytes(r.url, {});
          },
          async drain() { /* nothing in flight */ },
          stats: () => ({ enabled: true, attempted: 0, stored: 0, deduped: 0, failed: 0, residentialBytesToday: 0, skipped: {} }),
        }) as never,
        flush: async () => undefined,
        sink: { flush: async () => undefined, stats: () => ({ assetFailed: 0, dropped: 0, droppedBytes: 0, assetRefusedReserve: 0 }) },
        ...over,
      },
    };
  };

  it('a run is one trace with ONE job.end carrying the exit code and the report counts; each captured item is its own trace', async () => {
    const d = deps();
    const code = await runGalleryJob(['--worklist', work, '--ledger', ledger], d.deps as never);
    expect(code).toBe(0);
    const lines = d.lines();
    expect(lines[0]).toMatchObject({ event: 'job.start', job: 'gallery-capture', service: 'gallery-capture' });
    expect(lines.filter(l => l.event === 'job.end')).toHaveLength(1);
    expect(lines[lines.length - 1]).toMatchObject({
      event: 'job.end', code: 'ok', exit_code: 0, mode: 'run', stopped: 'done', items: 2, planned: 3, fetched: 3, items_with_failures: 0,
    });
    const runId = String(lines[0]?.trace_id);
    expect(HEX32.test(runId)).toBe(true);
    // what the run prints is one note line each, in the shape; the report is still printed for the operator
    const notes = lines.filter(l => l.event === 'gallery.note');
    expect(notes.find(l => String(l.msg).startsWith('GALLERY-REPORT {'))?.trace_id).toBe(runId);
    // an item's own line is on ITS trace: two items, two traces, neither the run's
    const itemLines = notes.filter(l => String(l.msg).startsWith('[gallery] shop/'));
    expect(itemLines.map(l => String(l.msg).split(':')[0])).toEqual(['[gallery] shop/1', '[gallery] shop/2']);
    expect(itemLines.every(l => HEX32.test(String(l.trace_id)))).toBe(true);
    expect(new Set([runId, ...itemLines.map(l => l.trace_id)]).size).toBe(3);
    expect(lines.filter(l => !itemLines.includes(l)).every(l => l.trace_id === runId)).toBe(true);
    // an image host never gets a traceparent
    expect(sentHeaders).toHaveLength(3);
    expect(sentHeaders.every(h => Object.keys(h).every(k => k.toLowerCase() !== 'traceparent'))).toBe(true);
  });

  it('each item is an item.capture root span linked to the run (fc.run_id, fc.site), and its capture report reaches the ingest server on the item\'s trace', async () => {
    const spine = await fakeSpine();
    const exporter = keepingExporter();
    startTracing(GALLERY_CAPTURE, { exporter, env: {} }); // runJobProcess's own start returns this handle and its shutdown flushes it
    try {
      const reporter = new CaptureReporter({ baseUrl: spine.url, retryDelayMs: 0 });
      const d = deps();
      const makeHook = (fetchBytes: ImageBytesFetcher) => {
        const base = (d.deps.makeHook as (f: ImageBytesFetcher) => Record<string, unknown> & { capture: (req: { itemId: string }) => Promise<void> })(fetchBytes);
        return {
          ...base,
          // as the real hook does, once a file is at rest: one capture report per item (lane asset), from inside capture()
          async capture(req: { itemId: string }) {
            await base.capture(req);
            await reporter.report({ url: `https://${HOST}/pictures/${req.itemId}.png`, site: 'shop', itemId: req.itemId, lane: 'asset', storageKey: 'sha256-v1/aa/k', sha256: 'a'.repeat(64), bytesLen: 3 } as never);
          },
        };
      };
      const code = await runGalleryJob(['--worklist', work, '--ledger', ledger], { ...d.deps, makeHook } as never);
      expect(code).toBe(0);
      const lines = d.lines();
      const runSpan = exporter.spans.find(s => s.name === 'job.gallery-capture')!;
      const runId = runSpan.spanContext().traceId;
      expect(lines[0]?.trace_id).toBe(runId);
      const items = exporter.spans.filter(s => s.name === 'item.capture');
      expect(items.map(s => [s.attributes['fc.site'], s.attributes['fc.run_id'], s.links[0]?.context.spanId, s.parentSpanContext]))
        .toEqual([['shop', runId, runSpan.spanContext().spanId, undefined], ['shop', runId, runSpan.spanContext().spanId, undefined]]);
      const itemIds = items.map(s => s.spanContext().traceId);
      expect(new Set([runId, ...itemIds]).size).toBe(3);
      // each item's capture report went to the ingest server with that item's traceparent, and its rpc.out line is on the item
      expect(spine.calls.map(c => [c.path, traceIdOf(c.headers.traceparent)])).toEqual(itemIds.map(id => ['/ingest.v1.SpineIngest/ReportCapture', id]));
      expect(lines.filter(l => l.event === 'rpc.out').map(l => l.trace_id)).toEqual(itemIds);
      expect(sentHeaders.every(h => Object.keys(h).every(k => k.toLowerCase() !== 'traceparent'))).toBe(true);
    } finally {
      await spine.close();
    }
  });

  it('a dry run fetches nothing and opens no item', async () => {
    const exporter = keepingExporter();
    startTracing(GALLERY_CAPTURE, { exporter, env: {} });
    const d = deps();
    expect(await runGalleryJob(['--worklist', work, '--ledger', ledger, '--dry-run'], d.deps as never)).toBe(0);
    expect(exporter.spans.map(s => s.name)).toEqual(['job.gallery-capture']);
    expect(sentHeaders).toEqual([]);
    const runId = String(d.lines()[0]?.trace_id);
    expect(d.lines().every(l => l.trace_id === runId)).toBe(true);
  });

  it('a probe writes its evidence as one line per request, as fields, and no array line', async () => {
    const d = deps();
    const code = await runGalleryJob(['--worklist', work, '--ledger', ledger, '--probe', '3'], d.deps as never);
    expect(code).toBe(0);
    const lines = d.lines();
    const evidence = lines.filter(l => l.event === 'gallery.probe_evidence');
    expect(evidence).toHaveLength(3);
    expect(evidence.map(e => [e.lane, e.status, e.outcome])).toEqual([['http', 200, 'ok'], ['http', 200, 'ok'], ['http', 200, 'ok']]);
    expect(evidence.every(e => String(e.path).startsWith('/pictures/') && !String(e.sent_header_names).includes('traceparent'))).toBe(true);
    // the Set-Cookie flag survives as sets_state (a key naming a cookie would be masked whole)
    expect(evidence.every(e => e.sets_state === false && !('set_cookie' in e))).toBe(true);
    expect(lines.some(l => String(l.msg).startsWith('PROBE-EVIDENCE'))).toBe(false);
    expect(lines.some(l => l.event === 'gallery.note' && l.msg === 'PROBE PASS')).toBe(true);
    expect(lines[lines.length - 1]).toMatchObject({ event: 'job.end', code: 'ok', exit_code: 0, mode: 'probe', probe_verdict: 'PASS' });
  });

  it('a refusal is a warn line and the run ends ok with its exit code; a proxy credential in the env is never printed', async () => {
    const d = deps();
    const env = { ...d.deps.env, HTTPS_PROXY: 'http://exit:PROXYSECRET8@proxy.example:3128' } as NodeJS.ProcessEnv;
    const code = await runGalleryJob(['--worklist', work, '--ledger', ledger], { ...d.deps, env } as never);
    expect(code).toBe(2);
    const lines = d.lines();
    expect(lines.find(l => String(l.msg).startsWith('REFUSED: the environment sets HTTPS_PROXY'))).toMatchObject({ level: 'warn', event: 'gallery.note' });
    expect(lines[lines.length - 1]).toMatchObject({ event: 'job.end', code: 'ok', exit_code: 2 });
    expect('items' in lines[lines.length - 1]!).toBe(false);
    expect(d.out.join('\n')).not.toContain('PROXYSECRET8');
    expect(sentHeaders).toEqual([]);
  });

  it('with no deps it reads process.env and writes to stdout: a run with no allowed host is refused, exit 2, before any request', async () => {
    const saved = process.env.GALLERY_ALLOWED_HOSTS;
    delete process.env.GALLERY_ALLOWED_HOSTS;
    const written: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true; });
    let code: number;
    try {
      code = await runGalleryJob(['--worklist', work, '--dry-run']);
    } finally {
      write.mockRestore();
      if (saved !== undefined) process.env.GALLERY_ALLOWED_HOSTS = saved;
    }
    expect(code).toBe(2);
    const lines = parseLines(written.map(chunk => chunk.trimEnd()));
    expect(lines.map(l => l.event)).toEqual(['job.start', 'gallery.note', 'job.end']);
    expect(String(lines[1]?.msg)).toMatch(/GALLERY_ALLOWED_HOSTS must name the image host/);
    expect(lines[2]).toMatchObject({ service: 'gallery-capture', code: 'ok', exit_code: 2 });
  });

  it('a crashed run is written once, on job.end (code=error), and rejects so the entry exits 1', async () => {
    const d = deps({ makeHook: () => { throw new Error('hook could not be built'); } });
    await expect(runGalleryJob(['--worklist', work, '--ledger', ledger], d.deps as never)).rejects.toThrow('gallery:capture failed: hook could not be built');
    const lines = d.lines();
    expect(lines.filter(l => String(l.msg).includes('hook could not be built') || String((l.err as { message?: string } | undefined)?.message).includes('hook could not be built'))).toHaveLength(1);
    expect(lines[lines.length - 1]).toMatchObject({ event: 'job.end', level: 'error', code: 'error', err: { message: 'gallery:capture failed: hook could not be built' } });
  });
});
