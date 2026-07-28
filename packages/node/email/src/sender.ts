/**
 * Sender-address policy: turn the on-behalf-of user's email into an
 * outbound `From`, and (optionally) restrict which addresses may send.
 *
 * The default `From` re-homes the local part (everything before `@`) of
 * the OBO email on the configured sending domain, so `alice@databricks.com`
 * through a domain of `mail.example.com` goes out as
 * `alice@mail.example.com`. An explicit `from` short-circuits that; the
 * file/outbox fallback (no domain) keeps the user's address verbatim so
 * test artifacts land under a recognizable folder.
 *
 * The resolved `From` is then constrained to the effective allow-list: a
 * pattern is either an exact address (`user@domain.com`), a domain wildcard
 * (`*@domain.com` or the bare `domain.com`, matching any local part on that
 * domain), or `*` (any). This module only matches patterns; which patterns
 * apply is decided by the configured sender policy in `./config`, which
 * under the default `"allowlist"` mode fills an empty list in from the
 * sender source. {@link listSenderOptions} expands the effective list into
 * the concrete addresses a UI dropdown can offer for the current user.
 *
 * @module
 */

import { ConfigurationError, ValidationError } from "@databricks/appkit";
import { log, net } from "@dbx-tools/shared-core";

import type { ResolvedEmailConfig } from "./config.ts";

const logger = log.logger("email/sender");

/**
 * Re-home the OBO user's local part on `domain`. Throws when no usable
 * local part is available (e.g. a service-context call with no user).
 */
export function deriveSenderAddress(userEmail: string | undefined, domain: string): string {
  const local = userEmail?.split("@")[0]?.trim();
  if (!local) {
    throw ConfigurationError.resourceNotFound(
      "On-behalf-of user email",
      "Set `from` / EMAIL_FROM to send from a fixed address instead of deriving one.",
    );
  }
  return `${local}@${domain}`;
}

/**
 * Normalize a sender allow-list from config (a `string[]`) or an env var
 * (a CSV / whitespace-separated string). Delegates to the shared
 * {@link net.parseEmails} so allow-list patterns are read exactly
 * like recipient lists elsewhere: entries are trimmed, lower-cased (so
 * matching in {@link isSenderAllowed} is case-insensitive), and
 * de-duplicated; empties are dropped. An empty result means "no
 * restriction".
 */
export function parseAllowedSenders(raw: string | string[] | undefined): string[] {
  return net.parseEmails(raw, { lowercase: true });
}

/** The `@domain` suffix a wildcard / bare-domain pattern matches, else null. */
function patternDomainSuffix(pattern: string): string | null {
  if (pattern.startsWith("*@")) return `@${pattern.slice(2)}`;
  if (!pattern.includes("@")) return `@${pattern}`;
  return null;
}

/** Whether `address` (already lower-cased) satisfies a single pattern. */
function matchesPattern(address: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const suffix = patternDomainSuffix(pattern);
  if (suffix) return address.length > suffix.length && address.endsWith(suffix);
  return address === pattern;
}

/**
 * Whether `from` is permitted by the allow-list. An empty (or absent)
 * allow-list permits everything: {@link resolveEmailConfig} is what turns
 * the configured {@link SenderPolicy} into concrete patterns, so an empty
 * list here means the policy had nothing to narrow to.
 */
export function isSenderAllowed(from: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const address = from.trim().toLowerCase();
  return patterns.some((pattern) => matchesPattern(address, pattern));
}

/**
 * Throw when `from` is not permitted by the allow-list. No-op when the
 * allow-list is empty. The single enforcement point for the restriction
 * (called from {@link sendEmail}), so every send path is covered whether
 * the address was derived server-side or chosen in a UI.
 */
export function assertSenderAllowed(from: string, patterns: string[]): void {
  if (isSenderAllowed(from, patterns)) return;
  // The thrown message names the field only; the patterns are policy detail
  // that belongs in the operator's logs, not in a client or model response.
  logger.warn("sender:denied", { from, allowedSenders: patterns });
  throw ValidationError.invalidValue(
    "from",
    from,
    "an address permitted by the configured sender allow-list",
  );
}

/**
 * Resolve the `From` address for a send from the resolved config and the
 * current OBO user: explicit `from` wins, then `<local>@<domain>`, then
 * (file/outbox mode only) the user's email verbatim. Throws when none of
 * those yield an address.
 */
export function resolveSenderAddress(
  config: ResolvedEmailConfig,
  userEmail: string | undefined,
): string {
  if (config.from) return config.from;
  if (config.domain) return deriveSenderAddress(userEmail, config.domain);
  const email = userEmail?.trim();
  if (!email) {
    throw ConfigurationError.resourceNotFound(
      "Email sender address",
      "Set `from` / EMAIL_FROM, set `domain` / EMAIL_DOMAIN, or run on behalf of a user.",
    );
  }
  return email;
}

/**
 * Expand the resolved config's allow-list into the concrete `From`
 * addresses offered to the current user - the data a UI sender dropdown
 * renders. Exact-address patterns pass through; domain wildcards
 * (`*@domain.com` / bare `domain.com`) are concretized as
 * `<user-local>@<domain>` and dropped when no OBO user local part is
 * available. When no allow-list is configured, the single default sender
 * ({@link resolveSenderAddress}) is returned when it can be resolved,
 * else an empty list. The default resolved sender, when permitted, is
 * ordered first.
 */
export function listSenderOptions(
  config: ResolvedEmailConfig,
  userEmail: string | undefined,
): string[] {
  const patterns = config.allowedSenders ?? [];
  const local = userEmail?.split("@")[0]?.trim().toLowerCase();
  const options: string[] = [];
  const add = (address: string | undefined): void => {
    if (address && !options.includes(address)) options.push(address);
  };

  // Surface the address a send would use by default first, when it can
  // be resolved and the allow-list (if any) permits it.
  try {
    const fallback = resolveSenderAddress(config, userEmail);
    if (isSenderAllowed(fallback, patterns)) add(fallback.toLowerCase());
  } catch {
    // No default resolvable (e.g. file mode with no user / domain / from).
  }

  for (const pattern of patterns) {
    if (pattern === "*") continue; // "any" can't be enumerated as a choice
    if (pattern.startsWith("*@") || !pattern.includes("@")) {
      const domain = pattern.startsWith("*@") ? pattern.slice(2) : pattern;
      if (local) add(`${local}@${domain}`);
    } else {
      add(pattern); // exact address
    }
  }
  return options;
}
