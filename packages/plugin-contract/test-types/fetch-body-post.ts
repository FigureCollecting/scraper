/**
 * Type-test fixture (0.14.0): ExtractContext.scraping.fetchBody() takes an optional request method,
 * body and Content-Type. RED before the bump (`method`/`body`/`contentType` are not known properties);
 * GREEN after. The `@ts-expect-error` lines pin the closed method vocabulary and the body's type.
 */
import type { ExtractContext, FetchBodyOptions } from '../src/index';

async function usePost(ctx: ExtractContext): Promise<void> {
  if (!ctx.scraping.fetchBody) return;

  const post = await ctx.scraping.fetchBody('https://my.mandarake.co.jp/ItemDetailInfo/getInfo/', {
    method: 'POST',
    body: 'idx=1315522194&lang=en',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
  });
  const html: string = post.html;
  void html;

  const opts: FetchBodyOptions = { cookies: { session: 'abc' }, method: 'GET' };
  await ctx.scraping.fetchBody('https://www.orzgk.com/wp-json/wc/store/v1/products', opts);

  // @ts-expect-error — only GET and POST are in the contract
  await ctx.scraping.fetchBody('https://x.test/', { method: 'PUT' });
  // @ts-expect-error — the body is a string the ruleset already encoded
  await ctx.scraping.fetchBody('https://x.test/', { method: 'POST', body: { idx: 1 } });
}

void usePost;
