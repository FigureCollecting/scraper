/**
 * Loopback fixtures and a real-CLI runner for the gallery job (MFC-GALLERY-2, red-team round 1).
 *
 * Everything here is 127.0.0.1 inside the test process; NOTHING contacts an external host. The Job entry is the real one
 * (`galleryCaptureCli.ts`, run as a child process under tsx), so a test sees what the pod sees: the real global fetch, the
 * env-built capture hook, the real ObjectStoreCaptureSink (minio client) against a fake S3, and the real flush.
 *
 *   A   the "allowed host" (reached as http://localhost:<port>); behaviour is chosen by the first path segment
 *   B   an off-host target (reached as http://127.0.0.1:<port>), standing in for an internal service
 *   S3  a fake S3 endpoint: HEAD 404, PUT 200, with modes ok | fail500 | slow
 *   ING a fake spine ingest endpoint that records every ReportCapture body
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export interface Seen {
  method: string;
  path: string;
  host: string;
  headers: http.IncomingHttpHeaders;
  /** ms since an arbitrary start, monotonic: for gaps between requests. */
  t: number;
}
export interface Put { path: string; bytes: number; meta: Record<string, string>; replied: boolean; t: number }

const clock = (): number => Number(process.hrtime.bigint() / 1_000n) / 1000;

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]!) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A valid 1x1 PNG of exactly `size` bytes (padding in a tEXt chunk), unique per tag. */
export function pngOfSize(tag: string, size: number): Buffer {
  const base = png(tag);
  const pad = Math.max(0, size - base.length);
  const ihdr = base.subarray(8, 8 + 25);
  const text = chunk('tEXt', Buffer.concat([Buffer.from(`k\0${tag}`), Buffer.alloc(pad, 0x61)]));
  const idat = base.subarray(8 + 25 + (12 + `k\0${tag}`.length), base.length - 12);
  return Buffer.concat([base.subarray(0, 8), ihdr, text, idat, base.subarray(base.length - 12)]);
}
/** A valid 1x1 PNG made unique per tag by a tEXt chunk, so each file has its own sha256. */
export function png(tag: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`k\0${tag}`)),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(2))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export type S3Mode = 'ok' | 'fail500' | { slowMs: number };

export interface Loopback {
  portA: number;
  /** A second port on the SAME host name as A (`localhost`): a different origin. */
  portA2: number;
  portB: number;
  portS3: number;
  portIng: number;
  /** Requests A and B saw, in order. */
  a: Seen[];
  a2: Seen[];
  b: Seen[];
  /** Every S3 request (HEAD and PUT) and the PUTs alone. */
  s3: Seen[];
  puts: Put[];
  /** The ReportCapture bodies (latin1, so a test can look for ids and urls inside the protobuf). */
  ing: string[];
  setS3(mode: S3Mode): void;
  /** `http://localhost:<portA>/<path>`. */
  urlA(p: string): string;
  close(): Promise<void>;
}

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

