/**
 * sessionCanary — is the mfc scrape session still ENTITLED to see what it is supposed to see?
 *
 * THE PROBLEM (owner rule, 2026-09-09): myfigurecollection.net answers 404 for an NSFW / NSFW+ item
 * when the requesting session is not entitled — an age gate, or scrape-account cookies that have
 * gone stale — and it answers 404 for an item that never existed. The two are byte-identical. So a
 * 404 from mfc can never be read as "the store removed it", and the engine must not close it as
 * gone. See recordFetchGate's ambiguity table for the classification side of that rule.
 *
 * THE SIGNAL: one 404 proves nothing, but a PAIR does. A known NSFW+ item (the canary,
 * MFC_SESSION_CANARY_ITEM) and a known-good SFW item (the control) observed together separate the
 * cases without guessing:
 *   canary 404 + control 200 → the session lost its entitlement. Cookies need re-minting.
 *   canary 200               → entitled; any lingering flag is cleared.
 *   anything else            → INCONCLUSIVE (the control failing means the store or the egress is
 *                              unwell, which says nothing about entitlement). An existing flag
 *                              STANDS: an inconclusive round must never look like a recovery.
 *
 * THIS MODULE HOLDS THE RULE AND THE FLAG, NEVER THE FETCH. The two observations are wired in by
 * the caller (the initiator, later) and handed here as plain statuses, which is what keeps the rule
 * exhaustively testable with no network at all. The flag surfaces on /health/detailed so the cookie
 * runbook has something to trigger on, and the transition — not every observation — logs one line.
 */

/** The site this canary speaks for. One store today; the shape is ready for a second. */
const CANARY_SITE = 'mfc';

/** The hosts that ARE that store. Subdomains count; a look-alike suffix does not. */
const CANARY_HOSTS: readonly string[] = ['myfigurecollection.net'];

/**
 * How far apart the two halves of the pair may be. A 200 from yesterday says nothing about the
 * session right now, so two observations that never overlap in the same hour are not a pair.
 */
export const CANARY_PAIR_WINDOW_MS = 60 * 60_000;

/** What one paired observation proved. */
export type SessionCanaryVerdict = 'stale' | 'fresh' | 'inconclusive';

/** The two statuses one canary round observed. Either may be absent when a fetch never happened. */
export interface SessionCanaryObservation {
  /** Status of the KNOWN NSFW+ item — the entitlement probe. */
  canaryStatus?: number;
  /** Status of the KNOWN-good SFW item — proof the store and the egress are healthy. */
  controlStatus?: number;
}

/** The /health/detailed view. Flags and timestamps only — never the canary item id itself. */
export interface SessionCanaryView {
  site: string;
  /** Is a canary item configured at all (MFC_SESSION_CANARY_ITEM)? */
  configured: boolean;
  /** Did the last conclusive round show the session had lost its entitlement? */
  stale: boolean;
  staleSince?: string;
  staleReason?: string;
}

const STALE_REASON =
  'the NSFW canary item answered 404 while a SFW control was served — the session is not entitled; re-mint the mfc cookies';

interface CanaryState {
  stale: boolean;
  staleSince?: string;
  staleReason?: string;
  /** When the CANARY item was last refused with a 404. */
  canaryDeniedAt?: number;
  /** When any OTHER item of the same store was last served — proof the store and egress are fine. */
  controlServedAt?: number;
}

let state: CanaryState = { stale: false };

/** Mark the session stale, once. A repeat keeps the ORIGINAL timestamp and logs nothing more. */
function markStale(): void {
  if (state.stale) return;
  state = {
    ...state,
    stale: true,
    staleSince: new Date().toISOString(),
    staleReason: STALE_REASON,
  };
  // eslint-disable-next-line no-console
  console.warn(`[MFC SESSION] canary item 404 while the control was served — session not entitled; re-mint the mfc cookies`);
}

/** The canary itself was served: the session IS entitled. Forget everything that said otherwise. */
function markFresh(): void {
  state = { stale: false };
}

