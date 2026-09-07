import { jest } from '@jest/globals';
import { makeFetchSearch } from '../../services/fetchSearch';
import { resolveBrowserLaneOptions } from '../../services/residentialEgress';
import { warnDroppedBrowserPrime } from '../../services/sessionPrime';

/**
 * The DECLARED half of the challenge gate (`SearchFetch.access: 'cloudflare'`). Learning a gate from
 * a `cf-mitigated` response works, but it costs one full challenge on a cold host every time the
 * process restarts; a store that is known to gate says so, and its very first fetch already keeps
 * its context. The declaration also carries `sessionPrime` onto the browser lane — anitoys' search
 * results 404 without a same-session homepage visit.
 */
describe('challenge-gate declaration (SearchFetch.access)', () => {
  /**
   * `sessionPrime` reaches the BROWSER lane only through `access: 'cloudflare'` (contract 0.7.0:
   * priming a cold session costs a whole extra navigation, so it rides the declaration that keeps
   * the context). A store declaring the prime WITHOUT the gate therefore gets no priming navigation —
   * which used to happen in complete silence, and looks exactly like a ruleset that suddenly 404s.
   */
  const transports = () => ({
    http: jest.fn<(...a: any[]) => any>().mockResolvedValue('http-body'),
    impersonate: jest.fn<(...a: any[]) => any>().mockResolvedValue('impit-body'),
    browser: jest.fn<(...a: any[]) => any>().mockResolvedValue('browser-body'),
  });

  describe('a browser-lane sessionPrime with no gate declared', () => {
    it('warns ONCE per host that the prime is not applied', () => {
      const warn = jest.fn();
      const searchFetch = { transport: 'browser' as const, sessionPrime: true };

      warnDroppedBrowserPrime(searchFetch, 'https://shop.example.test/search?q=a', warn);
      warnDroppedBrowserPrime(searchFetch, 'https://shop.example.test/search?q=b', warn);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('sessionPrime');
      expect(warn.mock.calls[0][0]).toContain("access: 'cloudflare'");
    });

    it('says nothing when the gate IS declared, or when no prime is declared', () => {
      const warn = jest.fn();

      warnDroppedBrowserPrime({ transport: 'browser', sessionPrime: true, access: 'cloudflare' }, 'https://gated.example.test/x', warn);
      warnDroppedBrowserPrime({ transport: 'browser' }, 'https://plain.example.test/x', warn);

      expect(warn).not.toHaveBeenCalled();
    });

    it('is raised by the search dispatcher itself, not only by the helper', async () => {
      const warn = jest.fn();
      const t = transports();
      const fetchSearch = makeFetchSearch(t, { warn });

      await fetchSearch('https://dispatched.example.test/search?q=lucy', { transport: 'browser', sessionPrime: true });

      expect(t.browser).toHaveBeenCalledWith('https://dispatched.example.test/search?q=lucy', expect.not.objectContaining({ primeUrl: expect.anything() }));
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchSearch → browser transport', () => {
    const transports = () => ({
      http: jest.fn<(...a: any[]) => any>().mockResolvedValue('http-body'),
      impersonate: jest.fn<(...a: any[]) => any>().mockResolvedValue('impit-body'),
      browser: jest.fn<(...a: any[]) => any>().mockResolvedValue('browser-body'),
    });

    it('flags the fetch challenge-gated and passes the session prime URL', async () => {
      const t = transports();
      const fetchSearch = makeFetchSearch(t, { residentialProxyUrl: () => 'socks5://127.0.0.1:1055' });

      await fetchSearch('https://www.anitoysgk.com/search?q=lucy', {
        transport: 'browser',
        egress: 'residential',
        access: 'cloudflare',
        sessionPrime: true,
      });

      expect(t.browser).toHaveBeenCalledWith(
        'https://www.anitoysgk.com/search?q=lucy',
        expect.objectContaining({
          challengeGated: true,
          primeUrl: 'https://www.anitoysgk.com',
          proxyServer: 'socks5://127.0.0.1:1055',
        }),
      );
    });

    it('honours an explicit primeUrl override', async () => {
      const t = transports();
      const fetchSearch = makeFetchSearch(t);

      await fetchSearch('https://sugotoys.com.au/wp-json/wc/store/products?search=lucy', {
        transport: 'browser',
        access: 'cloudflare',
        sessionPrime: { primeUrl: 'https://sugotoys.com.au/shop' },
      });

      expect(t.browser).toHaveBeenCalledWith(
        'https://sugotoys.com.au/wp-json/wc/store/products?search=lucy',
        expect.objectContaining({ challengeGated: true, primeUrl: 'https://sugotoys.com.au/shop' }),
      );
    });

    it('adds neither key for a store that declares neither (byte-identical to before)', async () => {
      const t = transports();
      const fetchSearch = makeFetchSearch(t);

      await fetchSearch('https://alpha.example.test/search?q=lucy', { transport: 'browser' });

      const options = t.browser.mock.calls[0][1] as Record<string, unknown>;
      expect(options).not.toHaveProperty('challengeGated');
      expect(options).not.toHaveProperty('primeUrl');
    });
  });

  describe('resolveBrowserLaneOptions (the /resolve + ExtractContext door)', () => {
    it('carries the gate and the prime onto the browser lane', () => {
      const options = resolveBrowserLaneOptions(
        'https://www.anitoysgk.com/lucy-p29358268.html',
        { transport: 'browser', egress: 'residential', access: 'cloudflare', sessionPrime: true },
        'socks5://127.0.0.1:1055',
      );

      expect(options).toEqual({
        proxyServer: 'socks5://127.0.0.1:1055',
        challengeGated: true,
        primeUrl: 'https://www.anitoysgk.com',
      });
    });

    it('a gated store with no egress declaration still rides the gated browser', () => {
      const options = resolveBrowserLaneOptions('https://hobby-genki.com/item/1', { access: 'cloudflare' }, undefined);

      expect(options).toEqual({ challengeGated: true });
    });

    it('an undeclared store resolves to undefined (the pre-0.7.0 call shape)', () => {
      expect(resolveBrowserLaneOptions('https://alpha.example.test/1', { transport: 'http' }, undefined)).toBeUndefined();
      expect(resolveBrowserLaneOptions('https://alpha.example.test/1', { access: 'open' }, undefined)).toBeUndefined();
    });
  });
});