export async function startLoopback(initialS3: S3Mode = 'ok'): Promise<Loopback> {
  const lb: Partial<Loopback> & { a: Seen[]; a2: Seen[]; b: Seen[]; s3: Seen[]; puts: Put[]; ing: string[] } = { a: [], a2: [], b: [], s3: [], puts: [], ing: [] };
  let s3mode: S3Mode = initialS3;
  const seen = (req: http.IncomingMessage): Seen => ({ method: req.method ?? '', path: req.url ?? '', host: req.headers.host ?? '', headers: req.headers, t: clock() });

  const A = http.createServer((req, res) => {
    lb.a.push(seen(req));
    const u = new URL(req.url ?? '/', 'http://x');
    const m = /^\/([a-z0-9-]+)\/(.*)$/.exec(u.pathname);
    const kind = m?.[1] ?? '';
    const rest = m?.[2] ?? '';
    const img = (): void => {
      const b = png(`A:${rest}`);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': b.length });
      res.end(b);
    };
    switch (kind) {
      case 'img': return img();
      // a redirect to an OFF-HOST target (127.0.0.1 is not the allowed host `localhost`)
      case 'redir': res.writeHead(302, { location: `http://127.0.0.1:${(B.address() as { port: number }).port}/stolen/${rest}` }); return void res.end();
      // a redirect to ANOTHER PORT on the allowed host name (a different origin)
      case 'redir-port': res.writeHead(302, { location: `http://localhost:${(A2.address() as { port: number }).port}/stolen/${rest}` }); return void res.end();
      // a redirect whose Location carries credentials
      case 'redir-userinfo': res.writeHead(302, { location: `http://user:hunter2@localhost:${(A.address() as { port: number }).port}/img/${rest}` }); return void res.end();
      // a picture of an exact size: bigimg/<bytes>/<tag>
      case 'bigimg': {
        const bytes = Number(rest.split('/')[0]);
        const b = pngOfSize(`A:${rest}`, bytes);
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': b.length });
        return void res.end(b);
      }
      case 'redir-same': res.writeHead(302, { location: `/img/${rest}` }); return void res.end();
      case 'redir-chain': {
        const k = Number(rest.split('/')[0]);
        const tail = rest.split('/').slice(1).join('/');
        res.writeHead(302, { location: k > 1 ? `/redir-chain/${k - 1}/${tail}` : `/img/${tail}` });
        return void res.end();
      }
      case 'redir-loop': res.writeHead(302, { location: `/redir-loop/${rest}` }); return void res.end();
      case 's403': res.writeHead(403, { 'content-type': 'text/html' }); return void res.end('<html>forbidden</html>');
      case 's429': res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' }); return void res.end('slow down');
      case 's500': res.writeHead(500); return void res.end();
      case 'gone': res.writeHead(404); return void res.end();
      case 'html': res.writeHead(200, { 'content-type': 'text/html' }); return void res.end('<html>age gate</html>');
      case 'cf': res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }); return void res.end('<html>Just a moment...</html>');
      // a declared length over the 32 MiB cap: refused before the body is read
      case 'big-cl': res.writeHead(200, { 'content-type': 'image/png', 'content-length': 40 * 1024 * 1024 }); res.write(png(`A:${rest}`)); setTimeout(() => res.destroy(), 300); return;
      case 'slow': return void setTimeout(img, 1500);
      default: res.writeHead(404); return void res.end();
    }
  });

  const A2 = http.createServer((req, res) => {
    lb.a2.push(seen(req));
    const b = png(`A2:${req.url ?? ''}`);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': b.length });
    res.end(b);
  });

  const B = http.createServer((req, res) => {
    lb.b.push(seen(req));
    const b = png(`B:${req.url ?? ''}`);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': b.length });
    res.end(b);
  });

  const S3 = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const meta = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('x-amz-meta-')).map(([k, v]) => [k, String(v)]));
      lb.s3.push(seen(req));
      const put: Put | undefined = req.method === 'PUT' ? { path: req.url ?? '', bytes: body.length, meta, replied: false, t: clock() } : undefined;
      if (put) lb.puts.push(put);
      const reply = (): void => {
        if (req.method === 'HEAD') { res.writeHead(404); return void res.end(); }
        if (req.method === 'PUT') {
          if (s3mode === 'fail500') {
            res.writeHead(500, { 'content-type': 'application/xml' });
            return void res.end('<?xml version="1.0"?><Error><Code>InternalError</Code><Message>x</Message></Error>');
          }
          put!.replied = true;
          res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` });
          return void res.end();
        }
        if (req.method === 'GET' && /location/.test(req.url ?? '')) {
          res.writeHead(200, { 'content-type': 'application/xml' });
          return void res.end('<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>');
        }
        res.writeHead(200);
        res.end();
      };
      if (typeof s3mode === 'object' && req.method === 'PUT') setTimeout(reply, s3mode.slowMs);
      else reply();
    });
  });

  const ING = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lb.ing.push(Buffer.concat(chunks).toString('latin1'));
      res.writeHead(200, { 'content-type': 'application/proto' });
      res.end();
    });
  });

  const [portA, portA2, portB, portS3, portIng] = await Promise.all([listen(A), listen(A2), listen(B), listen(S3), listen(ING)]);
  const servers = [A, A2, B, S3, ING];
  const closeAll = async (): Promise<void> => {
    for (const s of servers) s.closeAllConnections();
    await Promise.all(servers.map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  };
  return Object.assign(lb, {
    portA, portA2, portB, portS3, portIng,
    setS3: (m: S3Mode) => { s3mode = m; },
    urlA: (p: string) => `http://localhost:${portA}/${p}`,
    close: closeAll,
  }) as Loopback;
}

