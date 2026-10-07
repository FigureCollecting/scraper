/** STUB (red commit): the shared host scope grammar QB-U30b adds. Selects nothing yet. */
export type HostSelectMode = 'off' | 'all' | 'all-except' | 'hosts';
export interface HostSelect { mode: HostSelectMode; hosts: string[]; excluded: string[]; warnings: string[]; malformed: boolean }
export interface HostSelectGrammar { envName: string; tag: string; listEntries: 'ignore' | 'strict' }
export function normalizeSelectHost(host: string): string {
  return host;
}
export function isBareHostname(_host: string): boolean {
  return false;
}
export function parseHostSelect(_raw: string | undefined, _grammar: HostSelectGrammar): HostSelect {
  return { mode: 'off', hosts: [], excluded: [], warnings: [], malformed: false };
}
export function hostSelected(_select: HostSelect, _host: string): boolean {
  return false;
}
