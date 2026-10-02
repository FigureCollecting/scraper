/**
 * TDD (red first) — src/diag/input.ts, the RunProbe input surface (hands-off plan unit S1,
 * design.rpc_input_surface).
 *
 * WHY: RunProbe is how an operator makes the engine send a request upstream. Everything it accepts
 * is a request the engine might send, so the validator refuses — before any budget is touched and
 * with 0 requests — anything outside the declared surface:
 *   - probe: ROBOTS_SNAPSHOT or ITEM_STATUS only;
 *   - store: a siteId the engine registry holds;
 *   - origin (store-less robots-snapshot only): https + a bare public DNS hostname. The engine runs
 *     INSIDE the cluster, so IP literals, localhost, *.local, *.svc, *.cluster.local, *.internal and
 *     single-label names are refused (SSRF guard), and so is any name whose top-level domain is not
 *     an ICANN one (the cluster's short <svc>.<ns> form, home-network names like router.lan) or
 *     that is a public suffix itself; a host a registered store owns must use --store; a host a
 *     registered policy denies is refused;
 *   - store: what the lookup returns must be the store asked for, and a store a policy denies is
 *     refused in every mode;
 *   - ids (item-status only): at most the probe maximum (2), each a FULL match of the store's
 *     declared id pattern, digits-only when it declares none; pair needs exactly one id (the control).
 * The registry is injected, so this file names no store and no host.
 */
import { create } from '@bufbuild/protobuf';
import { validateRunProbeInput, type DiagInputLookups, type DiagStoreInfo } from '../../diag/input';
import { Probe, RunProbeRequestSchema, type RunProbeRequest } from '../../gen/fc/diag/v1/diag_pb';

type RequestInit = Parameters<typeof create<typeof RunProbeRequestSchema>>[1];

const STORES: Record<string, DiagStoreInfo & { domains: string[] }> = {
  alpha: { siteId: 'alpha', domains: ['alpha.example.com'] },
  beta: { siteId: 'beta', domains: ['beta.example.org'], idPattern: /[a-z]{2}-[0-9]{3}/ },
  gamma: { siteId: 'gamma', domains: ['gamma.example.net'], idPattern: /[0-9]+/g },
  delta: { siteId: 'delta', domains: ['www.delta.example.com'], idPattern: /[a-z]{2}-[0-9]{3}/m },
  sticky: { siteId: 'sticky', domains: ['sticky.example.com'], idPattern: /[0-9]+/y },
  epsilon: { siteId: 'epsilon', domains: ['epsilon.example.com'], idPattern: /[0-9]+|[a-z]{2}-[0-9]{3}/ },
  omega: { siteId: 'omega', domains: ['omega.example.com'], denied: true },
};
const DENIED = ['denied.example.org', 'www.denied-www.example.org'];

