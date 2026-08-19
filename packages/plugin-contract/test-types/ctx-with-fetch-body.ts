/**
 * Type-test fixture: ExtractContext.scraping.fetchBody() — the engine-provided, non-browser
 * captured follow-up GET (orzgk Slice B call #2, spec.md §1.3/§3.1 D1/D9). RED before the
 * 0.4.0 bump (fetchBody does not exist on `scraping` ⇒ "property does not exist" error);
 * GREEN after, including the `{ html, statusCode? }` result shape and optional `cookies` opt.
 */
import type { ExtractContext } from '../src/index';

async function useFetchBody(ctx: ExtractContext): Promise<void> {
  if (!ctx.scraping.fetchBody) return;

  const result = await ctx.scraping.fetchBody('https://www.orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=68026029');
  const html: string = result.html;
  const statusCode: number | undefined = result.statusCode;
  void html;
  void statusCode;

  await ctx.scraping.fetchBody('https://www.orzgk.com/wp-json/wc/store/v1/products?type=variation&parent=68026029', {
    cookies: { session: 'abc' },
  });
}

void useFetchBody;
