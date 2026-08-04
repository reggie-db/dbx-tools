/**
 * Unified access allow-list matching for the email-OTP gate.
 *
 * Each pattern in the configured list is one of three shapes:
 *
 *   - **domain shortcut** - `example.com` or `@example.com`: matches any
 *     address whose domain equals it. This is the gate's OWN semantic (a bare
 *     value means "the domain", not "the whole address"), so it is handled here.
 *   - **glob** - contains `*` or `?`, e.g. `*@example.com`: matched against the
 *     WHOLE address with shell-style wildcards.
 *   - **regex** - wrapped in slashes, `/.../ [flags]`: tested against the whole
 *     address. An invalid regex never matches (it is skipped with a warning
 *     rather than throwing).
 *
 * Only the first shape is this module's business: the glob and regex shapes are
 * delegated to `@dbx-tools/shared-core`'s {@link pattern.toPattern}, which is
 * where that compilation lives for every allow-list in the repo (the tunnel's
 * inbound-header policy uses the same one). Matching is case-insensitive
 * throughout.
 *
 * An EMPTY list matches nobody (fail closed): an app that enables the gate but
 * configures no patterns lets no one in, which is the safe default.
 *
 * @module
 */

import { pattern } from "@dbx-tools/shared-core";

/** True when `email` matches a single allow-list `pattern`. */
function matchesPattern(email: string, entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  const address = email.trim().toLowerCase();

  // A bare value with no wildcard and no regex delimiters is a DOMAIN shortcut,
  // the one shape shared-core cannot infer: there it would mean whole-string
  // equality against the address, which is never what an operator writing
  // `example.com` in an access list intends.
  if (!trimmed.startsWith("/") && !trimmed.includes("*") && !trimmed.includes("?")) {
    const domain = trimmed.replace(/^@/, "").toLowerCase();
    const at = address.lastIndexOf("@");
    return at >= 0 && address.slice(at + 1) === domain;
  }

  return pattern.toPattern(trimmed)?.(address) ?? false;
}

/**
 * True when `email` is allowed by ANY pattern in `patterns`. An empty (or
 * missing) list allows nobody - the gate fails closed.
 */
export function matchesAllowlist(email: string, patterns: readonly string[] | undefined): boolean {
  if (!email || !patterns || patterns.length === 0) return false;
  return patterns.some((entry) => matchesPattern(email, entry));
}

/** Rough shape check so a clearly-invalid address is rejected before any work. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
