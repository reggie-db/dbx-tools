/**
 * Inbound header policy for tunnel traffic.
 *
 * Everything the gate forwards arrives from the PUBLIC internet through the
 * portr client, so every header on it is attacker-controlled. The headers an app
 * trusts are precisely the ones a caller must not be able to write, because the
 * app cannot tell a header the Databricks front door set from one a browser
 * typed.
 *
 * ## Policy shape: strip by default, allow by pattern
 *
 * Enumerating what to remove is a losing game - a deny-list is only correct until
 * the platform adds a header or a library starts trusting another one - so the
 * policy is inverted. EVERY `x-`-prefixed request header is dropped from tunnel
 * traffic unless it matches a configured pattern. That fails CLOSED: a header
 * nobody thought about is removed rather than trusted.
 *
 * The allow-list is zero-to-many literals, globs, or `/regex/`es, compiled by
 * shared-core's {@link pattern.toPatternMatcher}, and is UNIONED with
 * {@link DEFAULT_FORWARD_HEADERS} so extending it never silently breaks the
 * built-in surfaces. Configure it with `forwardHeaders` /
 * `TUNNEL_FORWARD_HEADERS`.
 *
 * Non-`x-` headers are untouched. Standard ones (`content-type`, `accept`,
 * `authorization`, `cookie`, ...) are the app's normal input and the gate has no
 * business rewriting them.
 *
 * ## The headers no pattern can forward
 *
 * {@link PROTECTED_HEADERS} is stripped BEFORE the allow-list is consulted, so a
 * permissive pattern (`x-*`, or a careless `*`) cannot re-open impersonation:
 *
 * | Header                           | What an app does with it        | Why spoofing it matters |
 * | -------------------------------- | ------------------------------- | ----------------------- |
 * | `x-forwarded-access-token`       | OBO auth (AppKit `asUser`)      | Paste any workspace token and every call runs as its owner. The gate's verified email says nothing about who a pasted credential belongs to. |
 * | `x-forwarded-user`               | Caller identity                 | Impersonate another user. The gate sets this itself, from a verified session. |
 * | `x-forwarded-email`              | Caller identity                 | Same. |
 * | `x-forwarded-preferred-username` | Display name from the IdP       | Same. |
 * | `x-forwarded-host`               | The originally-requested host    | Poison absolute URLs the app builds (the classic reset-link attack). |
 * | `x-forwarded-proto` / `-port`    | Original scheme / port          | Convince the app a plaintext request arrived over TLS. |
 * | `x-forwarded-for`                | Client IP                       | Forge the audit trail, and fan out per-IP rate-limit keys (see below). |
 * | `x-real-ip`                      | Client IP                       | Same. |
 * | `x-request-id`                   | Request correlation UUID        | Forge or collide trace ids, making logs unreliable. |
 *
 * The identity four are AppKit's OBO contract; the rest are the `X-Forwarded-*`
 * set the Databricks Apps reverse proxy documents passing to an app
 * ({@link https://docs.databricks.com/aws/en/dev-tools/databricks-apps/http-headers}),
 * plus the conventional `x-forwarded-proto`/`-port`/`x-real-ip` an app or one of
 * its libraries may read even though the table omits them.
 *
 * Stripping the `x-forwarded-*` transport trio is safe because `http-proxy-3` is
 * configured with `xfwd: true` and re-adds them AFTER this policy runs - from the
 * real socket, not from the caller's claim. The app therefore sees the honest
 * (loopback) values instead of whatever the internet asserted. The gate reads the
 * client IP for rate limiting from the raw inbound headers BEFORE stripping, and
 * takes the RIGHTMOST `x-forwarded-for` entry, which is the only one a proxy
 * appended rather than a client supplied.
 *
 * @module
 */

import { pattern, token, type Predicate } from "@dbx-tools/shared-core";

/**
 * Headers the gate strips UNCONDITIONALLY, before the allow-list is consulted -
 * the platform-shaped set documented in this module's table.
 *
 * These answer WHO a request is and WHERE it came from, and on tunnel traffic
 * only the gate may answer that: it injects {@link token.USER_ID_HEADER} /
 * {@link token.USER_EMAIL_HEADER} itself after verifying a session, and the proxy
 * re-derives the transport headers from the real socket.
 *
 * The identity names come from the shared `token` constants, so a renamed wire
 * contract cannot leave a stale spelling here. `x-forwarded-preferred-username`
 * has no constant because nothing in this repo READS it - it is listed precisely
 * so a host app that does read it cannot be fed one.
 */
export const PROTECTED_HEADERS: readonly string[] = [
  token.ACCESS_TOKEN_HEADER,
  token.USER_ID_HEADER,
  token.USER_EMAIL_HEADER,
  "x-forwarded-preferred-username",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-for",
  "x-real-ip",
  "x-request-id",
];

/**
 * The `x-` headers forwarded when a deployment configures nothing.
 *
 * These are the header NAMESPACES this repo's own UI sends and its own server
 * reads - Mastra thread/model routing (`x-mastra-thread-id`, `x-mastra-model`)
 * and MLflow trace correlation (`x-mlflow-trace-id`) - so a dbx-tools app keeps
 * working behind the tunnel with no configuration.
 *
 * Deliberately GLOBS rather than the exact constants from
 * `@dbx-tools/shared-mastra`: importing them would make the gate - a
 * transport-level component that has no other opinion about Mastra - depend on
 * an agent package for three strings, and a namespace glob also covers the next
 * header those packages add. The namespaces are the stable part of the contract.
 */
export const DEFAULT_FORWARD_HEADERS: readonly string[] = [
  "x-mastra-*",
  "x-mlflow-*",
  // Sent by fetch/XHR wrappers to mark an AJAX request; harmless and widely read.
  "x-requested-with",
];

/** A compiled inbound-header policy. Build one with {@link toHeaderPolicy}. */
export interface HeaderPolicy {
  /** The allow-list entries backing this policy (for diagnostics and tests). */
  readonly patterns: readonly string[];
  /** Whether `name` survives on tunnel traffic. */
  forwards(name: string): boolean;
  /**
   * Delete every disallowed header from a mutable Node header bag, returning the
   * lower-cased names removed (for debug logging).
   */
  apply(headers: Record<string, unknown>): string[];
}

/**
 * Compile the inbound-header policy. `configured` entries are UNIONED with
 * {@link DEFAULT_FORWARD_HEADERS}; each may be a literal name, a glob
 * (`x-myapp-*`), or a `/regex/`. Matching is case-insensitive.
 */
export function toHeaderPolicy(configured: readonly string[] = []): HeaderPolicy {
  const patterns = [...DEFAULT_FORWARD_HEADERS, ...configured];
  const allowed: Predicate<string> = pattern.toPatternMatcher(patterns);
  const protectedNames = new Set(PROTECTED_HEADERS);

  const forwards = (name: string): boolean => {
    const lower = name.toLowerCase();
    if (protectedNames.has(lower)) return false;
    if (!lower.startsWith("x-")) return true;
    return allowed(lower);
  };

  return {
    patterns,
    forwards,
    apply: (headers) => {
      const removed: string[] = [];
      for (const name of Object.keys(headers)) {
        if (forwards(name)) continue;
        delete headers[name];
        removed.push(name.toLowerCase());
      }
      return removed;
    },
  };
}
