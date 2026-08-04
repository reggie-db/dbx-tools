/**
 * Network policy for page fetches.
 *
 * Every request, including redirects, is HTTPS, matches the configured URL
 * allow-list, and resolves only to public addresses. Resolution happens in the
 * request hook immediately before I/O so a redirect cannot bypass the policy.
 *
 * @module
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ValidationError } from "@databricks/appkit";

import { assertUrlAllowed, type UrlAllowList } from "./allowlist.ts";

/** DNS result shape used by Node and by deterministic tests. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Injectable DNS resolver for fetch-policy tests. */
export type ResolveAddresses = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** Resolve all addresses for a hostname without changing their family. */
async function resolveAddresses(hostname: string): Promise<readonly ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

/** Whether an IPv4 address is private, local, reserved, or non-unicast. */
function isBlockedIpv4(address: string): boolean {
  const [a = -1, b = -1, c = -1] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Whether an IPv6 address is private, local, reserved, or non-unicast. */
function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("100:") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

/** Whether an address is globally routable enough for an outbound page fetch. */
function isPublicAddress(address: ResolvedAddress): boolean {
  return address.family === 6 ? !isBlockedIpv6(address.address) : !isBlockedIpv4(address.address);
}

/**
 * Validate one concrete page-fetch target immediately before network I/O.
 *
 * Rejects embedded credentials, non-HTTPS URLs, disallowed hosts/paths, and
 * hostnames whose DNS answers include any private, loopback, link-local, or
 * reserved address.
 */
export async function assertFetchUrlAllowed(
  value: string,
  allowList: UrlAllowList,
  resolve: ResolveAddresses = resolveAddresses,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw ValidationError.invalidValue("url", value, "an absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw ValidationError.invalidValue(
      "url",
      value,
      "an absolute HTTPS URL without embedded credentials",
    );
  }
  assertUrlAllowed(url.href, allowList);

  const literalFamily = isIP(url.hostname);
  const addresses = literalFamily
    ? [{ address: url.hostname, family: literalFamily }]
    : await resolve(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw ValidationError.invalidValue(
      "url",
      value,
      "a URL that resolves only to public addresses",
    );
  }
}
