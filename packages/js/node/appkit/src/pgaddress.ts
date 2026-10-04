/**
 * Lakebase PostgreSQL address parsing backed by `@dbx-tools/lakebase`.
 *
 * @module
 */

export {
  parseAddress,
  parseResourcePath,
  parseSslMode,
  SSL_MODES,
  type LakebaseConnectionInputs,
  type ParsedAddress,
  type SslMode,
} from "@dbx-tools/lakebase";

/**
 * Parse a PostgreSQL URL, Lakebase resource path, hostname, or project id.
 * Returns an empty record when the input is absent or unrecognized.
 */
