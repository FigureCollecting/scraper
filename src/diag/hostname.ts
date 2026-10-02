/**
 * hostname — the one host shape the diag surface accepts (hands-off plan unit S1).
 *
 * A bare lower-case ASCII DNS hostname: labels of letters, digits and inner hyphens, 1 to 63
 * characters each, at most 253 in all. No scheme, port, path, space, empty label or trailing dot;
 * an internationalised name must arrive in its punycode (xn--) form. The origin check (input.ts)
 * and the budget's host key (budget.ts) both use it, so a host has exactly one spelling.
 */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOSTNAME_LENGTH = 253;

/** True when `host` is a bare lower-case ASCII DNS hostname. */
export function isDnsHostname(host: string): boolean {
  return host.length <= MAX_HOSTNAME_LENGTH && host.split('.').every((label) => DNS_LABEL.test(label));
}
