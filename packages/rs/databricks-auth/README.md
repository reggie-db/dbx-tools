# dbx-tools-databricks-auth

Databricks OAuth library with U2M browser login and M2M client credentials. It
owns Databricks profile resolution and endpoint policy, and delegates OAuth,
token lifecycle, storage, and locking to [`dbx-tools-auth`](../auth).

The crate exports UniFFI bindings consumed by
[`@dbx-tools/databricks-auth`](../../js/node/databricks-auth) and
[`dbx-tools-databricks-auth`](../../py/databricks-auth). The
[`dbx auth`](../../js/cli/auth) command uses the Node bindings.

`DatabricksAuthOptions.prefer_user_to_machine` defaults to `true`. An
implicitly selected M2M profile uses the unique U2M profile for the same host
when one exists. A profile selected by option or `DATABRICKS_CONFIG_PROFILE` is
never remapped. A profile with both client ID and secret uses M2M even when
`auth_type` is absent. Set the preference to `false` to disable implicit
profile remapping.

M2M follows the Databricks OAuth request shape: HTTP Basic client
authentication, `grant_type=client_credentials`, sorted scopes with `all-apis`
as the default, account/workspace token endpoint resolution, and optional
`assume_group`. Access tokens use the same persistent stores,
check-lock-check refresh, and storage-adapter locks as U2M.

The built-in stores use the Databricks CLI locations and token format:
`~/.databricks/token-cache.json` or the OS keyring's `databricks-cli` service.
U2M uses the CLI profile key; M2M uses a distinct identity-and-scope key in
the same store. File refresh is serialized across all profiles, with a
separate short-held lock for atomic read-modify-write. Keyring refresh locks
remain per credential. The Databricks CLI does not participate in Rust's
file locks, so simultaneous CLI and library refreshes are not serialized.

The browser callback uses `OAuthTemplate` to build a self-contained HTML page
with dbx tools colors and typography. Its image source accepts a URL or data
URI. The shared auth crate includes copies of the root `brand.yaml` and light logo, embeds
the logo as a data URI, and reads its fallback text, colors, and typography from
the copied YAML. Set `AuthOptions.callback_image_src`, or construct an
`OAuthTemplate` and pass it through `OAuthFlow::with_template`, to use another
image.

See the [workspace README](../../../README.md) for package guidance.
