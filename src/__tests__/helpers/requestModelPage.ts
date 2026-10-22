/**
 * A mocked puppeteer Page that models how Chrome issues a page's requests, for the plugin routes on
 * the host clock (QB-U30b): goto, reload, goBack, goForward, a main-frame goto and a click that
 * submits a form each ISSUE a main-frame navigation request. Without request interception the request
 * reaches the wire at once and the page's 'request' listeners see it; with interception on, it reaches
 * the wire only when a listener continues it, and aborting it fails the navigation. `issue` sends any
 * other request (a subresource, a subframe navigation, a redirect hop). The wire is stamped with
 * Date.now(), so fake timers give exact gaps.
 */
import { jest } from '@jest/globals';
import type { Page } from 'puppeteer';

export interface WireEntry {
  what: string;
  url: string;
  at: number;
}

export interface ModelRequest {
  url(): string;
  isNavigationRequest(): boolean;
  frame(): object | null;
  redirectChain(): unknown[];
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export interface IssueOptions {
  /** The wire label (default the url). */
  what?: string;
  /** A navigation request (default true). */
  navigation?: boolean;
  /** Which frame issued it (default the main frame). */
  frame?: 'main' | 'sub' | null;
  /** Hops before this request in its redirect chain (default 0). */
  redirectHops?: number;
  /** The request can no longer be resolved (its page closed): continue and abort reject. */
  gone?: boolean;
}

type Response = { status: () => number; url: () => string; headers: () => Record<string, string> };

export function requestModelPage(options: { respond?: (url: string) => Response; extra?: Record<string, unknown> } = {}) {
  const wire: WireEntry[] = [];
  const aborted: Array<{ url: string; errorCode?: string }> = [];
  const listeners: Array<(request: ModelRequest) => void> = [];
  const navigationWaiters: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const interception: boolean[] = [];
  let intercepting = false;
  let current = 'about:blank';
  const respond = options.respond ?? ((url: string): Response => ({ status: () => 200, url: () => url, headers: () => ({ 'content-type': 'text/html' }) }));

  function issue(url: string, how: IssueOptions = {}): Promise<void> {
    const what = how.what ?? url;
    return new Promise<void>((resolve, reject) => {
      let handled = false;
      const send = () => {
        wire.push({ what, url, at: Date.now() });
        resolve();
      };
      const settle = () => {
        if (how.gone) throw new Error('Protocol error (Fetch.continueRequest): Target closed');
        if (!intercepting) throw new Error('Request Interception is not enabled!');
        if (handled) throw new Error('Request is already handled!');
        handled = true;
      };
      const request: ModelRequest = {
        url: () => url,
        isNavigationRequest: () => how.navigation ?? true,
        frame: () => (how.frame === null ? null : how.frame === 'sub' ? subFrame : mainFrame),
        redirectChain: () => Array.from({ length: how.redirectHops ?? 0 }, () => ({})),
        continue: async () => {
          settle();
          send();
        },
        abort: async (errorCode?: string) => {
          settle();
          aborted.push({ url, errorCode });
          reject(new Error(`net::ERR_${String(errorCode ?? 'failed').toUpperCase()} at ${url}`));
        },
      };
      if (!intercepting) send();
      for (const listener of [...listeners]) listener(request);
    });
  }

  function navigate(url: string, what: string): Promise<Response> {
    current = url;
    const waiters = navigationWaiters.splice(0);
    const navigation = issue(url, { what: `${what} ${url}` }).then(() => respond(url));
    navigation.then(r => waiters.forEach(w => w.resolve(r)), e => waiters.forEach(w => w.reject(e)));
    return navigation;
  }

  const mainFrame = { name: 'main', goto: jest.fn((url: string) => navigate(url, 'frame goto')) };
  const subFrame = { name: 'sub' };

  const page = {
    goto: jest.fn((url: string) => navigate(url, 'goto')),
    reload: jest.fn(() => navigate(current, 'reload')),
    goBack: jest.fn(() => navigate(current, 'goBack')),
    goForward: jest.fn(() => navigate(current, 'goForward')),
    mainFrame: jest.fn(() => mainFrame),
    // A form button: clicking it submits the form, a main-frame navigation the click does not await.
    $: jest.fn(async (selector: string) => ({
      click: async () => {
        void navigate(`${new URL(current).origin}/?submit=${encodeURIComponent(selector)}`, 'submit').catch(() => undefined);
      },
    })),
    waitForNavigation: jest.fn(() => new Promise((resolve, reject) => navigationWaiters.push({ resolve, reject }))),
    setRequestInterception: jest.fn(async (value: boolean) => {
      interception.push(value);
      intercepting = value;
    }),
    on: jest.fn((event: string, listener: (request: ModelRequest) => void) => {
      if (event === 'request') listeners.push(listener);
    }),
    off: jest.fn((event: string, listener: (request: ModelRequest) => void) => {
      const i = listeners.indexOf(listener);
      if (event === 'request' && i >= 0) listeners.splice(i, 1);
    }),
    title: jest.fn(async () => 'Mock Page Title'),
    content: jest.fn(async () => '<html><body>mock</body></html>'),
    evaluate: jest.fn(async () => 'mock body text'),
    emulateTimezone: jest.fn(async () => undefined),
    setViewport: jest.fn(async () => undefined),
    setUserAgent: jest.fn(async () => undefined),
    setCookie: jest.fn(async () => undefined),
    setExtraHTTPHeaders: jest.fn(async () => undefined),
    waitForSelector: jest.fn(async () => ({})),
    waitForNetworkIdle: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    ...options.extra,
  };

  return {
    page: page as unknown as jest.Mocked<Page>,
    wire,
    aborted,
    /** setRequestInterception's calls, in order. */
    interception,
    /** How many 'request' listeners the page holds. */
    listenerCount: () => listeners.length,
    issue,
  };
}
