/**
 * TEST-ONLY preload for the gallery CLI child (see withDispatchClock in galleryLoopback.ts). It records, from INSIDE the Job
 * process, the moment each request is handed to its transport: the global fetch (the http lane) or impit's fetch (the impit
 * lane). That is the dispatch the per-host limiter spaces. A server's arrival times add each request's own connection setup
 * (the first request to a host pays for the connect, later ones reuse it), so they measure the network as well as the limiter.
 * One JSON line per request: {"t": performance.now() in this process, "lane": "http"|"impit", "url": ...}.
 */
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const file = process.env.GALLERY_TEST_DISPATCH_LOG;
if (file) {
  const log = (lane, url) => appendFileSync(file, `${JSON.stringify({ t: performance.now(), lane, url: String(url) })}\n`);
  const fetch0 = globalThis.fetch;
  globalThis.fetch = function dispatchClockFetch(input, init) {
    log('http', typeof input === 'object' && input !== null && 'url' in input ? input.url : input);
    return fetch0.call(this, input, init);
  };
  const { Impit } = createRequire(import.meta.url)('impit');
  const impitFetch = Impit.prototype.fetch;
  Impit.prototype.fetch = function dispatchClockImpitFetch(resource, init) {
    log('impit', resource);
    return impitFetch.call(this, resource, init);
  };
}
