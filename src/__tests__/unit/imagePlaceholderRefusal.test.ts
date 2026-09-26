/**
 * PLACEHOLDER REFUSAL — a host can answer an image URL with a known stand-in instead of the plate
 * (mfc's `commit=nsp` route serves a 1,257 B "NSFW" PNG to a session that is not logged in). The
 * body is a valid image, so classification alone stores it as a gallery picture. The operator lists
 * such bodies per host by sha256; a match stores nothing and comes back as `display-gated`.
 *
 * On a host marked `loginGated`, a match — or a response re-issuing the session cookie — means the
 * login died, which the hook hands to the session-lost signal.
 */
import { createHash } from 'node:crypto';
import { buildImageHostPolicy, chooseImageLane, loadImageHostPolicy } from '../../services/images/imageHostPolicy';
import {
  placeholderRefusal,
  sessionCookieReissued,
  type ImageBytesFetcher,
  type ImageBytesResult,
} from '../../services/images/imageBytes';
import { createImpitBytesFetch } from '../../services/images/impitBytesFetch';
import { createHttpBytesFetch } from '../../services/images/httpBytesFetch';
import { createGatedTabBytesFetch } from '../../services/images/gatedTabBytesFetch';
import { DISPLAY_GATED_LEDGER_CLASS, createImageBytesRouter, createImageCaptureHook } from '../../services/images/imageCaptureHook';
import { FailureReporter, type FetchFailureClient } from '../../services/failureReporter';
import { FetchKind, FetchReasonClass as WireReasonClass } from '@figurecollecting/ingest-contract';
import { paceImageBytesByHost } from '../../services/images/imageBytesPacing';
import { HostRateLimiter } from '../../driver/hostRateLimiter';
import { CollectingCaptureSink } from '../../services/captureSink';
import type { CfCookieSource } from '../../services/cookieJar';
import type { FetchFailureReport } from '../../services/failureReporter';
import type { ImpitLike } from '../../services/impitFetch';
import type { ExtractionRuleset, ImageRef } from '@figurecollecting/scraper-plugin-contract';

/** The production hashes (investigation 2026-09-26): mfc's anonymous nsp PNG and its display icon. */
const NSP_ANON_SHA = 'bf110e575294decc364916933a89e0ed05926854ee4d6e47559d20d20dd767b5';
const ICON_SHA = 'a87e4c47e2cb587893a50b1ce0f05956e6d5c0a0ed1f6a71c4537577e3bdadbe';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A real (minimal, decodable) JPEG: SOI, APP0/JFIF, and EOI. */
const REAL_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffd9',
  'hex',
);
/** Two stand-in bodies — each a valid PNG, which is exactly why classification cannot catch them. */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PLACEHOLDER_A = Buffer.concat([PNG_SIG, Buffer.from('NSFW-tile-256x256')]);
const PLACEHOLDER_B = Buffer.concat([PNG_SIG, Buffer.from('nsfw-icon')]);

const SITE_PAGE = 'https://myfigurecollection.net/item/3767864';
const NSP_URL = 'https://myfigurecollection.net/?_tb=commit&commit=nsp&objectType=item&objectId=3767864&size=1';
const STATIC_URL = 'https://static.myfigurecollection.net/upload/items/1/3767864-abc.jpg';

const policyTable = () => ({
  'myfigurecollection.net': {
    lane: 'impit' as const,
    egress: 'direct' as const,
    loginGated: true,
    sessionCookie: 'PHPSESSID',
    placeholders: { [sha(PLACEHOLDER_A)]: 'display_gated' },
  },
  'static.myfigurecollection.net': {
    lane: 'impit' as const,
    egress: 'direct' as const,
    placeholders: { [sha(PLACEHOLDER_B)]: 'display_gated' },
  },
});

