/**
 * Host-scope grammar for per-host knobs (QB-U19). STUB: the red commit's API only.
 */

export type HostScopeKind = 'off' | 'all' | 'all-except' | 'hosts';
export type HostMembership = 'in' | 'excluded' | 'out';

export interface HostScope {
  readonly kind: HostScopeKind;
  readonly hosts: readonly string[];
  readonly malformed: boolean;
  readonly warning: string | null;
  membership(host: string): HostMembership;
}

export function normalizeScopeHost(host: string): string {
  return host;
}

export function parseHostScope(_raw: string | undefined, _envName: string): HostScope {
  return { kind: 'off', hosts: [], malformed: false, warning: null, membership: () => 'out' };
}
