/**
 * recordFetchGate — the PURE verdict on one record fetch's response metadata.
 *
 * The record lane used to be status-blind: whatever bytes came back were handed to the ruleset, so
 * a store's 404 body, a busy 5xx, and an item URL that bounced to the shop's front page all reached
 * the ledger as `parse` / `other` / an empty record — a verdict against OUR ruleset for something
 * the STORE said. These cases fix what the gate must say about each.
 */
import { evaluateRecordFetch, isRedirectHome, RecordFetchStatusError } from '../../services/recordFetchGate';

const ITEM = 'https://store.example.test/product/12345';

describe('evaluateRecordFetch — failing statuses', () => {
  it.each([404, 410, 403, 429, 500, 503, 400, 451])('flags HTTP %s as a fetch failure carrying the status', (status) => {
    const failure = evaluateRecordFetch(ITEM, { status, finalUrl: ITEM }, 'http');
    expect(failure).toBeInstanceOf(RecordFetchStatusError);
    expect(failure!.status).toBe(status);
    expect(failure!.url).toBe(ITEM);
    expect(failure!.transport).toBe('http');
    expect(failure!.redirectedHome).toBe(false);
  });

  it.each([200, 201, 204, 206, 301, 302, 399])('passes HTTP %s through (no verdict)', (status) => {
    expect(evaluateRecordFetch(ITEM, { status, finalUrl: ITEM }, 'http')).toBeUndefined();
  });

  it('passes a lane that surfaced NO status (a bare string transport) through untouched', () => {
    expect(evaluateRecordFetch(ITEM, {}, 'browser')).toBeUndefined();
  });

  it('ignores a sentinel status no HTTP response can carry', () => {
    expect(evaluateRecordFetch(ITEM, { status: 0 }, 'http')).toBeUndefined();
    expect(evaluateRecordFetch(ITEM, { status: 999 }, 'http')).toBeUndefined();
  });

  it('names the status in the message and never invents a redirect for it', () => {
    const failure = evaluateRecordFetch(ITEM, { status: 404 }, 'impersonate')!;
    expect(failure.message).toContain('404');
    expect(failure.message).toContain(ITEM);
    expect(failure.name).toBe('RecordFetchStatusError');
    expect(failure.finalUrl).toBeUndefined();
  });
});

describe('evaluateRecordFetch — an item URL that landed on the store home page', () => {
  it('flags a redirect to the store root', () => {
    const failure = evaluateRecordFetch(ITEM, { status: 200, finalUrl: 'https://store.example.test/' }, 'browser');
    expect(failure).toBeInstanceOf(RecordFetchStatusError);
    expect(failure!.redirectedHome).toBe(true);
    expect(failure!.finalUrl).toBe('https://store.example.test/');
    expect(failure!.status).toBe(200);
    expect(failure!.message).toContain('home');
  });

  it('flags the redirect from a lane that surfaced the final URL but NO status (browser without a statusCode)', () => {
    const failure = evaluateRecordFetch(ITEM, { finalUrl: 'https://store.example.test/' }, 'browser')!;
    expect(failure.redirectedHome).toBe(true);
    expect(failure.status).toBeUndefined();
  });

  it('lets a FAILING status win over the redirect (the status is the more specific truth)', () => {
    const failure = evaluateRecordFetch(ITEM, { status: 404, finalUrl: 'https://store.example.test/' }, 'http')!;
    expect(failure.status).toBe(404);
    expect(failure.redirectedHome).toBe(false);
  });
});

describe('isRedirectHome', () => {
  it.each([
    ['https://store.example.test/'],
    ['https://store.example.test'],
    ['https://store.example.test/?redirected=1'],
    ['https://www.store.example.test/'],
  ])('is true when the fetch ended on a bare root (%s)', (finalUrl) => {
    expect(isRedirectHome(ITEM, finalUrl)).toBe(true);
  });

  it.each([
    ['https://store.example.test/product/12345'],
    ['https://store.example.test/product/12345?utm=1'],
    ['https://store.example.test/product/99999'],
    ['https://store.example.test/search?q=x'],
  ])('is false when the fetch ended on a real path (%s)', (finalUrl) => {
    expect(isRedirectHome(ITEM, finalUrl)).toBe(false);
  });

  it('is false when the lane surfaced no final URL', () => {
    expect(isRedirectHome(ITEM, undefined)).toBe(false);
  });

  it('is false when the REQUESTED url is itself the home page (nothing was redirected away)', () => {
    expect(isRedirectHome('https://store.example.test/', 'https://store.example.test/')).toBe(false);
  });

  it('is false when either url is unparseable — never guesses', () => {
    expect(isRedirectHome('not a url', 'https://store.example.test/')).toBe(false);
    expect(isRedirectHome(ITEM, 'not a url')).toBe(false);
  });
});

