/**
 * isCloudflareChallenge — a pure, conservative predicate for "is this HTML a Cloudflare
 * interstitial challenge rather than the real page?". It must fire on the CF managed-JS / IUAM
 * challenge markers but NEVER on a real product page that merely mentions Cloudflare.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { isCloudflareChallenge } from '../../../services/engineServices/challengeDetect';

/** Load a real captured HTML fixture (verbatim store bytes) from the shared fixtures dir. */
const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../../fixtures/challengeDetect', name), 'utf8');

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

  describe('real store pages carrying Cloudflare Bot-Management telemetry → false (RS-1/RD-1/F1 regression)', () => {
    // These fixtures are built from REAL 200-OK product pages captured on disk. Each carries
    // Cloudflare's Bot-Management telemetry script — /cdn-cgi/challenge-platform/scripts/jsd/main.js
    // (inline `document.createElement` bootstrap) or /cdn-cgi/challenge-platform/scripts/precursor/main.js
    // (a plain <script src>) — which Cloudflare injects into ORDINARY pages on bot-managed zones.
    // The bare token 'challenge-platform' matched all of them, hard-failing every real fnc (http
    // transport) / bbts / MFC ingest as a phantom challenge. A real page must NEVER match.
    const REAL_FIXTURES = [
      'fnc-product.html',
      'fnc-detail.html',
      'bbts-product.html',
      'mfc-item.html',
      'mfc-shops.html',
    ];

    it.each(REAL_FIXTURES)('does not flag real product page fixture: %s', (name) => {
      const html = fixture(name);
      // sanity: the fixture really does carry the injected telemetry script (the old FP trigger)…
      expect(html).toContain('challenge-platform');
      // …and none of the genuine challenge/block markers…
      expect(html).not.toMatch(/__cf_chl_|_cf_chl_opt|cf-browser-verification|Just a moment|Checking your browser|orchestrate\/chl_page/i);
      // …so the conservative detector must return false.
      expect(isCloudflareChallenge(html)).toBe(false);
    });

    it('does not flag the inline jsd Bot-Management bootstrap in isolation', () => {
      // Verbatim shape Cloudflare injects into real 200 pages (bbts/MFC form).
      const html =
        "<html><head><title>Nendoroid Kanna — Figure Store</title></head><body><h1>Buy now</h1>" +
        "<script>var a=document.createElement('script');a.nonce='';a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);</script></body></html>";
      expect(isCloudflareChallenge(html)).toBe(false);
    });

    it('does not flag the precursor Bot-Management <script src> in isolation (fnc form)', () => {
      const html =
        '<html><head><title>Griffith 1/4 — FNC ANIME</title>' +
        '<script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js"></script></head><body>In stock</body></html>';
      expect(isCloudflareChallenge(html)).toBe(false);
    });

    it('STILL flags the genuine challenge loader (orchestrate/chl_page) — the real interstitial (regression pin)', () => {
      // The one challenge-platform path that IS a challenge: the orchestrate/chl_page loader. Dropping
      // the bare token must not blind the detector to the real interstitial.
      const html =
        '<html><head><title>Just a moment...</title></head><body>' +
        '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=abc"></script></body></html>';
      expect(isCloudflareChallenge(html)).toBe(true);
    });
  });

  describe('Cloudflare block / rate-limit error pages → true (RD-2)', () => {
    // A CF 1020 block / 1015 rate-limit body is NOT the product page either — a ruleset lifts an
    // empty bag from it exactly like a challenge, so the transport must reject it (else it is sent
    // to the spine as an empty record and misclassified 'unknown' instead of rate_limited).
    it.each(['cf-block-1020-amiami.html', 'cf-block-1020-sugo.html'])(
      'flags a real CF 1020 "Attention Required!" block page: %s',
      (name) => {
        const html = fixture(name);
        expect(html).toContain('Attention Required! | Cloudflare');
        expect(isCloudflareChallenge(html)).toBe(true);
      },
    );

    it('flags a CF 1015 rate-limit body ("You are being rate limited")', () => {
      const html =
        '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>' +
        '<div id="cf-error-details" class="cf-error-details-wrapper"><h1>Sorry, you have been blocked</h1>' +
        '<span data-translate="error">Error 1015</span><p>You are being rate limited</p></div></body></html>';
      expect(isCloudflareChallenge(html)).toBe(true);
    });

    it('flags the newer "Access denied … used Cloudflare to restrict access" 1020 title', () => {
      const html =
        '<!DOCTYPE html><html><head><title>Access denied | www.anitoysgk.com used Cloudflare to restrict access</title>' +
        '</head><body><h1>Error 1020</h1><p>This website is using a security service to protect itself.</p></body></html>';
      expect(isCloudflareChallenge(html)).toBe(true);
    });

    it('does NOT flag a real page merely using the words "attention" or "blocked" in prose (conservative)', () => {
      const html =
        '<html><head><title>Blocked Colors — Nendoroid Store</title></head><body>' +
        '<p>Attention: limited stock. This colorway sold out and was blocked from reorders.</p></body></html>';
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
