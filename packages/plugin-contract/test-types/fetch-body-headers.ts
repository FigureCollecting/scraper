/**
 * Type-test fixture (0.15.0): fetchBody() takes request headers from a closed allowlist. RED before
 * the bump (`headers` is not a known option and the allowlist is not exported); GREEN after. The
 * `@ts-expect-error` lines pin what a ruleset may NOT set: the engine owns identity and framing.
 */
import { FETCH_BODY_ALLOWED_HEADERS } from '../src/index';
import type { ExtractContext, FetchBodyHeaderName, FetchBodyHeaders, FetchBodyOptions } from '../src/index';

const GETINFO = 'https://my.mandarake.co.jp/ItemDetailInfo/getInfo/';

async function useHeaders(ctx: ExtractContext): Promise<void> {
  if (!ctx.scraping.fetchBody) return;

  await ctx.scraping.fetchBody(GETINFO, {
    method: 'POST',
    body: 'idx=1315522194&lang=en',
    headers: {
      origin: 'https://order.mandarake.co.jp',
      referer: 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=1315522194&lang=en',
    },
  });
  // The canonical spelling compiles too (names are case-insensitive at runtime).
  await ctx.scraping.fetchBody(GETINFO, {
    headers: { Accept: 'application/json', 'Accept-Language': 'en', 'X-Requested-With': 'XMLHttpRequest' },
  });

  const names: readonly FetchBodyHeaderName[] = FETCH_BODY_ALLOWED_HEADERS;
  const five: 5 = FETCH_BODY_ALLOWED_HEADERS.length;
  const h: FetchBodyHeaders = { 'accept-language': 'ja', 'x-requested-with': 'XMLHttpRequest' };
  const opts: FetchBodyOptions = { headers: h };
  void names;
  void five;
  void opts;

  // @ts-expect-error — cookies are the engine's (its jar), never a ruleset header
  await ctx.scraping.fetchBody(GETINFO, { headers: { cookie: 'a=1' } });
  // @ts-expect-error — the User-Agent is the engine's (pinned per store / impersonation profile)
  await ctx.scraping.fetchBody(GETINFO, { headers: { 'user-agent': 'x' } });
  // @ts-expect-error — credentials are not a ruleset header
  await ctx.scraping.fetchBody(GETINFO, { headers: { authorization: 'Bearer x' } });
  // @ts-expect-error — framing is the engine's (Content-Type rides `contentType`)
  await ctx.scraping.fetchBody(GETINFO, { headers: { 'content-type': 'text/plain' } });
  // @ts-expect-error — a header value is a string
  await ctx.scraping.fetchBody(GETINFO, { headers: { origin: 1 } });
  // @ts-expect-error — not in the allowlist
  const cookieName: FetchBodyHeaderName = 'cookie';
  void cookieName;
}

void useHeaders;
