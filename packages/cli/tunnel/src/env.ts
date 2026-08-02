/**
 * Environment-variable names the tunnel reads.
 *
 * Every setting is `TUNNEL_`-prefixed, matching the repo convention of naming a
 * variable after the package that owns it (`MASTRA_*`, `TEAMS_*`,
 * `WEB_SEARCH_*`). The gate's original names were unprefixed (`AUTH_SUBJECT`,
 * `PUBLIC_DOMAIN`, ...), which is a real hazard for a package that runs as a
 * WRAPPER: the tunnel and the app it wraps share one environment, so a generic
 * name is one the wrapped app may already use for something else, and
 * `PUBLIC_DOMAIN` in particular reads like an app-wide setting rather than a
 * portr detail. `EMAIL_AUTH_ALLOW` was worse than generic - it sat in
 * `@dbx-tools/email`'s `EMAIL_*` namespace while configuring the gate, not email.
 *
 * Each entry is an {@link EnvKey} list, EARLIEST-WINS, whose first element is the
 * current name and whose remaining elements are the deprecated originals. A
 * deployment set up against the old names keeps working; nothing needs a
 * coordinated rename. Read them through `env.string` / `env.positiveInt` /
 * `env.list`, which accept the list directly.
 *
 * Not renamed:
 *
 *   - `DATABRICKS_APP_PORT` - the Databricks Apps runtime contract. The platform
 *     sets it; the gate honours it.
 *   - `PORTR_TOKEN` / `PORTR_SERVER` / `PORTR_AUTO_ADD_PATH` - upstream
 *     [portr](https://github.com/amalshaji/portr)'s own namespace, and
 *     `PORTR_AUTO_ADD_PATH` is passed straight to that binary. Renaming these
 *     would rename someone else's contract.
 *
 * @module
 */

import type { EnvKey } from "@dbx-tools/shared-core";

/** Access allow-list patterns (domain / glob / `/regex/`). */
export const ALLOW_ENV: EnvKey = ["TUNNEL_AUTH_ALLOW", "EMAIL_AUTH_ALLOW"];

/** Subject line for the code email. */
export const SUBJECT_ENV: EnvKey = ["TUNNEL_AUTH_SUBJECT", "AUTH_SUBJECT"];

/** Display name used in the code email copy. */
export const BRAND_NAME_ENV: EnvKey = ["TUNNEL_AUTH_BRAND_NAME", "AUTH_BRAND_NAME"];

/** Line shown immediately above the code in the email. */
export const MESSAGE_ENV: EnvKey = ["TUNNEL_AUTH_MESSAGE", "AUTH_MESSAGE"];

/** Session lifetime, in seconds. */
export const SESSION_TTL_ENV: EnvKey = ["TUNNEL_AUTH_SESSION_TTL", "AUTH_SESSION_TTL"];

/** One-time-code lifetime, in seconds. */
export const CODE_TTL_ENV: EnvKey = ["TUNNEL_AUTH_CODE_TTL", "AUTH_CODE_TTL"];

/** HS256 signing secret for the session JWT. */
export const JWT_SECRET_ENV: EnvKey = ["TUNNEL_AUTH_JWT_SECRET", "AUTH_JWT_SECRET"];

/**
 * Force-clear date for sessions issued before it: every earlier cookie stops
 * verifying. Any `Date`-parseable value, or bare epoch seconds / millis.
 */
export const SESSION_EPOCH_ENV: EnvKey = "TUNNEL_AUTH_SESSION_EPOCH";

/** The public `<subdomain>.<server>` portr should serve on. */
export const PUBLIC_DOMAIN_ENV: EnvKey = ["TUNNEL_PUBLIC_DOMAIN", "PUBLIC_DOMAIN"];

/** Run the tunnel OPEN, with no gate. Ignored unless truthy. */
export const INSECURE_ENV: EnvKey = "TUNNEL_INSECURE";

/** Extra `x-` request headers tunnel traffic may forward. */
export const FORWARD_HEADERS_ENV: EnvKey = "TUNNEL_FORWARD_HEADERS";