/**
 * A LOCALE ROOT is a home page too. hobbysearch (1999.co.jp) answers a dead item /eng/19999999 with
 * a 200 that landed on /eng/ (live capture 2026-09-23). A bare language segment is never where a
 * record lives, so a same-site redirect to one is redirect_home exactly like "/".
 */
describe('isRedirectHome — a locale root', () => {
  const HS_ITEM = 'https://www.1999.co.jp/eng/19999999';

  it('is true for the live hobbysearch bounce /eng/19999999 -> /eng/', () => {
    expect(isRedirectHome(HS_ITEM, 'https://www.1999.co.jp/eng/')).toBe(true);
  });

  it.each([
    ['https://store.example.test/eng/'],
    ['https://store.example.test/en'],
    ['https://store.example.test/ja/'],
    ['https://store.example.test/zh-cn/'],
    ['https://store.example.test/EN/'],
    ['https://store.example.test/pt_BR/'],
    ['https://store.example.test/zh-Hant/'],
    ['https://store.example.test/es-419'],
    ['https://store.example.test/ja/?from=item'],
    ['https://www.store.example.test/en/'],
    ['https://store.example.test/zh-hans/'],
    ['https://store.example.test/jpn/'],
  ])('is true when an item fetch ended on the locale root %s', (finalUrl) => {
    expect(isRedirectHome(ITEM, finalUrl)).toBe(true);
  });

  it.each([
    ['https://store.example.test/eng/123'],
    ['https://store.example.test/english/'],
    ['https://store.example.test/english-figures/'],
    ['https://store.example.test/products/'],
    ['https://store.example.test/e/'],
    ['https://store.example.test/en-/'],
    ['https://store.example.test/en-us-x/'],
    ['https://store.example.test/12/'],
    ['https://store.example.test/en//'],
    ['https://store.example.test/zh-bogus/'],
    // Root-slug stores (BigCommerce) keep categories, brands and renamed products at /<slug>/.
    ['https://store.example.test/on-sale/'],
    ['https://store.example.test/my-hero/'],
    ['https://store.example.test/abs-slug/'],
    ['https://store.example.test/rem-maid/'],
    ['https://store.example.test/so_ta'],
    ['https://store.example.test/ryu_ns'],
    ['https://store.example.test/re_ment'],
    ['https://store.example.test/lim_land'],
    // A real language with a 4-letter word that is not a script code.
    ['https://store.example.test/de-luxe/'],
    ['https://store.example.test/it-girl/'],
    // Short words are not languages.
    ['https://store.example.test/new/'],
    ['https://store.example.test/faq/'],
    ['https://store.example.test/top/'],
    ['https://store.example.test/shop/'],
    ['https://store.example.test/sale/'],
    ['https://store.example.test/news/'],
  ])('is false for a path that is not a bare locale root (%s)', (finalUrl) => {
    expect(isRedirectHome(ITEM, finalUrl)).toBe(false);
  });

  it('is false for a redirect to a locale root on ANOTHER site', () => {
    expect(isRedirectHome(ITEM, 'https://other.example.org/en/')).toBe(false);
    expect(isRedirectHome(HS_ITEM, 'https://www.1999.co.jp.evil.test/eng/')).toBe(false);
    expect(isRedirectHome('https://1999.co.jp/eng/1', 'https://evil1999.co.jp/eng/')).toBe(false);
    expect(isRedirectHome('https://evil1999.co.jp/eng/1', 'https://1999.co.jp/eng/')).toBe(false);
  });

  it('is true for a locale root on the apex of a www. item (either subdomain direction)', () => {
    expect(isRedirectHome('https://www.s.test/product/1', 'https://s.test/en/')).toBe(true);
  });

  it('keeps a bounce to "/" as redirect_home even when the requested path looks like a locale', () => {
    expect(isRedirectHome('https://store.example.test/abs-slug/', 'https://store.example.test/')).toBe(true);
    expect(isRedirectHome('https://store.example.test/ssr-miku/', 'https://store.example.test/')).toBe(true);
    expect(isRedirectHome('https://store.example.test/en?pid=5', 'https://store.example.test/')).toBe(true);
    expect(isRedirectHome('https://store.example.test/pid?x=5', 'https://store.example.test/')).toBe(true);
    expect(isRedirectHome('https://store.example.test/eng', 'https://store.example.test/')).toBe(true);
  });

  it('is false when nothing was redirected (the fetch stayed on the item)', () => {
    expect(isRedirectHome(HS_ITEM, HS_ITEM)).toBe(false);
  });

  it('is false when the REQUEST was for the locale root itself', () => {
    expect(isRedirectHome('https://www.1999.co.jp/eng/', 'https://www.1999.co.jp/eng/')).toBe(false);
    expect(isRedirectHome('https://www.1999.co.jp/eng', 'https://www.1999.co.jp/eng/')).toBe(false);
    expect(isRedirectHome('https://www.1999.co.jp/eng/', 'https://www.1999.co.jp/ja/')).toBe(false);
  });

  it('flags the gate verdict as redirectedHome with the landed url, and a failing status still wins', () => {
    const failure = evaluateRecordFetch(HS_ITEM, { status: 200, finalUrl: 'https://www.1999.co.jp/eng/' }, 'http')!;
    expect(failure.redirectedHome).toBe(true);
    expect(failure.finalUrl).toBe('https://www.1999.co.jp/eng/');
    expect(evaluateRecordFetch(HS_ITEM, { status: 404, finalUrl: 'https://www.1999.co.jp/eng/' }, 'http')!.redirectedHome).toBe(false);
  });
});

