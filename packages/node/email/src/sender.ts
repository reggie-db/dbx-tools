/**
 * Sender-address policy: turn the on-behalf-of user's email into an
 * outbound `From`, and (optionally) restrict which addresses may send.
 *
 * The default `From` re-homes the local part (everything before `@`) of
 * the OBO email on the configured sending domain, so `alice@databricks.com`
 * through a domain of `mail.example.com` goes out as
 * `alice@mail.example.com`. Nothing has to be configured for that beyond the
 * domain: a fixed `from` is an OVERRIDE, not a requirement. The file/outbox
 * fallback (no domain) keeps the user's address verbatim so test artifacts land
 * under a recognizable folder.
 *
 * A send with NO user in scope is SYSTEM mail - a sign-in code, a password
 * reset, an alert - and goes from the do-not-reply address instead
 * ({@link resolveSystemSenderAddress}), because a recipient cannot usefully
 * reply to a machine and a human's address on machine mail invites them to try.
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
import { log, net, string } from "@dbx-tools/shared-core";

import type { ResolvedEmailConfig, ResolvedSender } from "./config.ts";

const logger = log.logger("email/sender");

/**
 * Re-home a user's local part on `domain`. Throws when no usable local part is
 * available; callers with no user in scope want
 * {@link resolveSystemSenderAddress} instead of a fixed `from`.
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
 * Local part of the default do-not-reply sender, used for mail that no user
 * asked for and nobody can reply to.
 */
export const SYSTEM_SENDER_LOCAL_PART = "no-reply";

/** The sender fields {@link systemSenderAddress} reads, resolved or raw. */
type SenderSource = Pick<ResolvedSender, "systemFrom" | "domain" | "from">;

/**
 * The address SYSTEM mail sends from, or undefined when nothing configured
 * yields one: an explicit {@link ResolvedSender.systemFrom} wins, else
 * `no-reply@<domain>`, else the fixed `from`.
 *
 * `no-reply@<domain>` outranks a configured `from` on purpose. A fixed `from` is
 * typically a person or a team address chosen for mail a HUMAN sent, and a
 * verification code arriving from it invites a reply nobody reads. Set
 * `systemFrom` / EMAIL_SYSTEM_FROM to name the address explicitly (a monitored
 * `support@`, a differently-spelled `donotreply@`).
 *
 * Returns undefined rather than throwing so config resolution can fold the
 * result into the sender allow-list before any send happens.
 */
export function systemSenderAddress(source: SenderSource): string | undefined {
  const explicit = string.trimToNull(source.systemFrom);
  if (explicit) return explicit;
  const domain = string.trimToNull(source.domain);
  if (domain) return `${SYSTEM_SENDER_LOCAL_PART}@${domain}`;
  return string.trimToNull(source.from) ?? undefined;
}

/**
 * The `From` for a send with no user in scope. Throws when no sender source is
 * configured at all, which in SMTP mode {@link resolveEmailConfig} has already
 * ruled out - so this only fires for an outbox with nothing configured.
 */
export function resolveSystemSenderAddress(config: ResolvedEmailConfig): string {
  const address = systemSenderAddress(config);
  if (address) return address;
  throw ConfigurationError.resourceNotFound(
    "Email sender address",
    "Set `domain` / EMAIL_DOMAIN to send system mail as no-reply@<domain>, or `systemFrom` / EMAIL_SYSTEM_FROM to name the address.",
  );
}

/**
 * Resolve the `From` address for a send from the resolved config and the
 * current OBO user.
 *
 * With a user in scope: an explicit `from` wins, then `<local>@<domain>`, then
 * (file/outbox mode only) the user's email verbatim. With NO user the send is
 * system mail, so it goes from {@link resolveSystemSenderAddress}. Throws when
 * none of those yield an address.
 */
export function resolveSenderAddress(
  config: ResolvedEmailConfig,
  userEmail: string | undefined,
): string {
  const email = string.trimToNull(userEmail);
  if (!email) return resolveSystemSenderAddress(config);
  if (config.from) return config.from;
  if (config.domain) return deriveSenderAddress(email, config.domain);
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
