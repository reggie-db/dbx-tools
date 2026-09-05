# dbx-tools-databricks-auth

Databricks OAuth library with U2M browser login and M2M client credentials. It
owns Databricks profile resolution and endpoint policy, and delegates OAuth,
token lifecycle, storage, and locking to [`dbx-tools-auth`](../auth).

The crate exports UniFFI bindings consumed by
[`@dbx-tools/databricks-auth`](../../js/node/databricks-auth) and
[`dbx-tools-databricks-auth`](../../py/databricks-auth). The
[`dbx auth`](../../js/cli/auth) command uses the Node bindings.

`DatabricksAuthOptions.auth` embeds the shared `dbx_tools_auth::AuthOptions`
record. See [shared options and provider implementations](../auth/README.md#shared-options-and-provider-implementations)
for defaults. Rust `AuthClient` implements the shared `AuthSession` trait;
import the trait to call lifecycle methods such as `token`, `login`, and
`logout`.

`DatabricksAuthOptions.prefer_user_to_machine` defaults to `true`. An
implicitly selected M2M profile uses the unique U2M profile for the same host
when one exists. A profile selected by option or `DATABRICKS_CONFIG_PROFILE` is
never remapped. A profile with both client ID and secret uses M2M even when
`auth_type` is absent. Set the preference to `false` to disable implicit
profile remapping.

Profile configuration is parsed once per absolute file path and cached for the
process lifetime. Loaded profiles, missing files, and parse failures all reuse
the cached result, so constructing multiple clients does not repeatedly access
the profile file.

M2M follows the Databricks OAuth request shape: HTTP Basic client
authentication, `grant_type=client_credentials`, sorted scopes with `all-apis`
as the default, account/workspace token endpoint resolution, and optional
`assume_group`. Access tokens use the same persistent stores,
check-lock-check refresh, and storage-adapter locks as U2M.

Automatic U2M checks `databricks auth --help` once per process. When available,
refresh uses `databricks auth token --profile <name>`; otherwise the native
file-backed flow uses `~/.databricks/token-cache.json`. Explicit file storage
always uses the native flow. Memory storage uses neither the CLI nor file
persistence. M2M always uses its native client-credentials flow. U2M uses the
CLI profile key, while M2M uses a distinct identity-and-scope key.

The browser callback uses `OAuthTemplate` to build a self-contained HTML page
with dbx tools colors and typography. Its image source accepts a URL or data
URI. The shared auth crate includes copies of the root `brand.yaml` and light logo, embeds
the logo as a data URI, and reads its fallback text, colors, and typography from
the copied YAML. Set `AuthOptions.callback_image_src`, or construct an
`OAuthTemplate` and pass it through `OAuthFlow::with_template`, to use another
image.

See the [workspace README](../../../README.md) for package guidance.
