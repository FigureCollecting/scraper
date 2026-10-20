import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountDataModeFromEnv, redactAccountData } from '../../services/captureRedaction';

// A SYNTHETIC logged-in item page, shaped like the stored ones (header user-menu, viewer-state
// targets in #content and #side, the comment composer, inline ad-tech identity scripts). Every value
// in it is invented; no captured page is used as a fixture.
const LOGGED_IN = readFileSync(join(__dirname, '../fixtures/mfc/item-logged-in-synthetic.html'), 'utf8');
const ITEM_URL = 'https://myfigurecollection.net/item/1';
const VIEWER = 'scrapeuser';

const redacted = (html: string, url = ITEM_URL): string => {
  const out = redactAccountData(url, Buffer.from(html, 'utf8'));
  if (out.kind !== 'redacted') throw new Error(`expected redacted, got ${out.kind}`);
  return out.bytes.toString('utf8');
};

/** The exact original bytes of the first element opened by `open`, through its matching close. */
const region = (html: string, open: string, close: string): string => {
  const start = html.indexOf(open);
  const end = html.indexOf(close, start) + close.length;
  return html.slice(start, end);
};

describe('accountDataModeFromEnv — RAW_CAPTURE_ACCOUNT_DATA', () => {
  it('defaults to redact when unset', () => {
    expect(accountDataModeFromEnv({} as NodeJS.ProcessEnv)).toBe('redact');
  });

  it('keeps account data only on an explicit keep', () => {
    expect(accountDataModeFromEnv({ RAW_CAPTURE_ACCOUNT_DATA: 'keep' } as NodeJS.ProcessEnv)).toBe('keep');
    expect(accountDataModeFromEnv({ RAW_CAPTURE_ACCOUNT_DATA: ' KEEP ' } as NodeJS.ProcessEnv)).toBe('keep');
  });

  it('reads every other value, a typo included, as the safe redact', () => {
    expect(accountDataModeFromEnv({ RAW_CAPTURE_ACCOUNT_DATA: 'redact' } as NodeJS.ProcessEnv)).toBe('redact');
    expect(accountDataModeFromEnv({ RAW_CAPTURE_ACCOUNT_DATA: 'kepe' } as NodeJS.ProcessEnv)).toBe('redact');
    expect(accountDataModeFromEnv({ RAW_CAPTURE_ACCOUNT_DATA: '' } as NodeJS.ProcessEnv)).toBe('redact');
  });
});

describe('redactAccountData — which pages it touches', () => {
  it('leaves a page from any other store untouched', () => {
    expect(redactAccountData('https://www.example-store.test/p/1', Buffer.from(LOGGED_IN)).kind).toBe('untouched');
  });

  it('does not treat a look-alike host as mfc', () => {
    expect(redactAccountData('https://myfigurecollection.net.evil.test/item/1', Buffer.from(LOGGED_IN)).kind).toBe('untouched');
  });

  it('leaves a non-HTML mfc body (a JSON answer) untouched', () => {
    expect(redactAccountData(ITEM_URL, Buffer.from('{"items":[1,2,3]}')).kind).toBe('untouched');
  });

  it('leaves an mfc page with nothing to remove untouched (no copy, no rehash)', () => {
    const plain = '<!DOCTYPE html><html><head><title>t</title></head><body><section class="object">x</section></body></html>';
    expect(redactAccountData(ITEM_URL, Buffer.from(plain)).kind).toBe('untouched');
  });

  it('applies on an mfc subdomain too', () => {
    expect(redactAccountData('https://www.myfigurecollection.net/item/1', Buffer.from(LOGGED_IN)).kind).toBe('redacted');
  });
});