/** Is this URL one of the canary store's own hosts? Unparseable input is never a match. */
function isCanaryHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return CANARY_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

/** Does this URL address the configured canary item? Matched on a whole path segment, never a substring. */
function isCanaryItem(url: string, canaryItemId: string): boolean {
  try {
    return new URL(url).pathname.split('/').includes(canaryItemId);
  } catch {
    return false;
  }
}

/**
 * The configured canary item id, or `undefined` when the canary is off. Blank and whitespace read
 * as "not configured" — a canary nobody configured must never look like a canary that failed.
 */
export function resolveCanaryItemId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.MFC_SESSION_CANARY_ITEM;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Judge one paired observation and move the flag. Returns what was proved. The state change is
 * idempotent: repeating a stale round keeps the ORIGINAL `staleSince` and logs nothing more, so the
 * operator sees when entitlement was lost, not when it was last re-checked.
 */
export function observeSessionCanary(observation: SessionCanaryObservation): SessionCanaryVerdict {
  const { canaryStatus, controlStatus } = observation;
  if (canaryStatus === 404 && controlStatus === 200) {
    markStale();
    return 'stale';
  }
  if (canaryStatus === 200) {
    markFresh();
    return 'fresh';
  }
  // Everything else says nothing about entitlement. A standing flag is left exactly as it was.
  return 'inconclusive';
}

/**
 * The SAME rule, assembled from ordinary queue traffic instead of a dedicated probe. The ingest
 * queue fetches mfc items all day and every lane now surfaces a status, so the pair costs nothing:
 * a 404 on the configured canary item and a 200 on ANY other item of the store, within
 * {@link CANARY_PAIR_WINDOW_MS} of each other, prove the session lost its entitlement.
 *
 * Deliberately narrow — everything that is not that exact pair is INCONCLUSIVE and moves nothing:
 * another store, an unconfigured canary, a lane that surfaced no status, a 404 on an ordinary item
 * (which is the very ambiguity this exists to resolve), or two halves an hour apart. The canary
 * answering 200 clears the flag outright.
 *
 * Never throws: it is called from the queue's hot path, where bookkeeping must not become an item's
 * failure.
 */
export function observeMfcItemFetch(
  url: string,
  status: number | undefined,
  opts: { env?: NodeJS.ProcessEnv; now?: number } = {},
): SessionCanaryVerdict {
  const now = opts.now ?? Date.now();
  const canaryItemId = resolveCanaryItemId(opts.env ?? process.env);
  if (status === undefined || canaryItemId === undefined || !isCanaryHost(url)) return 'inconclusive';

  const isCanary = isCanaryItem(url, canaryItemId);
  if (isCanary && status === 200) {
    markFresh();
    return 'fresh';
  }
  if (isCanary && status === 404) {
    state = { ...state, canaryDeniedAt: now };
  } else if (!isCanary && status === 200) {
    state = { ...state, controlServedAt: now };
  } else {
    return 'inconclusive';
  }

  const { canaryDeniedAt, controlServedAt } = state;
  if (
    canaryDeniedAt !== undefined &&
    controlServedAt !== undefined &&
    Math.abs(canaryDeniedAt - controlServedAt) <= CANARY_PAIR_WINDOW_MS
  ) {
    markStale();
    return 'stale';
  }
  return 'inconclusive';
}

/** The health view. `configured` is read fresh so an operator's env change needs no restart to show. */
export function sessionCanaryView(env: NodeJS.ProcessEnv = process.env): SessionCanaryView {
  return {
    site: CANARY_SITE,
    configured: resolveCanaryItemId(env) !== undefined,
    stale: state.stale,
    ...(state.staleSince !== undefined ? { staleSince: state.staleSince } : {}),
    ...(state.staleReason !== undefined ? { staleReason: state.staleReason } : {}),
  };
}

/** Test seam: forget every observation. */
export function resetSessionCanary(): void {
  state = { stale: false };
}
