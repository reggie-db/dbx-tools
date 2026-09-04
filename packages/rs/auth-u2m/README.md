# dbx-tools-auth-u2m

Core Databricks user-to-machine OAuth library. It owns browser OAuth, profile
resolution, refresh orchestration, generic storage traits, and
memory/file/keyring stores.

The crate exports UniFFI bindings consumed by
[`@dbx-tools/auth-u2m`](../../js/node/auth-u2m) and
[`dbx-tools-auth-u2m`](../../py/auth-u2m). The
[`dbx auth`](../../js/cli/auth) command uses the Node bindings.

The browser callback uses `OAuthTemplate` to build a self-contained HTML page
with dbx tools colors and typography. Its image source accepts a URL or data
URI. The crate includes copies of the root `brand.yaml` and light logo, embeds
the logo as a data URI, and reads its fallback text, colors, and typography from
the copied YAML. Set `AuthOptions.callback_image_src`, or construct an
`OAuthTemplate` and pass it through `OAuthFlow::with_template`, to use another
image.

See the [workspace README](../../../README.md) for package guidance.
