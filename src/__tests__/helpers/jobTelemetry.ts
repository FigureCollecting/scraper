/**
 * Shared fixtures for the batch jobs' log and trace tests (LG-ADOPT-2): a stand-in ingest server, a stand-in scraper, a
 * fetch that records what it was asked, and the real entrypoint run as a child process. Every server listens on localhost
 * and every answer is canned: nothing here reaches a store or any other live site.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export const HEX32 = /^[0-9a-f]{32}$/;
export type Line = Record<string, unknown>;

export interface SeenCall {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

export interface LocalServer {
  url: string;
  calls: SeenCall[];
  close: () => Promise<void>;
}

/** A server on localhost that keeps every request's method, path and headers and answers with `answer`. */
export async function localServer(answer: (call: SeenCall) => { status: number; type?: string; body?: string }): Promise<LocalServer> {
  const calls: SeenCall[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const call = { method: req.method ?? 'GET', path: req.url ?? '', headers: req.headers };
      calls.push(call);
      const a = answer(call);
      res.writeHead(a.status, a.type !== undefined ? { 'content-type': a.type } : {});
      res.end(a.body ?? '');
    });
  });
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    calls,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The ingest server, as far as a unary Connect call over HTTP/1.1 can tell: every call answered with an empty message. */
export function fakeSpine(): Promise<LocalServer> {
  return localServer(() => ({ status: 200, type: 'application/proto' }));
}

export interface RecordedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** A fetch that records each request (url, method, headers) and answers from `answer`; it never opens a socket. */
export function recordingFetch(answer: (url: string, init?: RequestInit) => Response | Promise<Response>): { calls: RecordedFetch[]; fetchImpl: typeof fetch } {
  const calls: RecordedFetch[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string> | undefined) } });
    return answer(url, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const parseLines = (out: string[]): Line[] => out.map(l => JSON.parse(l) as Line);

const REPO = path.resolve(__dirname, '../../..');

/**
 * Run an entry file (relative to the repo) the way its CronJob does, under tsx, with exactly `env` on top of PATH and HOME:
 * no OTEL_*, LOG_LEVEL or JOB_NAME leaks in from the shell that runs the suite.
 */
export function runEntry(entry: string, env: Record<string, string>, timeoutMs = 90_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${entry} did not exit in ${timeoutMs} ms: ${stdout.slice(-400)} ${stderr.slice(-400)}`)); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** stdout as lines; each must be one JSON object (the test fails on the first that is not). */
export function stdoutLines(stdout: string): Line[] {
  return stdout.split('\n').filter(l => l.trim() !== '').map(l => {
    try {
      return JSON.parse(l) as Line;
    } catch {
      throw new Error(`not a JSON line: ${l.slice(0, 200)}`);
    }
  });
}
