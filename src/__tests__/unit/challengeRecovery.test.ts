/**
 * challengeRecovery — the pure halves of the NAME-ERRPAGE-1 recovery evidence: what counts as a follow-up that
 * answered a real page, and which record names were lifted from the challenge page itself.
 */
import { isRecoveredBody, nameLiftedFromChallenge } from '../../services/challengeRecovery';

const CF_522 =
  '<html><head><title>myfigurecollection.net | 522: Connection timed out</title></head><body><div id="cf-error-details">'
  + '<h1>\n  <span class="inline-block">Connection timed out</span>\n  <span class="code-label">Error code 522</span>\n</h1></div></body></html>';
const BLOCK_1020 = '<html><head><title>Attention Required! | Cloudflare</title></head><body><h1 data-x="1">Sorry, you have been blocked</h1></body></html>';
const rec = (fields: Record<string, unknown>) => ({ fields });

describe('isRecoveredBody', () => {
  it.each([
    ['a real page, 200', '<h1>Kurumi</h1>', 200, undefined, true],
    ['a real page, status not observed', '{"item":{}}', undefined, undefined, true],
    ['flagged by the lane', '<h1>Kurumi</h1>', 200, true, false],
    ['a blank body', '  \n ', 200, undefined, false],
    ['not a string', undefined, 200, undefined, false],
    ['a 199', '<h1>x</h1>', 199, undefined, false],
    ['a 300', '<h1>x</h1>', 300, undefined, false],
    ['a CF interstitial served 200', '<title>Just a moment...</title><script>window._cf_chl_opt={}</script>', 200, undefined, false],
  ])('%s', (_l, html, status, challenge, want) => {
    expect(isRecoveredBody(html, status as number | undefined, challenge as boolean | undefined)).toBe(want);
  });
});

describe('nameLiftedFromChallenge', () => {
  it("finds a name that is the challenge page's own h1 (spans, newlines, case)", () => {
    expect(nameLiftedFromChallenge([rec({ name: 'Connection timed out Error code 522' })], CF_522)).toBe('name');
    expect(nameLiftedFromChallenge([rec({ itemName: 'CONNECTION  TIMED OUT\nerror code 522' })], CF_522)).toBe('itemName');
  });

  it("finds a name that is the page's own <title>, entities decoded", () => {
    const page = '<html><head><title>Fish &amp; Chips &quot;Store&quot;</title></head><body></body></html>';
    expect(nameLiftedFromChallenge([rec({ title: 'Fish & Chips "Store"' })], page)).toBe('title');
    expect(nameLiftedFromChallenge([rec({ title: 'Fish &bogus; Chips' })], '<title>Fish &bogus; Chips</title>')).toBe('title');
  });

  it('checks every record of an extractMany', () => {
    expect(nameLiftedFromChallenge([rec({ name: 'Real Figure' }), rec({ name: 'Sorry, you have been blocked' })], BLOCK_1020)).toBe('name');
  });

  it('a recovered name, a non-name key or a non-string value is not lifted', () => {
    expect(nameLiftedFromChallenge([rec({ name: 'Hatsune Miku 1/7' })], BLOCK_1020)).toBeUndefined();
    expect(nameLiftedFromChallenge([rec({ description: 'Sorry, you have been blocked' })], BLOCK_1020)).toBeUndefined();
    expect(nameLiftedFromChallenge([rec({ name: 1020 })], BLOCK_1020)).toBeUndefined();
    expect(nameLiftedFromChallenge([{}], BLOCK_1020)).toBeUndefined();
  });

  it('a page with no title or h1 lifts nothing', () => {
    expect(nameLiftedFromChallenge([rec({ name: '' })], '<html><body><p>cf</p></body></html>')).toBeUndefined();
    expect(nameLiftedFromChallenge([rec({ name: '' })], '<title>  </title>')).toBeUndefined();
  });
});