/**
 * THE AMBIGUOUS-404 TABLE (owner rule, 2026-09-09). On myfigurecollection.net a 404 is not proof
 * that anything is gone: NSFW and NSFW+ items answer 404 to a session that is not entitled (age
 * gate, or stale scrape-account cookies), and the site gives no way to tell that apart from a
 * genuinely missing item. A store in the table therefore produces a DENIED-OR-GONE failure, which
 * the ledger books as http_403 (review, re-mintable) instead of gone_404 (auto-closed as removed).
 */
describe('evaluateRecordFetch — stores where a 404 is ambiguous', () => {
  const MFC_ITEM = 'https://myfigurecollection.net/item/999999999';

  it('marks an mfc 404 as denied-or-gone and says why in the message', () => {
    const failure = evaluateRecordFetch(MFC_ITEM, { status: 404, finalUrl: MFC_ITEM }, 'impersonate')!;

    expect(failure.deniedOrGone).toBe(true);
    expect(failure.status).toBe(404);
    // the exact operator-facing token the owner specified
    expect(failure.message).toContain('mfc 404: denied-or-gone, session may need re-minting');
    expect(failure.deniedOrGoneSite).toBe('mfc');
  });

  it.each([
    'https://www.myfigurecollection.net/item/1',
    'https://myfigurecollection.net/item/1',
  ])('applies to the store\'s own hosts (%s)', (url) => {
    expect(evaluateRecordFetch(url, { status: 404 }, 'http')!.deniedOrGone).toBe(true);
  });

  it('does NOT apply to a look-alike host outside the store', () => {
    expect(
      evaluateRecordFetch('https://myfigurecollection.net.evil.test/item/1', { status: 404 }, 'http')!.deniedOrGone,
    ).toBe(false);
  });

  it('leaves every other store\'s 404 unambiguous', () => {
    expect(evaluateRecordFetch(ITEM, { status: 404 }, 'http')!.deniedOrGone).toBe(false);
  });

  it.each([410, 403, 503])('does not touch an mfc %s — only 404 is the ambiguous one', (status) => {
    const failure = evaluateRecordFetch(MFC_ITEM, { status }, 'impersonate')!;
    expect(failure.deniedOrGone).toBe(false);
    expect(failure.message).not.toContain('denied-or-gone');
  });

  it('leaves an mfc bounce to the home page as a plain redirect (nothing to do with entitlement)', () => {
    const failure = evaluateRecordFetch(MFC_ITEM, { status: 200, finalUrl: 'https://myfigurecollection.net/' }, 'browser')!;
    expect(failure.redirectedHome).toBe(true);
    expect(failure.deniedOrGone).toBe(false);
  });
});

