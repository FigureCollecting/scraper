/**
 * isCloudflareChallenge — a pure, conservative predicate for "is this HTML a Cloudflare
 * interstitial challenge rather than the real page?". It must fire on the CF managed-JS / IUAM
 * challenge markers but NEVER on a real product page that merely mentions Cloudflare.
 */
import { isCloudflareChallenge } from '../../../services/engineServices/challengeDetect';

describe('isCloudflareChallenge', () => {
  describe('challenge pages → true', () => {
    it('matches the CF managed-challenge <title>Just a moment...</title>', () => {
      const html =
        '<html><head><title>Just a moment...</title></head><body>cf challenge</body></html>';
      expect(isCloudflareChallenge(html)).toBe(true);
    });

    it('matches the cdn-cgi challenge-platform loader script', () => {
      const html =
        '<html><head></head><body><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></body></html>';
      expect(isCloudflareChallenge(html)).toBe(true);
    });

    it('matches the __cf_chl_ script global', () => {
      const html = '<html><body><script>window.__cf_chl_ = {};</script></body></html>';
      expect(isCloudflareChallenge(html)).toBe(true);
    });

    it('matches the _cf_chl_opt options global', () => {
      const html = '<html><body><script>window._cf_chl_opt={cvId:"3"};</script></body></html>';
      expect(isCloudflareChallenge(html)).toBe(true);
    });

    it('matches the legacy cf-browser-verification marker', () => {
      const html = '<html><body><div class="cf-browser-verification"></div></body></html>';
      expect(isCloudflareChallenge(html)).toBe(true);
    });

    it('matches the IUAM "Checking your browser before accessing" copy', () => {
      const html = '<html><body><h1>Checking your browser before accessing example.com</h1></body></html>';
      expect(isCloudflareChallenge(html)).toBe(true);
    });

    it('matches a full anitoysgk-shaped managed-challenge interstitial (~markers combined)', () => {
      const html =
        '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>' +
        '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>' +
        '<body class="no-js"><div class="main-wrapper"><div class="main-content">' +
        '<h1><span data-translate="checking_browser">Checking your browser before accessing</span></h1>' +
        '</div></div><script>window._cf_chl_opt={cvId:"3",cType:"managed"};</script>' +
        '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';
      expect(isCloudflareChallenge(html)).toBe(true);
    });
  });

  describe('real pages → false (fixtures already present in repo tests)', () => {
    // Drawn verbatim from existing repo test fixtures so we prove no false positive on real content.
    const REAL_PAGES: Array<[string, string]> = [
      // src/__tests__/unit/scrapeQueueIngest.test.ts  (FIXTURE_HTML)
      ['scrapeQueueIngest FIXTURE_HTML', '<html><body><h1 class="title">Kitagawa Marin</h1></body></html>'],
      // src/__tests__/unit/impitFetch.test.ts  (REAL)
      ['impitFetch REAL', '<html><body>Star Origin Studio 1/6 Lucy — real product page</body></html>'],
      // src/__tests__/unit/*  (unparseable-JSON body fixture)
      ['json-pre body', '<html><head></head><body><pre>{"name":"Cannot Parse Me"}</pre></body></html>'],
      // src/__tests__/unit/*  (raw-capture fixture)
      ['raw-capture fixture', '<html><body><div class="data-field">raw capture fixture</div></body></html>'],
    ];

    it.each(REAL_PAGES)('does not match real page: %s', (_label, html) => {
      expect(isCloudflareChallenge(html)).toBe(false);
    });

    it('does not match a real page that merely MENTIONS Cloudflare / cf in prose', () => {
      const html =
        '<html><head><title>Nendoroid Reze — Figure Store</title></head><body>' +
        '<p>This site is protected by Cloudflare. Buy the cf-limited edition figure now!</p>' +
        '<div class="challenge">Weekly painting challenge results</div></body></html>';
      expect(isCloudflareChallenge(html)).toBe(false);
    });
  });

  describe('degenerate input → false', () => {
    it('returns false for an empty string', () => {
      expect(isCloudflareChallenge('')).toBe(false);
    });

    it('returns false for a non-string value', () => {
      // Defensive: callers hand us res.text() which is always a string, but guard anyway.
      expect(isCloudflareChallenge(undefined as unknown as string)).toBe(false);
      expect(isCloudflareChallenge(null as unknown as string)).toBe(false);
    });
  });
});
