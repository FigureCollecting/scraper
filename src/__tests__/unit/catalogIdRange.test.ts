/**
 * assembleCatalog().idRange — the SYNTHESIZED id-window axis behind `GET /catalog?store=&range=1&from=&count=`.
 *
 * A store whose ids are sequential (`retrieval.byRange: true`) needs no listing to be enumerated: the
 * engine simply walks the numeric id space DOWNWARD from `from` and builds each id's collect URL from
 * the store's own `byId.urlTemplate`. It is PURE — no fetch, no cooldown, no ruleset — so the
 * capability resolution stays where the profile registry lives (the engine) while the crawler keeps
 * owning the frontier, the cursor and the ledger dedup.
 */
import { assembleCatalog, type CatalogServices } from '../../driver/assembleCatalog';
import { ProfileRegistry } from '../../driver/profileRegistry';
import { ChallengeCooldown } from '../../services/challengeCooldown';
import type { StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';

const MFC: StoreCapabilities = {
  siteId: 'mfc',
  name: 'MyFigureCollection',
  domains: ['myfigurecollection.net'],
  rateLimit: { domain: 'myfigurecollection.net', baseDelayMs: 0, minDelayMs: 0, maxDelayMs: 100, backoffMultiplier: 2, recoveryDivisor: 2, successThreshold: 3 },
  requiresBrowser: false,
  allowedCookies: [],
  retrieval: { byId: { urlTemplate: 'https://myfigurecollection.net/item/{id}', idKind: 'store-internal' }, byRange: true },
};

const services = (...stores: StoreCapabilities[]): CatalogServices => {
  const profiles = new ProfileRegistry();
  for (const s of stores) profiles.register(s);
  return {
    profiles,
    getRulesetForUrl: () => undefined,
    fetchSearch: jest.fn(async () => { throw new Error('idRange must never fetch'); }),
    challengeCooldown: new ChallengeCooldown({ now: () => 1_000_000, windowMs: 30 * 60_000 }),
  };
};

describe('assembleCatalog — idRange', () => {
  it('walks DOWN from `from` for `count` ids, building each collectUrl from the byId template', () => {
    const out = assembleCatalog(services(MFC)).idRange('mfc', 3630000, 3);
    expect(out).toEqual({
      status: 'ok',
      siteId: 'mfc',
      from: 3630000,
      items: [
        { itemId: '3630000', collectUrl: 'https://myfigurecollection.net/item/3630000' },
        { itemId: '3629999', collectUrl: 'https://myfigurecollection.net/item/3629999' },
        { itemId: '3629998', collectUrl: 'https://myfigurecollection.net/item/3629998' },
      ],
      collectUrls: [
        'https://myfigurecollection.net/item/3630000',
        'https://myfigurecollection.net/item/3629999',
        'https://myfigurecollection.net/item/3629998',
      ],
      hasMore: true,
      nextFrom: 3629997,
      count: 3,
    });
  });

  it('never fetches anything (no listing, no ruleset, no cooldown involved)', () => {
    const svc = services(MFC);
    assembleCatalog(svc).idRange('mfc', 100, 5);
    expect(svc.fetchSearch).not.toHaveBeenCalled();
  });

  it('stops at id 1 — the floor — and reports hasMore:false with no nextFrom', () => {
    const out = assembleCatalog(services(MFC)).idRange('mfc', 3, 10);
    expect(out).toMatchObject({
      status: 'ok',
      from: 3,
      count: 3,
      hasMore: false,
      collectUrls: [
        'https://myfigurecollection.net/item/3',
        'https://myfigurecollection.net/item/2',
        'https://myfigurecollection.net/item/1',
      ],
    });
    expect((out as { nextFrom?: number }).nextFrom).toBeUndefined();
  });

  it('clamps count to [1, 200] and defaults it to 50', () => {
    const cat = assembleCatalog(services(MFC));
    expect((cat.idRange('mfc', 1000, 100000) as { count: number }).count).toBe(200);
    expect((cat.idRange('mfc', 1000, 0) as { count: number }).count).toBe(1);
    expect((cat.idRange('mfc', 1000) as { count: number }).count).toBe(50);
  });

  it('unsupported for an unknown store, a store without byRange, and a store without a byId template', () => {
    const noRange: StoreCapabilities = { ...MFC, siteId: 'orzgk', domains: ['www.orzgk.com'], retrieval: { byId: { urlTemplate: 'https://www.orzgk.com/p/{id}' } } };
    const noById: StoreCapabilities = { ...MFC, siteId: 'noid', domains: ['noid.test'], retrieval: { byRange: true } };
    const cat = assembleCatalog(services(MFC, noRange, noById));

    expect(cat.idRange('nope', 10, 1)).toEqual({ status: 'unsupported', siteId: 'nope', reason: 'unknown store' });
    expect(cat.idRange('orzgk', 10, 1)).toMatchObject({ status: 'unsupported', siteId: 'orzgk' });
    expect((cat.idRange('orzgk', 10, 1) as { reason: string }).reason).toContain('byRange');
    expect(cat.idRange('noid', 10, 1)).toMatchObject({ status: 'unsupported', siteId: 'noid' });
    expect((cat.idRange('noid', 10, 1) as { reason: string }).reason).toContain('byId');
  });

  it("reports 'cooldown' — not a window — while the store's own item host is cooling from a challenge", () => {
    const svc = services(MFC);
    svc.challengeCooldown!.open('myfigurecollection.net', 'ingest challenge page');
    const out = assembleCatalog(svc).idRange('mfc', 3630000, 5);
    expect(out).toEqual({ status: 'cooldown', siteId: 'mfc', host: 'myfigurecollection.net', remainingMs: 30 * 60_000 });
  });

  it('a cooldown on a DIFFERENT host leaves the window alone (the gate is per host)', () => {
    const svc = services(MFC);
    svc.challengeCooldown!.open('anitoysgk.com', 'ingest challenge page');
    expect(assembleCatalog(svc).idRange('mfc', 10, 2).status).toBe('ok');
  });

  it('failed for a `from` that is not a positive safe integer', () => {
    const cat = assembleCatalog(services(MFC));
    for (const from of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      const out = cat.idRange('mfc', from, 1);
      expect(out.status).toBe('failed');
      expect((out as { reason: string }).reason).toContain('from');
    }
  });
});