/** Parent-domain match, the way the engine registry resolves a host. */
function covers(domain: string, host: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const lookups: DiagInputLookups = {
  storeById: (siteId) => STORES[siteId],
  storeIdForHost: (host) => Object.values(STORES).find((s) => s.domains.some((d) => covers(d, host)))?.siteId,
  isDeniedHost: (host) => DENIED.some((d) => covers(d, host)),
};

function req(init: RequestInit): RunProbeRequest {
  return create(RunProbeRequestSchema, init);
}

function check(init: RequestInit) {
  return validateRunProbeInput(req(init), lookups);
}

function refusal(init: RequestInit): { field: string; reason: string } {
  const r = check(init);
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.input)}`);
  return { field: r.field, reason: r.reason };
}

describe('probe', () => {
  it.each([Probe.UNSPECIFIED, 7 as Probe])('refuses probe %p', (probe) => {
    expect(refusal({ probe, store: 'alpha' }).field).toBe('probe');
  });
});

describe('robots-snapshot --store', () => {
  it('accepts a registered siteId', () => {
    expect(check({ probe: Probe.ROBOTS_SNAPSHOT, store: 'alpha' })).toEqual({
      ok: true,
      input: { probe: Probe.ROBOTS_SNAPSHOT, mode: 'store', siteId: 'alpha' },
    });
  });

  it('refuses a siteId the registry does not hold', () => {
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, store: 'nope' })).toEqual({
      field: 'store',
      reason: expect.stringMatching(/not a registered store/),
    });
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'refuses store %j: a plain-object lookup answers a built-in property, not a store',
    (store) => {
      expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, store })).toEqual({
        field: 'store',
        reason: expect.stringMatching(/not a registered store/),
      });
      expect(refusal({ probe: Probe.ITEM_STATUS, store, ids: ['1'] }).field).toBe('store');
    }
  );

  it('refuses a store when the lookup answers with a different store', () => {
    const askedBeta: DiagInputLookups = { ...lookups, storeById: () => STORES.alpha };
    const r1 = validateRunProbeInput(req({ probe: Probe.ROBOTS_SNAPSHOT, store: 'beta' }), askedBeta);
    const r2 = validateRunProbeInput(req({ probe: Probe.ITEM_STATUS, store: 'beta', ids: ['1'] }), askedBeta);
    expect(r1.ok || r1.field).toBe('store');
    expect(r2.ok || r2.field).toBe('store');
  });

  it('refuses a store a registered policy denies, in robots-snapshot and in item-status', () => {
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, store: 'omega' })).toEqual({
      field: 'store',
      reason: expect.stringMatching(/denied/),
    });
    expect(refusal({ probe: Probe.ITEM_STATUS, store: 'omega', ids: ['1'] })).toEqual({
      field: 'store',
      reason: expect.stringMatching(/denied/),
    });
  });

  it('refuses neither store nor origin, and both at once', () => {
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT }).field).toBe('store');
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, store: 'alpha', origin: 'https://public.example.net' }).field).toBe('origin');
  });

  it('refuses ids and pair, which belong to item-status', () => {
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, store: 'alpha', ids: ['1'] }).field).toBe('ids');
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, store: 'alpha', pair: true }).field).toBe('pair');
  });
});

describe('robots-snapshot --origin (store-less first contact)', () => {
  it.each(['https://public.example.net', 'https://public.example.net/', 'https://PUBLIC.Example.NET'])(
    'accepts %j and reports the lower-cased host',
    (origin) => {
      expect(check({ probe: Probe.ROBOTS_SNAPSHOT, origin })).toEqual({
        ok: true,
        input: { probe: Probe.ROBOTS_SNAPSHOT, mode: 'origin', host: 'public.example.net' },
      });
    }
  );

  it.each([
    ['not a url', 'not a url'],
    ['plain http', 'http://public.example.net'],
    ['another scheme', 'ftp://public.example.net'],
    ['an IPv4 literal', 'https://93.184.215.14'],
    ['a decimal IPv4', 'https://2130706433'],
    ['a hex IPv4', 'https://0x7f.0.0.1'],
    ['a short IPv4', 'https://127.1'],
    ['an IPv6 literal', 'https://[::1]'],
    ['localhost', 'https://localhost'],
    ['a .localhost name', 'https://app.localhost'],
    ['a .local name', 'https://printer.local'],
    ['a .svc name', 'https://scraper.fc.svc'],
    ['a .cluster.local name', 'https://scraper.fc.svc.cluster.local'],
    ['a .internal name', 'https://metadata.google.internal'],
    ['a reserved .test name', 'https://shop.test'],
    ['a reserved .invalid name', 'https://shop.invalid'],
    ['a reserved .example name', 'https://shop.example'],
    ['an .onion name', 'https://shop.onion'],
    ['an .arpa name', 'https://router.home.arpa'],
    ['a single-label name', 'https://intranet'],
    ['a port', 'https://public.example.net:8443'],
    ['the default port spelled out', 'https://public.example.net:443'],
    ['a path', 'https://public.example.net/robots.txt'],
    ['a query', 'https://public.example.net/?x=1'],
    ['an empty query', 'https://public.example.net/?'],
    ['a fragment', 'https://public.example.net/#top'],
    ['userinfo', 'https://user:pw@public.example.net'],
    ['a bare user', 'https://user@public.example.net'],
    ['a trailing dot', 'https://public.example.net.'],
    ['surrounding whitespace', ' https://public.example.net'],
    ['a backslash', 'https:\\\\public.example.net'],
    ['an underscore label', 'https://pub_lic.example.net'],
    ['a label that ends in a hyphen', 'https://public-.example.net'],
    ['a non-ASCII spelling', 'https://bücher.example.net'],
  ])('refuses %s (%j)', (_label, origin) => {
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin }).field).toBe('origin');
  });

  it.each([
    ['https://app.localhost', 'localhost'],
    ['https://printer.local', 'local'],
    ['https://scraper.fc.svc', 'svc'],
    ['https://scraper.fc.svc.cluster.local', 'local'],
    ['https://metadata.google.internal', 'internal'],
    ['https://shop.test', 'test'],
    ['https://shop.example', 'example'],
    ['https://shop.invalid', 'invalid'],
    ['https://shop.onion', 'onion'],
    ['https://router.home.arpa', 'arpa'],
  ])('refuses %j for its reserved suffix (.%s), whatever the Public Suffix List says of that suffix', (origin, suffix) => {
    const host = origin.slice('https://'.length);
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin }).reason).toBe(`origin: '${host}' is not a public name (.${suffix})`);
  });

  it.each(['https://alpha.example.com', 'https://cdn.alpha.example.com'])(
    'refuses %j, a host a registered store owns, and says to use --store',
    (origin) => {
      expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin })).toEqual({
        field: 'origin',
        reason: expect.stringContaining('use --store alpha'),
      });
    }
  );

  it('a store registered under www. owns its bare name too: refuses https://delta.example.com', () => {
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin: 'https://delta.example.com' })).toEqual({
      field: 'origin',
      reason: expect.stringContaining('use --store delta'),
    });
  });

  it('a host denied under www. is denied under its bare name too', () => {
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin: 'https://denied-www.example.org' })).toEqual({
      field: 'origin',
      reason: expect.stringMatching(/denied/),
    });
  });

  it('a bare-name store is found from its www. twin as well', () => {
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin: 'https://www.alpha.example.com' }).reason).toContain('use --store alpha');
  });

  it('says why: plain http is refused for its scheme, an IPv6 literal for being an IP literal', () => {
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin: 'http://public.example.net' }).reason).toMatch(/must use https/);
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin: 'https://[::1]' }).reason).toMatch(/IP literal/);
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin: 'https://[2001:db8::1]' }).reason).toMatch(/IP literal/);
  });

  it('a DNS label may be 63 characters, not 64', () => {
    const label = (n: number) => 'a'.repeat(n);
    expect(check({ probe: Probe.ROBOTS_SNAPSHOT, origin: `https://${label(63)}.example.net` }).ok).toBe(true);
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin: `https://${label(64)}.example.net` }).field).toBe('origin');
  });

  it('a hostname may be 253 characters, not 254', () => {
    const name = (n: number) => {
      const labels: string[] = [];
      let left = n - '.net'.length;
      while (left > 0) {
        const len = Math.min(63, left - (labels.length > 0 ? 1 : 0));
        labels.push('b'.repeat(len));
        left -= len + (labels.length > 1 ? 1 : 0);
      }
      return `${labels.join('.')}.net`;
    };
    expect(name(253)).toHaveLength(253);
    expect(name(254)).toHaveLength(254);
    expect(check({ probe: Probe.ROBOTS_SNAPSHOT, origin: `https://${name(253)}` }).ok).toBe(true);
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin: `https://${name(254)}` }).reason).toMatch(/not a DNS hostname/);
  });

  it('a name that only ends in the same letters as a reserved suffix is not refused for that suffix', () => {
    // Neither .contest nor .glocal is an ICANN top-level domain, so both are refused, but for that.
    for (const [origin, suffix] of [
      ['https://shop.contest', '.test'],
      ['https://shop.glocal', '.local'],
    ]) {
      const { reason } = refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin });
      expect(reason).not.toContain(`(${suffix})`);
      expect(reason).toMatch(/not under an ICANN top-level domain/);
    }
  });

  it.each([
    ['a cluster service, short form', 'https://scraper.fc'],
    ['a cluster service, short form', 'https://pg-spine.fc'],
    ['the API server, short form', 'https://kubernetes.default'],
    ['a cluster service, short form', 'https://openbao.openbao'],
    ['a cluster service, short form', 'https://grafana.monitoring'],
    ['a cluster name without .local', 'https://kubernetes.default.svc.cluster'],
    ['a pod name', 'https://10-42-0-7.fc.pod'],
    ['a home-network name', 'https://router.lan'],
    ['a home-network name', 'https://nas.home'],
    ['a private-use name', 'https://host.corp'],
    ['a private-use name', 'https://host.intranet'],
    ['a private-use name', 'https://host.private'],
    ['a resolver default domain', 'https://host.localdomain'],
  ])('refuses %s (%j): its top-level domain is not an ICANN one', (_label, origin) => {
    const host = origin.slice('https://'.length);
    const tld = host.slice(host.lastIndexOf('.'));
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin })).toEqual({
      field: 'origin',
      reason: `origin: '${host}' is not under an ICANN top-level domain (${tld})`,
    });
  });

  it.each(['https://co.uk', 'https://com.au', 'https://foo.kawasaki.jp'])(
    'refuses %j, a public suffix itself rather than a host under one',
    (origin) => {
      expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin })).toEqual({
        field: 'origin',
        reason: expect.stringMatching(/is a public suffix, not a host/),
      });
    }
  );

  it.each(['https://shop.myshopify.com', 'https://pages.github.io', 'https://shop.example.co.uk', 'https://www.ck'])(
    'accepts %j: a host under a privately run suffix or a multi-label ICANN suffix is still a public name',
    (origin) => {
      expect(check({ probe: Probe.ROBOTS_SNAPSHOT, origin }).ok).toBe(true);
    }
  );

  it.each(['https://denied.example.org', 'https://www.denied.example.org'])('refuses %j, a denied host', (origin) => {
    expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, origin })).toEqual({
      field: 'origin',
      reason: expect.stringMatching(/denied/),
    });
  });

  it('refuses origin on item-status', () => {
    expect(refusal({ probe: Probe.ITEM_STATUS, store: 'alpha', ids: ['1'], origin: 'https://public.example.net' }).field).toBe(
      'origin'
    );
  });
});

