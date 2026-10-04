/**
 * AppKit compatibility surface for Node-owned Lakebase PostgreSQL addresses.
 *
 * @module
 */

import {
  parseAddress as parseLakebaseAddress,
  parseResourcePath as parseLakebaseResourcePath,
  parseSslMode as parseLakebaseSslMode,
  SSL_MODES as LAKEBASE_SSL_MODES,
  type LakebaseConnectionInputs as LakebaseInputs,
  type ParsedAddress as LakebaseParsedAddress,
  type SslMode as LakebaseSslMode,
} from "@dbx-tools/lakebase";

/** PostgreSQL TLS mode in `PGSSLMODE` spelling. */
export type SslMode = LakebaseSslMode;

/** PostgreSQL TLS modes accepted by the shared Node parser. */
export const SSL_MODES: readonly SslMode[] = LAKEBASE_SSL_MODES;

/** Pieces recovered from a Lakebase address. */
export type ParsedAddress = LakebaseParsedAddress;

/** Inputs shared by parsing and Lakebase connection resolution. */
export type LakebaseConnectionInputs = LakebaseInputs;

/** Parse a PostgreSQL URL, Lakebase resource path, hostname, or project id. */
export function parseAddress(input: string | null | undefined): ParsedAddress {
  return parseLakebaseAddress(input);
}

/** Parse a canonical Lakebase `projects/...` resource path. */
export function parseResourcePath(input: string | null | undefined): ParsedAddress {
  return parseLakebaseResourcePath(input);
}

/** Normalize a PostgreSQL TLS mode. */
export function parseSslMode(input: string | null | undefined): SslMode | undefined {
  return parseLakebaseSslMode(input);
}