export interface WorklistSpec {
  id: number | string;
  level?: unknown;
  /** Paths on A; each becomes http://localhost:<portA>/<path>. */
  paths?: string[];
  /** Verbatim entries (a src may be any string). */
  entries?: Array<Record<string, unknown>>;
}

export function writeWorklist(lb: Loopback, file: string, specs: WorklistSpec[]): void {
  const lines = specs.map(s => JSON.stringify({
    site: 'shop', itemId: String(s.id), pageUrl: `https://item-page.invalid/item/${s.id}`, rank: 0,
    ...(s.level !== undefined ? { contentLevel: s.level } : {}),
    entries: s.entries ?? (s.paths ?? []).map((p, i) => ({ position: i, src: lb.urlA(p), w: 600, h: 600 })),
  }));
  writeFileSync(file, `${lines.join('\n')}\n`);
}

/** The env the real Job entry needs to run against the loopback: both hosts on the plain http lane, an explicit 100 ms rate row each, A's origin allowed. */
export function cliEnv(lb: Loopback, over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PERSIST_RAW_IMAGES: 'true',
    RAW_STORE_S3_ENDPOINT: `http://127.0.0.1:${lb.portS3}`,
    RAW_STORE_S3_BUCKET: 'loopback',
    RAW_STORE_S3_ACCESS_KEY_ID: 'fixture-key',
    RAW_STORE_S3_SECRET_ACCESS_KEY: 'fixture-not-a-secret',
    RAW_STORE_S3_PATH_STYLE: 'true',
    IMAGE_HOST_POLICY_JSON: JSON.stringify({ localhost: { lane: 'http', egress: 'direct' }, '127.0.0.1': { lane: 'http', egress: 'direct' } }),
    IMAGE_HOST_RATE_JSON: JSON.stringify({ localhost: { intervalMs: 100 }, '127.0.0.1': { intervalMs: 100 } }),
    // an ORIGIN: the allowed host name and A's port (a bare host would allow only the default ports)
    GALLERY_ALLOWED_HOSTS: `localhost:${lb.portA}`,
    // the store's own size cap is part of the Job's env (the Deployment's value); the run refuses to start without it
    RAW_STORE_IMAGE_MAX_BYTES: '10485760',
    GALLERY_SOURCE_CLASS: 'manufacturer_press',
    NODE_OPTIONS: '--dns-result-order=ipv4first',
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

const REPO = path.resolve(__dirname, '../../..');
const ENTRY = 'src/services/images/galleryCaptureCli.ts';

export interface CliRun {
  child: ChildProcess;
  out: () => string;
  /** Resolves with the matching line's text once it has been printed. */
  waitFor(re: RegExp, ms?: number): Promise<string>;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>;
}

/** Start the real Job entry. Nothing it prints is ever dropped: `out()` is stdout and stderr together. */
export function startCli(args: string[], env: NodeJS.ProcessEnv): CliRun {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, ...args], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const waiters: Array<{ re: RegExp; resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  const feed = (d: Buffer): void => {
    buf += d.toString('utf8');
    for (const w of [...waiters]) {
      const m = w.re.exec(buf);
      if (m) {
        clearTimeout(w.timer);
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m[0]);
      }
    }
  };
  child.stdout!.on('data', feed);
  child.stderr!.on('data', feed);
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>(resolve => {
    child.on('close', (code, signal) => {
      for (const w of waiters) { clearTimeout(w.timer); w.reject(new Error(`the CLI ended before ${w.re}: ${buf.slice(-400)}`)); }
      resolve({ code, signal, out: buf });
    });
  });
  return {
    child,
    out: () => buf,
    waitFor: (re, ms = 30_000) => new Promise<string>((resolve, reject) => {
      const m = re.exec(buf);
      if (m) return resolve(m[0]);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${re}: ${buf.slice(-400)}`)), ms);
      waiters.push({ re, resolve, reject, timer });
    }),
    done,
  };
}

export async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; report: Record<string, unknown> | undefined }> {
  const r = await startCli(args, env).done;
  const line = /^GALLERY-REPORT (.*)$/m.exec(r.out);
  return { code: r.code, out: r.out, report: line ? JSON.parse(line[1]!) as Record<string, unknown> : undefined };
}

/** The ledger's records, parsed. */
export function readLedger(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Record<string, unknown>);
}