describe('item-status', () => {
  it('accepts one or two ids that match the store', () => {
    expect(check({ probe: Probe.ITEM_STATUS, store: 'alpha', ids: ['2253259', '2111017'] })).toEqual({
      ok: true,
      input: { probe: Probe.ITEM_STATUS, siteId: 'alpha', ids: ['2253259', '2111017'], pair: false },
    });
  });

  it('accepts --pair with exactly one id, the control', () => {
    expect(check({ probe: Probe.ITEM_STATUS, store: 'alpha', ids: ['2253259'], pair: true })).toEqual({
      ok: true,
      input: { probe: Probe.ITEM_STATUS, siteId: 'alpha', ids: ['2253259'], pair: true },
    });
  });

  it('refuses a third id', () => {
    expect(refusal({ probe: Probe.ITEM_STATUS, store: 'alpha', ids: ['1', '2', '3'] })).toEqual({
      field: 'ids',
      reason: expect.stringMatching(/at most 2/),
    });
  });

  it('refuses no ids, a duplicate id, and --pair with two ids', () => {
    expect(refusal({ probe: Probe.ITEM_STATUS, store: 'alpha' }).field).toBe('ids');
    expect(refusal({ probe: Probe.ITEM_STATUS, store: 'alpha', ids: ['5', '5'] }).field).toBe('ids');
    expect(refusal({ probe: Probe.ITEM_STATUS, store: 'alpha', ids: ['1', '2'], pair: true }).field).toBe('pair');
  });

  it('refuses a missing or unregistered store', () => {
    expect(refusal({ probe: Probe.ITEM_STATUS, ids: ['1'] })).toEqual({ field: 'store', reason: expect.stringMatching(/needs store/) });
    expect(refusal({ probe: Probe.ITEM_STATUS, store: 'nope', ids: ['1'] }).field).toBe('store');
  });

  it.each(['abc', '12a', '', ' 12', '1/2', '../1', '1e3', '-1'])(
    'a store that declares no pattern takes digits only: refuses %j',
    (id) => {
      expect(refusal({ probe: Probe.ITEM_STATUS, store: 'alpha', ids: [id] }).field).toBe('ids');
    }
  );

  it('refuses an id longer than 64 characters even when it matches', () => {
    expect(refusal({ probe: Probe.ITEM_STATUS, store: 'alpha', ids: ['9'.repeat(65)] }).field).toBe('ids');
    expect(check({ probe: Probe.ITEM_STATUS, store: 'alpha', ids: ['9'.repeat(64)] }).ok).toBe(true);
  });

  it('a declared pattern must match the WHOLE id, anchored or not', () => {
    expect(check({ probe: Probe.ITEM_STATUS, store: 'beta', ids: ['ab-123'] }).ok).toBe(true);
    for (const id of ['xab-123', 'ab-1234', 'ab-12', '2253259']) {
      expect(refusal({ probe: Probe.ITEM_STATUS, store: 'beta', ids: [id] }).field).toBe('ids');
    }
  });

  it('a declared pattern carrying the g flag gives the same answer every time (no lastIndex state)', () => {
    for (let i = 0; i < 3; i++) {
      expect(check({ probe: Probe.ITEM_STATUS, store: 'gamma', ids: ['42'] }).ok).toBe(true);
    }
    expect(check({ probe: Probe.ITEM_STATUS, store: 'gamma', ids: ['42', '43'] }).ok).toBe(true);
  });

  it('a declared pattern carrying the y flag accepts the second id too', () => {
    expect(check({ probe: Probe.ITEM_STATUS, store: 'sticky', ids: ['42', '43'] }).ok).toBe(true);
  });

  it('a declared pattern with an alternation must match the WHOLE id with either branch, never a part', () => {
    for (const id of ['123', 'ab-123']) {
      expect(check({ probe: Probe.ITEM_STATUS, store: 'epsilon', ids: [id] }).ok).toBe(true);
    }
    for (const id of ['1/../../admin', 'x/ab-123', '123/x', 'ab-123/../1']) {
      expect(refusal({ probe: Probe.ITEM_STATUS, store: 'epsilon', ids: [id] }).field).toBe('ids');
    }
  });

  it('a declared pattern carrying the m flag cannot match one line of a multi-line id', () => {
    expect(check({ probe: Probe.ITEM_STATUS, store: 'delta', ids: ['ab-123'] }).ok).toBe(true);
    expect(refusal({ probe: Probe.ITEM_STATUS, store: 'delta', ids: ['ab-123\nzz'] }).field).toBe('ids');
  });
});

