/**
 * Case-insensitive Salesforce username equality. The username is the stable org
 * identity shared across `sf org list`, the shared `skrety.salesforce.targetOrg`
 * setting, and every `--target-org` call; the CLI treats it case-insensitively,
 * and the family compares it lowercased everywhere.
 *
 * Returns false when EITHER side is undefined — this is what makes it safe to
 * gate background work (coverage loads, a finished run) that captured its org at
 * start against the CURRENT target: an org that was since switched away, or
 * cleared to undefined, must not match, so the stale result is discarded.
 */
export function sameOrg(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}
