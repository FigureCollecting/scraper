/** STUB (red commit): the QB-U30b send block. Today's behaviour: every caller sends at once, unclocked. */
import type { HostClock, HostClockCaller } from './hostClock.js';

export interface ClockedSendRequest { host: string; caller: HostClockCaller; budgetMs?: number; latency?: 'listing' | 'lookup'; veto?: () => string | undefined }
export type ClockedSendResult<T> = { sent: true; value: T; waitedMs: number } | { sent: false; refused: true; waitMs: number } | { sent: false; refused: false; reason: string };
export interface ClockedSendDeps { clock?: HostClock; now?: () => number; sleep?: (ms: number) => Promise<void> }
export function hostOfUrl(_url: string): string | undefined {
  return undefined;
}
export class HostClockRefusedError extends Error {}
export async function sendOnHostClock<T>(request: ClockedSendRequest, invoke: (timeoutMs: number | undefined) => Promise<T>, _deps: ClockedSendDeps = {}): Promise<ClockedSendResult<T>> {
  return { sent: true, value: await invoke(request.budgetMs), waitedMs: 0 };
}
export async function sendOnHostClockOrThrow<T>(request: ClockedSendRequest, invoke: (timeoutMs: number | undefined) => Promise<T>, _deps: ClockedSendDeps = {}): Promise<T> {
  return invoke(request.budgetMs);
}
export interface HostClockPacer { first(url: string): void; send<T>(url: string, caller: HostClockCaller, invoke: () => Promise<T>): Promise<T> }
export function processHostClockPacer(_deps: Omit<ClockedSendDeps, 'clock'> = {}): HostClockPacer {
  return { first: () => undefined, send: (_url, _caller, invoke) => invoke() };
}
