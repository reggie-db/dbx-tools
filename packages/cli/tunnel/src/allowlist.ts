/**
 * Unified access allow-list matching for the email-OTP gate.
 *
 * Each pattern in the configured list is one of three shapes, tried in order:
 *
 *   - **domain shortcut** - `example.com` or `@example.com`: matches any
 *     address whose domain equals it (case-insensitive). The leading `@` is
 *     optional and stripped.
 *   - **glob** - contains `*` or `?`, e.g. `*.example.com` or
 *     `*@example.com`: matched against the WHOLE address with shell-style
 *     wildcards (`*` = any run, `?` = one char).
 *   - **regex** - wrapped in slashes, `/.../ [flags]`: compiled and tested
 *     against the whole address. An invalid regex never matches (it is skipped
 *     with a warning rather than throwing).
 *
 * An EMPTY list matches nobody (fail closed): an app that enables the gate but
 * configures no patterns lets no one in, which is the safe default.
 *
 * @module
 */

import { log } from "@dbx-tools/shared-core";

const logger = log.logger("tunnel:allowlist");

/** Escape a string for literal use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile a shell-style glob (`*`, `?`) into an anchored, case-insensitive RegExp. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split(/([*?])/)
    .map((part) => (part === "*" ? ".*" : part === "?" ? "." : escapeRegExp(part)))
    .join("");
  return new RegExp(`^${body}$`, "i");
}

/** Parse a `/pattern/flags` string into a RegExp, or `undefined` if malformed. */
function parseRegexLiteral(pattern: string): RegExp | undefined {
  const match = /^\/(.+)\/([a-z]*)$/is.exec(pattern);
  if (!match) return undefined;
  try {
    const flags = match[2]!.includes("i") ? match[2]! : `${match[2]!}i`;
    return new RegExp(match[1]!, flags);
  } catch (error) {
    logger.warn("ignoring invalid regex allow-list pattern", { pattern, error });
    return undefined;
  }
}

/** True when `email` matches a single allow-list `pattern`. */
function matchesPattern(email: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  const address = email.trim().toLowerCase();

  // Regex literal: /.../
  if (trimmed.startsWith("/")) {
    const re = parseRegexLiteral(trimmed);
    return re ? re.test(address) : false;
  }

  // Glob: contains a wildcard.
  if (trimmed.includes("*") || trimmed.includes("?")) {
    return globToRegExp(trimmed).test(address);
  }

  // Domain shortcut: `@d.com` or `d.com` -> match the address's domain.
  const domain = trimmed.replace(/^@/, "").toLowerCase();
  const at = address.lastIndexOf("@");
  return at >= 0 && address.slice(at + 1) === domain;
}

/**
 * True when `email` is allowed by ANY pattern in `patterns`. An empty (or
 * missing) list allows nobody - the gate fails closed.
 */
export function matchesAllowlist(email: string, patterns: readonly string[] | undefined): boolean {
  if (!email || !patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => matchesPattern(email, pattern));
}

/** Rough shape check so a clearly-invalid address is rejected before any work. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