describe('max_requests and run_id', () => {
  it('passes max_requests through for the budget to cap (absent, 0 and a number are different)', () => {
    const base = { probe: Probe.ROBOTS_SNAPSHOT, store: 'alpha' } as const;
    const pick = (init: RequestInit) => {
      const r = check(init);
      return r.ok ? r.input.requested : 'refused';
    };
    expect(pick(base)).toBeUndefined();
    expect(pick({ ...base, maxRequests: 0 })).toBe(0);
    expect(pick({ ...base, maxRequests: 5 })).toBe(5);
  });

  it('an empty run_id is left for the engine to assign; a safe one is kept', () => {
    const base = { probe: Probe.ROBOTS_SNAPSHOT, store: 'alpha' } as const;
    const r1 = check(base);
    expect(r1.ok && r1.input.runId).toBeUndefined();
    const r2 = check({ ...base, runId: 'diag-robots-29341234.1' });
    expect(r2.ok && r2.input.runId).toBe('diag-robots-29341234.1');
  });

  it('a run_id may be 128 characters, not 129', () => {
    const base = { probe: Probe.ROBOTS_SNAPSHOT, store: 'alpha' } as const;
    expect(check({ ...base, runId: 'x'.repeat(128) }).ok).toBe(true);
    expect(refusal({ ...base, runId: 'x'.repeat(129) }).field).toBe('run_id');
  });

  it.each(['../etc', 'a/b', '.hidden', '-flag', 'run\nid', 'run id', 'run:1', 'x'.repeat(129)])(
    'refuses run_id %j (it becomes part of an object key and a log line)',
    (runId) => {
      expect(refusal({ probe: Probe.ROBOTS_SNAPSHOT, store: 'alpha', runId }).field).toBe('run_id');
    }
  );
});
