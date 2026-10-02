/**
 * hostname — the one host shape the diag surface accepts (hands-off plan unit S1).
 *
 * A bare lower-case ASCII DNS hostname: labels of letters, digits and inner hyphens, 1 to 63
 * characters each, at most 253 in all. No scheme, port, path, space, empty label or trailing dot;
 * an internationalised name must arrive in its punycode (xn--) form. The origin check (input.ts)
 * and the budget's host key (budget.ts) both use it, so a host has exactly one spelling.
 *
 * The last label may not be a number (decimal, octal or 0x hex): a URL parser reads such a name as
 * an IPv4 address (127.1, 2130706433, 0x7f.0.0.1 are all 127.0.0.1), so it is not a DNS name.
 */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMBER_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/;
const MAX_HOSTNAME_LENGTH = 253;

/** True when `host` is a bare lower-case ASCII DNS hostname. */
export function isDnsHostname(host: string): boolean {
  const labels = host.split('.');
  return (
    host.length <= MAX_HOSTNAME_LENGTH &&
    labels.every((label) => DNS_LABEL.test(label)) &&
    !NUMBER_LABEL.test(labels[labels.length - 1])
  );
}