describe('the image host policy — placeholders, loginGated, sessionCookie', () => {
  it('loads the production rows: the two real hashes, loginGated and the session cookie name', () => {
    const warnings: string[] = [];
    const policy = loadImageHostPolicy(
      {
        IMAGE_HOST_POLICY_JSON: JSON.stringify({
          'myfigurecollection.net': {
            lane: 'impit',
            egress: 'residential',
            loginGated: true,
            sessionCookie: 'PHPSESSID',
            placeholders: { [NSP_ANON_SHA]: 'display_gated' },
          },
          'static.myfigurecollection.net': { lane: 'impit', placeholders: { [ICON_SHA.toUpperCase()]: 'display_gated' } },
        }),
      } as NodeJS.ProcessEnv,
      { warn: m => void warnings.push(m) },
    );
    expect(warnings).toEqual([]);
    expect(policy.ruleFor('myfigurecollection.net')).toEqual({
      lane: 'impit',
      egress: 'residential',
      loginGated: true,
      sessionCookie: 'PHPSESSID',
      placeholders: { [NSP_ANON_SHA]: 'display_gated' },
    });
    // Hash keys are normalized to lowercase hex, the form the lanes compute.
    expect(policy.ruleFor('static.myfigurecollection.net').placeholders).toEqual({ [ICON_SHA]: 'display_gated' });
  });

  it('keeps an OLDER policy (no new fields) exactly as it was — no placeholders, no gating', () => {
    const policy = buildImageHostPolicy({ 'myfigurecollection.net': { lane: 'impit', egress: 'residential' } });
    const decision = chooseImageLane(SITE_PAGE, NSP_URL, undefined, policy);
    expect(decision).toEqual({ ok: true, lane: 'impit', egress: 'residential', referer: SITE_PAGE, ua: 'chrome' });
  });

  it('drops malformed entries with a warning and keeps the valid ones', () => {
    const warnings: string[] = [];
    const policy = loadImageHostPolicy(
      {
        IMAGE_HOST_POLICY_JSON: JSON.stringify({
          'a.test': { placeholders: { 'not-a-hash': 'display_gated', [NSP_ANON_SHA]: 'display_gated', [ICON_SHA]: 42 } },
          'b.test': { placeholders: ['nope'], loginGated: 'yes', sessionCookie: 'bad name;' },
          'c.test': { placeholders: { [ICON_SHA]: 'x'.repeat(65) } },
        }),
      } as NodeJS.ProcessEnv,
      { warn: m => void warnings.push(m) },
    );
    expect(policy.ruleFor('a.test')).toEqual({ placeholders: { [NSP_ANON_SHA]: 'display_gated' } });
    expect(policy.ruleFor('b.test')).toEqual({});
    // Every valid entry dropped leaves no map at all rather than an empty one.
    expect(policy.ruleFor('c.test')).toEqual({});
    expect(warnings.join('\n')).toMatch(/placeholder.*a\.test/);
    expect(warnings.join('\n')).toMatch(/placeholders.*b\.test/);
    expect(warnings.join('\n')).toMatch(/loginGated.*b\.test/);
    expect(warnings.join('\n')).toMatch(/sessionCookie.*b\.test/);
  });

  it('warns when sessionCookie is named on a host that is not loginGated — it would do nothing', () => {
    const warnings: string[] = [];
    loadImageHostPolicy(
      { IMAGE_HOST_POLICY_JSON: JSON.stringify({ 'a.test': { sessionCookie: 'PHPSESSID' } }) } as NodeJS.ProcessEnv,
      { warn: m => void warnings.push(m) },
    );
    expect(warnings.join('\n')).toMatch(/sessionCookie.*a\.test.*loginGated/);
  });

  it('carries the matched host\'s placeholders and gating into the decision, and a sibling host\'s never', () => {
    const policy = buildImageHostPolicy(policyTable());
    const nsp = chooseImageLane(SITE_PAGE, NSP_URL, undefined, policy);
    const plate = chooseImageLane(SITE_PAGE, STATIC_URL, undefined, policy);
    if (!nsp.ok || !plate.ok) throw new Error('expected both decisions to be ok');
    expect(nsp.placeholders).toEqual({ [sha(PLACEHOLDER_A)]: 'display_gated' });
    expect(nsp.loginGated).toBe(true);
    expect(nsp.sessionCookie).toBe('PHPSESSID');
    // Longest-suffix match: the static host's own row wins, and it does not inherit the parent's.
    expect(plate.placeholders).toEqual({ [sha(PLACEHOLDER_B)]: 'display_gated' });
    expect(plate.loginGated).toBeUndefined();
    expect(plate.sessionCookie).toBeUndefined();
  });
});

