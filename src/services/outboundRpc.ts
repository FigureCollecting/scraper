/**
 * outboundRpc — the one hook point a batch job uses to put its client interceptors on the Connect calls this
 * process makes to the ingest server (the fetch-failure ledger, the capture ledger).
 *
 * Every such transport carries `outboundRpcHook`, built in whenever the transport is: in the server, and before
 * a job's run starts (the raw store's capture reporter is a process-wide singleton). The hook reads what is
 * installed AT CALL TIME, so a transport built before the run still writes the run's rpc.out lines and sends the
 * traceparent of whatever is active, the run or one of its items. Nothing installed (the server, a test outside a run):
 * the call passes straight through.
 *
 * Deliberately free of fc-shared's node-only server subpaths: the server imports this file, and telemetry.ts
 * (which the server never loads) is what installs into it.
 */
import type { Interceptor } from '@connectrpc/connect';

let installed: readonly Interceptor[] = [];

/** The interceptors installed now, the first outermost, as Connect orders a transport's own list. */
export const outboundRpcHook: Interceptor = next => req => installed.reduceRight((inner, interceptor) => interceptor(inner), next)(req);

/** Install `interceptors` for every call from now on; returns the undo that puts the previous ones back. */
export function installOutboundRpcInterceptors(interceptors: readonly Interceptor[]): () => void {
  const previous = installed;
  installed = [...interceptors];
  return () => {
    installed = previous;
  };
}