/**
 * A RULESET-DECLARED GONE PAGE. Some stores answer a removed item with their own error page and a
 * 5xx instead of a 404. Left to the status alone that is a transient `http_5xx`, retried to
 * exhaustion. A ruleset that declares its store's gone page turns a matching answer into a
 * denied-or-gone failure on first sight; a status or body that does not match is untouched.
 */
describe('evaluateRecordFetch — a ruleset-declared gone page', () => {
  const GONE_HTML = '<html><head><title>Error Page | EXAMPLE STORE</title></head><body>oops</body></html>';
  const gonePage = { statuses: [500], titleIncludes: 'Error Page | EXAMPLE STORE' };

  it('marks a declared status carrying the declared title as denied-or-gone', () => {
    const failure = evaluateRecordFetch(ITEM, { status: 500, finalUrl: ITEM, html: GONE_HTML }, 'http', gonePage)!;
    expect(failure.deniedOrGone).toBe(true);
    expect(failure.declaredGone).toBe(true);
    expect(failure.status).toBe(500);
    expect(failure.message).toContain('declared gone page');
  });

  it('leaves the same status WITHOUT the marker as a plain status failure', () => {
    const failure = evaluateRecordFetch(ITEM, { status: 500, html: '<title>Busy</title>' }, 'http', gonePage)!;
    expect(failure.deniedOrGone).toBe(false);
    expect(failure.declaredGone).toBe(false);
    expect(failure.message).toContain('HTTP 500');
  });

  it('never fires on a status the declaration does not list (a 200 carrying the marker passes)', () => {
    expect(evaluateRecordFetch(ITEM, { status: 200, finalUrl: ITEM, html: GONE_HTML }, 'http', gonePage)).toBeUndefined();
    expect(evaluateRecordFetch(ITEM, { status: 503, html: GONE_HTML }, 'http', gonePage)!.declaredGone).toBe(false);
  });

  it('matches a body marker, and requires EVERY declared marker', () => {
    const body = { statuses: [500], bodyIncludes: 'item-removed' };
    expect(evaluateRecordFetch(ITEM, { status: 500, html: '<p class="item-removed"></p>' }, 'http', body)!.declaredGone).toBe(true);
    const both = { statuses: [500], titleIncludes: 'Error Page | EXAMPLE STORE', bodyIncludes: 'item-removed' };
    expect(evaluateRecordFetch(ITEM, { status: 500, html: GONE_HTML }, 'http', both)!.declaredGone).toBe(false);
  });

  it('reads the title with its whitespace collapsed, not the raw markup', () => {
    const html = '<html><head><TITLE lang="en">\n  Error Page |\n  EXAMPLE STORE </TITLE></head></html>';
    expect(evaluateRecordFetch(ITEM, { status: 500, html }, 'http', gonePage)!.declaredGone).toBe(true);
    // a title marker is looked for in the title only — the same text in the body is not the title
    expect(
      evaluateRecordFetch(ITEM, { status: 500, html: '<body>Error Page | EXAMPLE STORE</body>' }, 'http', gonePage)!.declaredGone,
    ).toBe(false);
  });

  it('never matches a declaration with no marker, a lane that surfaced no body, or a malformed declaration', () => {
    expect(evaluateRecordFetch(ITEM, { status: 500, html: GONE_HTML }, 'http', { statuses: [500] })!.declaredGone).toBe(false);
    expect(evaluateRecordFetch(ITEM, { status: 500, html: GONE_HTML }, 'http', { statuses: [500], titleIncludes: '' })!.declaredGone).toBe(false);
    expect(evaluateRecordFetch(ITEM, { status: 500 }, 'http', gonePage)!.declaredGone).toBe(false);
    const malformed = { statuses: 500 } as unknown as { statuses: number[] };
    expect(evaluateRecordFetch(ITEM, { status: 500, html: GONE_HTML }, 'http', { ...malformed, titleIncludes: 'Error' })!.declaredGone).toBe(false);
  });

  it('leaves the ambiguous-404 table and an undeclared ruleset exactly as before', () => {
    expect(evaluateRecordFetch(ITEM, { status: 500, html: GONE_HTML }, 'http')!.deniedOrGone).toBe(false);
    const mfc = evaluateRecordFetch('https://myfigurecollection.net/item/1', { status: 404 }, 'http', gonePage)!;
    expect(mfc.deniedOrGone).toBe(true);
    expect(mfc.declaredGone).toBe(false);
    expect(mfc.message).toContain('mfc 404: denied-or-gone');
  });
});