describe('placeholderRefusal', () => {
  const placeholders = { [sha(PLACEHOLDER_A)]: 'display_gated', [sha(PLACEHOLDER_B)]: 'display_gated' };

  it('passes a real JPEG', () => {
    expect(placeholderRefusal(REAL_JPEG, placeholders, 200)).toBeUndefined();
  });

  it('refuses both listed bodies as display-gated, naming the hash and booking the bytes read', () => {
    for (const body of [PLACEHOLDER_A, PLACEHOLDER_B]) {
      expect(placeholderRefusal(body, placeholders, 200)).toEqual({
        ok: false,
        reason: 'display-gated',
        status: 200,
        bytesRead: body.byteLength,
        detail: `display_gated: body sha256 ${sha(body)} is a listed placeholder`,
      });
    }
  });

  it('refuses nothing when the host lists no placeholders', () => {
    expect(placeholderRefusal(PLACEHOLDER_A, undefined, 200)).toBeUndefined();
    expect(placeholderRefusal(PLACEHOLDER_A, {}, 200)).toBeUndefined();
  });

  it('omits the status when the lane had none', () => {
    expect(placeholderRefusal(PLACEHOLDER_A, placeholders)).not.toHaveProperty('status');
  });
});

describe('sessionCookieReissued', () => {
  it('is true when the server sets the session cookie to a value other than the stored one', () => {
    expect(sessionCookieReissued(['PHPSESSID=fresh; path=/'], 'PHPSESSID', 'stored')).toBe(true);
    // No stored session at all: any value the server issues is a new session.
    expect(sessionCookieReissued(['PHPSESSID=fresh'], 'PHPSESSID', undefined)).toBe(true);
  });

  it('is false for a re-affirmed value, another cookie, no cookie name, or no Set-Cookie', () => {
    expect(sessionCookieReissued(['PHPSESSID=stored; path=/'], 'PHPSESSID', 'stored')).toBe(false);
    expect(sessionCookieReissued(['other=1; path=/', 'PHPSESSIDX=2'], 'PHPSESSID', 'stored')).toBe(false);
    expect(sessionCookieReissued(['PHPSESSID=fresh'], undefined, 'stored')).toBe(false);
    expect(sessionCookieReissued([], 'PHPSESSID', 'stored')).toBe(false);
  });

  it('tolerates the whitespace a joined header leaves, and a malformed entry', () => {
    expect(sessionCookieReissued(['other=1', ' PHPSESSID = fresh ; HttpOnly', 'garbage'], 'PHPSESSID', 'stored')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// The three lanes. Each one refuses a listed body after classification and flags a re-issued session.
// ---------------------------------------------------------------------------------------------------

const cookieStore = (stored: Record<string, string> | undefined): CfCookieSource => ({
  cookiesFor: () => stored,
  userAgentFor: () => undefined,
});

const impitOver = (body: Buffer, contentType: string, setCookie: string[] = []) => {
  const headers = new Headers({ 'content-type': contentType, 'content-length': String(body.length) });
  for (const c of setCookie) headers.append('set-cookie', c);
  const impit = {
    fetch: jest.fn(async () => ({ status: 200, url: NSP_URL, headers, bytes: async () => new Uint8Array(body) })),
  } as unknown as ImpitLike;
  return createImpitBytesFetch({ getImpit: async () => impit, cookieStore: cookieStore({ PHPSESSID: 'stored' }), accept: '*/*' });
};

describe('the impit lane', () => {
  const placeholders = { [sha(PLACEHOLDER_A)]: 'display_gated' };

  it('passes a real JPEG, refuses a listed placeholder, and leaves the same body alone on a host without the entry', async () => {
    const jpeg = await impitOver(REAL_JPEG, 'image/jpeg')(NSP_URL, { placeholders });
    expect(jpeg.ok).toBe(true);
    const gated = await impitOver(PLACEHOLDER_A, 'image/png')(NSP_URL, { placeholders });
    expect(gated).toMatchObject({ ok: false, reason: 'display-gated', status: 200, bytesRead: PLACEHOLDER_A.byteLength });
    const unlisted = await impitOver(PLACEHOLDER_A, 'image/png')(NSP_URL, {});
    expect(unlisted.ok).toBe(true);
  });

  it('flags a response that re-issues the named session cookie — on a success and on a refusal alike', async () => {
    const ok = await impitOver(REAL_JPEG, 'image/jpeg', ['PHPSESSID=fresh; path=/'])(NSP_URL, { sessionCookie: 'PHPSESSID' });
    expect(ok).toMatchObject({ ok: true, sessionReissued: true });
    const gated = await impitOver(PLACEHOLDER_A, 'image/png', ['PHPSESSID=fresh'])(NSP_URL, { placeholders, sessionCookie: 'PHPSESSID' });
    expect(gated).toMatchObject({ ok: false, reason: 'display-gated', sessionReissued: true });
  });

  it('does not flag a re-affirmed session, or any Set-Cookie when no session cookie is named', async () => {
    const same = await impitOver(REAL_JPEG, 'image/jpeg', ['PHPSESSID=stored'])(NSP_URL, { sessionCookie: 'PHPSESSID' });
    expect(same).not.toHaveProperty('sessionReissued');
    const unnamed = await impitOver(REAL_JPEG, 'image/jpeg', ['PHPSESSID=fresh'])(NSP_URL, {});
    expect(unnamed).not.toHaveProperty('sessionReissued');
  });

  it('reads Set-Cookie from a plain header record too (an impit build without a Headers object)', async () => {
    const impit = {
      fetch: jest.fn(async () => ({
        status: 403,
        headers: { 'content-type': 'text/html', 'set-cookie': 'PHPSESSID=fresh; path=/' },
        bytes: async () => new Uint8Array(0),
      })),
    } as unknown as ImpitLike;
    const lane = createImpitBytesFetch({ getImpit: async () => impit, cookieStore: cookieStore(undefined), accept: '*/*' });
    expect(await lane(NSP_URL, { sessionCookie: 'PHPSESSID' })).toMatchObject({ ok: false, reason: 'http-status', sessionReissued: true });
  });
});

describe('the http lane', () => {
  const lane = (body: Buffer, contentType: string, setCookie?: string[]) =>
    createHttpBytesFetch({
      accept: '*/*',
      fetchImpl: async () => ({
        status: 200,
        url: STATIC_URL,
        headers: {
          get: (name: string) => (name === 'content-type' ? contentType : name === 'set-cookie' && setCookie ? setCookie.join(', ') : null),
          ...(setCookie ? { getSetCookie: () => setCookie } : {}),
        },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      }),
    });
  const placeholders = { [sha(PLACEHOLDER_B)]: 'display_gated' };

  it('passes a real JPEG, refuses a listed placeholder, and leaves the same body alone on a host without the entry', async () => {
    expect((await lane(REAL_JPEG, 'image/jpeg')(STATIC_URL, { placeholders })).ok).toBe(true);
    expect(await lane(PLACEHOLDER_B, 'image/png')(STATIC_URL, { placeholders })).toMatchObject({ ok: false, reason: 'display-gated' });
    expect((await lane(PLACEHOLDER_B, 'image/png')(STATIC_URL, {})).ok).toBe(true);
  });

  it('flags a re-issued session cookie (it sends none, so any value is new)', async () => {
    expect(await lane(REAL_JPEG, 'image/jpeg', ['PHPSESSID=x'])(STATIC_URL, { sessionCookie: 'PHPSESSID' })).toMatchObject({
      ok: true,
      sessionReissued: true,
    });
  });

  it('falls back to the joined Set-Cookie header when the response has no getSetCookie()', async () => {
    const joined = createHttpBytesFetch({
      accept: '*/*',
      fetchImpl: async () => ({
        status: 200,
        url: STATIC_URL,
        headers: { get: (name: string) => (name === 'content-type' ? 'image/jpeg' : name === 'set-cookie' ? 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, PHPSESSID=x' : null) },
        arrayBuffer: async () => REAL_JPEG.buffer.slice(REAL_JPEG.byteOffset, REAL_JPEG.byteOffset + REAL_JPEG.byteLength) as ArrayBuffer,
      }),
    });
    expect(await joined(STATIC_URL, { sessionCookie: 'PHPSESSID' })).toMatchObject({ ok: true, sessionReissued: true });
  });
});

describe('the gated-tab lane', () => {
  const MAIN = {};
  const run = (body: Buffer, contentType: string, setCookie?: string) => {
    const response = {
      status: () => 200,
      url: () => NSP_URL,
      headers: (): Record<string, string> => ({ 'content-type': contentType, ...(setCookie ? { 'set-cookie': setCookie } : {}) }),
      buffer: async () => body,
      request: () => ({ resourceType: () => 'document' }),
      frame: () => MAIN,
    };
    const handlers: Array<(r: unknown) => void> = [];
    const page = {
      on: (_e: string, h: (r: unknown) => void) => void handlers.push(h),
      off: () => undefined,
      mainFrame: () => MAIN,
      goto: async () => {
        handlers.forEach(h => h(response));
        return response;
      },
    };
    const lane = { withPage: async (fn: (p: never) => Promise<unknown>) => fn(page as never) } as never;
    return createGatedTabBytesFetch(lane, { accept: '*/*', cookieStore: cookieStore({ PHPSESSID: 'stored' }) });
  };
  const placeholders = { [sha(PLACEHOLDER_A)]: 'display_gated' };

  it('passes a real JPEG, refuses a listed placeholder, and leaves the same body alone on a host without the entry', async () => {
    expect((await run(REAL_JPEG, 'image/jpeg')('direct', 'myfigurecollection.net', NSP_URL, { placeholders })).ok).toBe(true);
    expect(await run(PLACEHOLDER_A, 'image/png')('direct', 'myfigurecollection.net', NSP_URL, { placeholders })).toMatchObject({
      ok: false,
      reason: 'display-gated',
    });
    expect((await run(PLACEHOLDER_A, 'image/png')('direct', 'myfigurecollection.net', NSP_URL, {})).ok).toBe(true);
  });

  it('flags a re-issued session cookie from Chrome\'s newline-joined header', async () => {
    const result = await run(REAL_JPEG, 'image/jpeg', 'other=1; path=/\n PHPSESSID=fresh; path=/; HttpOnly')(
      'direct',
      'myfigurecollection.net',
      NSP_URL,
      { sessionCookie: 'PHPSESSID' },
    );
    expect(result).toMatchObject({ ok: true, sessionReissued: true });
  });
});

// ---------------------------------------------------------------------------------------------------
// The hook: nothing stored, a ledger row the CURRENT spine accepts, and the session-lost signal.
// ---------------------------------------------------------------------------------------------------

const gallery = (url: string, position = 0): ImageRef => ({ url, role: 'gallery', position });
const describing = (refs: ImageRef[]): Pick<ExtractionRuleset, 'describeImages'> => ({ describeImages: () => refs });

function hookOver(fetchBytes: ImageBytesFetcher, table: Parameters<typeof buildImageHostPolicy>[0] = policyTable()) {
  const sink = new CollectingCaptureSink();
  const reports: FetchFailureReport[] = [];
  const lost: Array<{ url: string; lane: string; reason: string; sessionCookie?: string }> = [];
  const hook = createImageCaptureHook({
    sink,
    policy: buildImageHostPolicy(table),
    fetchBytes,
    reportFailure: async r => void reports.push(r),
    onSessionLost: (url, lane, reason, sessionCookie) => void lost.push({ url, lane, reason, ...(sessionCookie ? { sessionCookie } : {}) }),
    warn: () => undefined,
    now: () => 1_000_000,
  });
  const capture = (refs: ImageRef[]) =>
    hook.capture({ site: 'mfc', itemId: '3767864', pageUrl: SITE_PAGE, fields: {}, ruleset: describing(refs), origin: 'ingest' });
  return { sink, reports, lost, hook, capture };
}

describe('the capture hook on a display-gated body', () => {
  const gatedResult = (sessionReissued = false): ImageBytesResult => ({
    ok: false,
    reason: 'display-gated',
    status: 200,
    bytesRead: PLACEHOLDER_A.byteLength,
    detail: `display_gated: body sha256 ${sha(PLACEHOLDER_A)} is a listed placeholder`,
    ...(sessionReissued ? { sessionReissued: true as const } : {}),
  });

  it('hands the lane the matched host\'s placeholders and session cookie on the plan', async () => {
    const plans: unknown[] = [];
    const h = hookOver(async (_url, plan) => {
      plans.push(plan);
      return { ok: true, bytes: REAL_JPEG, contentType: 'image/jpeg', status: 200, finalUrl: NSP_URL, headers: {} };
    });
    await h.capture([gallery(NSP_URL)]);
    expect(plans[0]).toMatchObject({ placeholders: { [sha(PLACEHOLDER_A)]: 'display_gated' }, sessionCookie: 'PHPSESSID' });
  });

  it('stores NOTHING, files a ledger row the current spine accepts, and does not memoize the url', async () => {
    let calls = 0;
    const h = hookOver(async () => {
      calls += 1;
      return gatedResult();
    });
    await h.capture([gallery(NSP_URL)]);
    expect(h.sink.captures).toHaveLength(0);
    // Mapped onto an EXISTING fetch_failure_reason label (migration 0020 has no display_gated), with
    // the native class carried in the message.
    expect(h.reports).toEqual([
      {
        site: 'mfc',
        itemId: '3767864',
        target: NSP_URL,
        origin: 'ingest',
        kind: 'image',
        reasonClass: 'http_403',
        httpStatus: 200,
        message: `display_gated: body sha256 ${sha(PLACEHOLDER_A)} is a listed placeholder`,
        transport: 'impit',
      },
    ]);
    const stats = h.hook.stats();
    expect(stats.skipped.displayGated).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.stored).toBe(0);
    // Not memoized: the next pass (after a re-mint) fetches it again.
    await h.capture([gallery(NSP_URL)]);
    expect(calls).toBe(2);
  });

  it('signals session-lost for a placeholder on a loginGated host, and not on a host without it', async () => {
    const h = hookOver(async url => (url === NSP_URL ? gatedResult() : { ...gatedResult(), detail: 'icon' }));
    await h.capture([gallery(NSP_URL), gallery(STATIC_URL, 1)]);
    expect(h.lost).toEqual([{ url: NSP_URL, lane: 'impit', reason: 'placeholder body on a login-gated host', sessionCookie: 'PHPSESSID' }]);
    expect(h.hook.stats().skipped.displayGated).toBe(2);
  });

  it('signals session-lost when a loginGated host re-issues the session cookie, and still stores a real plate', async () => {
    const h = hookOver(async () => ({
      ok: true,
      bytes: REAL_JPEG,
      contentType: 'image/jpeg',
      status: 200,
      finalUrl: NSP_URL,
      headers: {},
      sessionReissued: true,
    }));
    await h.capture([gallery(NSP_URL)]);
    expect(h.sink.captures).toHaveLength(1);
    expect(h.lost).toEqual([{ url: NSP_URL, lane: 'impit', reason: 'session cookie re-issued on an image response', sessionCookie: 'PHPSESSID' }]);
  });

  it('never signals for a re-issued cookie on a host that is not loginGated', async () => {
    const h = hookOver(async () => ({ ...gatedResult(true) }), { 'static.myfigurecollection.net': { lane: 'impit' } });
    await h.capture([gallery(STATIC_URL)]);
    expect(h.lost).toEqual([]);
  });

  it('survives a session-lost listener that throws', async () => {
    const sink = new CollectingCaptureSink();
    const hook = createImageCaptureHook({
      sink,
      policy: buildImageHostPolicy(policyTable()),
      fetchBytes: async () => gatedResult(),
      onSessionLost: () => {
        throw new Error('listener down');
      },
      warn: () => undefined,
    });
    await hook.capture({ site: 'mfc', itemId: '1', pageUrl: SITE_PAGE, fields: {}, ruleset: describing([gallery(NSP_URL)]), origin: 'ingest' });
    expect(hook.stats().skipped.displayGated).toBe(1);
  });

  it('end to end through the real impit lane, router and pacing: a real JPEG is stored, both placeholders are not, and an unlisted host keeps the same body', async () => {
    const bodies: Record<string, Buffer> = {
      [NSP_URL]: PLACEHOLDER_A,
      [STATIC_URL]: PLACEHOLDER_B,
      'https://myfigurecollection.net/?_tb=commit&commit=nsp&objectType=item&objectId=1&size=2': REAL_JPEG,
      'https://images.example.test/tile.png': PLACEHOLDER_A,
    };
    const impit = {
      fetch: jest.fn(async (url: string) => ({
        status: 200,
        url,
        headers: new Headers({ 'content-type': bodies[url] === REAL_JPEG ? 'image/jpeg' : 'image/png' }),
        bytes: async () => new Uint8Array(bodies[url]),
      })),
    } as unknown as ImpitLike;
    const fetchBytes = paceImageBytesByHost(
      createImageBytesRouter({ impit: createImpitBytesFetch({ getImpit: async () => impit, cookieStore: cookieStore(undefined), accept: '*/*' }) }),
      new HostRateLimiter(() => undefined),
      { now: () => 0, sleep: async () => undefined, cooldown: { remaining: () => 0 } },
    );
    const h = hookOver(fetchBytes, { ...policyTable(), 'images.example.test': { lane: 'impit' } });
    await h.capture(Object.keys(bodies).map((url, i) => gallery(url, i)));
    expect(h.sink.captures.map(c => c.url).sort()).toEqual(
      ['https://images.example.test/tile.png', 'https://myfigurecollection.net/?_tb=commit&commit=nsp&objectType=item&objectId=1&size=2'].sort(),
    );
    expect(h.hook.stats().skipped.displayGated).toBe(2);
    expect(h.lost).toHaveLength(1);
  });
});

describe('the display-gated ledger row on the wire', () => {
  it('serializes to HTTP_403 — a label migration 0020 and the spine\'s REASON_NAME already accept — with the native class in the message', async () => {
    const sent: Parameters<FetchFailureClient['reportFetchFailure']>[0][] = [];
    const client: FetchFailureClient = {
      reportFetchFailure: async message => {
        sent.push(message);
        return {} as never;
      },
    };
    const h = hookOver(async () => ({
      ok: false,
      reason: 'display-gated',
      status: 200,
      bytesRead: PLACEHOLDER_A.byteLength,
      detail: `display_gated: body sha256 ${sha(PLACEHOLDER_A)} is a listed placeholder`,
    }));
    await h.capture([gallery(NSP_URL)]);
    await new FailureReporter({ client, now: () => 0 }).report(h.reports[0]);
    expect(DISPLAY_GATED_LEDGER_CLASS).toBe('http_403');
    expect(sent).toHaveLength(1);
    expect(sent[0].reasonClass).toBe(WireReasonClass.HTTP_403);
    expect(sent[0].kind).toBe(FetchKind.IMAGE);
    expect(sent[0].httpStatus).toBe(200);
    expect(sent[0].message.startsWith('display_gated: body sha256 ')).toBe(true);
  });
});