describe('redactAccountData — what a logged-in mfc page loses', () => {
  const out = redacted(LOGGED_IN);

  it('removes the header user menu whole: avatar, username, notifications, messages, toggles, sign-out', () => {
    expect(out).not.toContain('user-menu');
    expect(out).not.toContain('/notifications/');
    expect(out).not.toContain('/messages/');
    expect(out).not.toContain('/session/');
    expect(out).not.toContain('nsfw=1');
  });

  it('empties the viewer-state targets but keeps each element, so the page keeps its shape', () => {
    expect(out).toContain('<span class="tbx-target-COLLECT target"></span>');
    expect(out).toContain('<div class="tbx-target-COLLECTION"></div>');
    expect(out).toContain('<div class="tbx-target-NOTE"></div>');
    expect(out).toContain('<div class="tbx-target-LISTS"></div>');
    expect(out).not.toContain('item-is-collected');
    expect(out).not.toContain('Private note');
    expect(out).not.toContain('paid 12000');
    expect(out).not.toContain('Grails');
  });

  it('removes the comment composer that carries the viewer avatar', () => {
    expect(out).not.toContain('user-expression');
    expect(out).toContain('<div class="comment"></div>');
  });

  it('removes every inline script (the ad-tech identity calls live there), keeping src and JSON-LD scripts', () => {
    expect(out).not.toContain('_qevents');
    expect(out).not.toContain('lockrAIM');
    expect(out).not.toContain('id5_pd_string');
    expect(out).not.toMatch(/[0-9a-f]{64}/);
    expect(out).toContain('<script src="https://static.myfigurecollection.net/js/main.js"></script>');
    expect(out).toContain('<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Rem: Bunny Ver."}</script>');
  });

  it('leaves no trace of the viewer anywhere', () => {
    expect(out.toLowerCase()).not.toContain(VIEWER);
  });
});

describe('redactAccountData — what a logged-in mfc page keeps', () => {
  const out = redacted(LOGGED_IN);

  it('keeps the item record byte-for-byte: the data fields and the gallery meta', () => {
    expect(out).toContain(region(LOGGED_IN, '<section class="object">', '</section>'));
    expect(out).toContain('<meta name="pictures" content="%5B%7B%22src%22');
  });

  it('keeps the head, the title, the related items and the footer byte-for-byte', () => {
    expect(out).toContain('<title>Rem: Bunny Ver. - My Figure Collection</title>');
    expect(out).toContain('<h1 class="title">Rem: Bunny Ver.</h1>');
    expect(out).toContain('<a href="/item/2">Ram: Bunny Ver.</a>');
    expect(out).toContain('<footer><div class="copyright">MyFigureCollection</div></footer>');
  });

  it('splices the original bytes rather than re-serializing them', () => {
    // Everything before the first removed region is the original prefix, exactly.
    const firstCut = LOGGED_IN.indexOf('<div class="tbx-menu user-menu">');
    expect(out.slice(0, firstCut)).toBe(LOGGED_IN.slice(0, firstCut));
    // And a construct a serializer would rewrite (the bare `switch` attribute) survives as written.
    expect(out).toContain('<span switch>Rem</span>');
  });

  it('is deterministic, and two viewers of one item store the SAME bytes', () => {
    const other = LOGGED_IN
      .split(VIEWER).join('otherviewer')
      .replace('3 notifications', '9 notifications')
      .replace('item-is-collected', 'item-is-not-collected');
    expect(redacted(LOGGED_IN)).toBe(out);
    expect(redacted(other)).toBe(out);
  });
});

describe('redactAccountData — fails closed', () => {
  it('REFUSES a logged-in page whose viewer still appears after the cut', () => {
    const leaky = LOGGED_IN.replace('<footer>', `<p>Added by <a href="/profile/${VIEWER}">${VIEWER}</a></p><footer>`);
    const out = redactAccountData(ITEM_URL, Buffer.from(leaky));
    expect(out.kind).toBe('refused');
  });

  it('REFUSES a page whose sign-out link sits outside the user menu', () => {
    const leaky = LOGGED_IN.replace('<footer>', '<a href="/session/signout/">Sign out</a><footer>');
    expect(redactAccountData(ITEM_URL, Buffer.from(leaky)).kind).toBe('refused');
  });

  it('removes an unclosed viewer-state element whole rather than guessing where it ends', () => {
    const unclosed = '<!DOCTYPE html><html><body><div class="tbx-target-NOTE"><section>secret';
    const out = redacted(unclosed);
    expect(out).not.toContain('secret');
    expect(out).not.toContain('tbx-target-NOTE');
  });
});
