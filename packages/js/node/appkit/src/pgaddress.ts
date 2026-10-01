/**
 * Lakebase PostgreSQL address parsing backed by `@dbx-tools/core-rs`.
 *
 * Rust owns the recognized URL, resource-path, hostname, project-id, and SSL
 * mode rules. This module preserves AppKit's existing namespace, string SSL
 * spelling, sparse records, and nullable input compatibility.
 *
 * @module
 */

import {
  parseAddress as parseNativeAddress,
  parseResourcePath as parseNativeResourcePath,
  SslMode as NativeSslMode,
  type ParsedAddress as NativeParsedAddress,
} from "@dbx-tools/core-rs";

type NativeSslModeName = Extract<keyof typeof NativeSslMode, string>;

/** PostgreSQL TLS mode in `PGSSLMODE` spelling. */
export type SslMode = Lowercase<NativeSslModeName>;

/** Postgres TLS modes accepted by the native parser, in `PGSSLMODE` spelling. */
export const SSL_MODES: readonly SslMode[] = Object.keys(NativeSslMode)
  .filter((name): name is NativeSslModeName => Number.isNaN(Number(name)))
  .map((name) => name.toLowerCase() as SslMode);

/** Native parser output with AppKit's existing string SSL spelling. */
export type ParsedAddress = {
  [Key in keyof NativeParsedAddress]: Key extends "sslMode"
    ? SslMode | undefined
    : NativeParsedAddress[Key];
};

/** Inputs shared by parsing and Lakebase connection resolution. */
export type LakebaseConnectionInputs = ParsedAddress;

function sslModeName(mode: NativeParsedAddress["sslMode"]): SslMode | undefined {
  return mode === undefined ? undefined : (NativeSslMode[mode].toLowerCase() as SslMode);
}

function normalizeAddress(address: NativeParsedAddress): ParsedAddress {
  const normalized = { ...address, sslMode: sslModeName(address.sslMode) } as ParsedAddress;
  for (const key of Object.keys(normalized) as (keyof ParsedAddress)[]) {
    if (normalized[key] === undefined) delete normalized[key];
  }
  return normalized;
}

/**
 * Parse a PostgreSQL URL, Lakebase resource path, hostname, or project id.
 * Returns an empty record when the input is absent or unrecognized.
 */
export function parseAddress(input: string | null | undefined): ParsedAddress {
  return normalizeAddress(parseNativeAddress(input ?? undefined));
}

/** Parse a canonical Lakebase `projects/...` resource path. */
export function parseResourcePath(input: string | null | undefined): ParsedAddress {
  return normalizeAddress(parseNativeResourcePath(input ?? undefined));
}

/** Normalize a PostgreSQL TLS mode through the native address parser. */
export function parseSslMode(input: string | null | undefined): SslMode | undefined {
  if (input === undefined || input === null || input.trim() === "") return undefined;
  const query = encodeURIComponent(input.trim());
  return sslModeName(parseNativeAddress(`postgresql://localhost?sslmode=${query}`).sslMode);
}
