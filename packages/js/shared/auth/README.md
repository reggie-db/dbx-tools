# @dbx-tools/shared-auth

Validate passwordless sign-in, passkey, Databricks profile, and resolved-client
data at browser and server boundaries. The package also provides browser helpers
for the routes owned by
[@dbx-tools/auth-gate](../../node/auth-gate).

## Read authentication status

```ts
import { authStatusSchema } from "@dbx-tools/shared-auth";

const response = await fetch("/api/email/auth/status", { credentials: "include" });
const status = authStatusSchema.parse(await response.json());

if (status.enabled && !status.authenticated) {
  showSignIn();
}
```

Use the request, verification, logout, and status schemas when custom UI or
transport code calls the auth gate directly.

## Build a profile selector

Profile summaries never include tokens or client secrets. Validate values before
rendering or persisting a selection:

```ts
import {
  databricksProfileListSchema,
  databricksProfileSelectionSchema,
} from "@dbx-tools/shared-auth";

export function selectFirstProfile(input: unknown) {
  const profiles = databricksProfileListSchema.parse(input);
  return databricksProfileSelectionSchema.parse({
    kind: "profile",
    profile: profiles[0]!.name,
  });
}
```

Use `{ kind: "ambient" }` when the consuming runtime should choose its normal
Databricks authentication source.

## Use browser sign-in helpers

The `browser` module requests and verifies email one-time passwords (OTPs),
starts passkey sign-in or enrollment, manages enrolled passkeys, reads gate
status, and logs out through the server-provided same-origin redirect.

```ts
import { requestEmailOtp, verifyEmailOtp } from "@dbx-tools/shared-auth/browser";

export async function requestCode(email: string) {
  return requestEmailOtp(email);
}

export async function submitCode(email: string, code: string, name: string) {
  return verifyEmailOtp(email, code, name);
}
```

Browser helpers use same-origin `/api/email/auth` routes and include the session
cookie. Email one-time passwords and logout require the auth-gate server routes.
Passkey operations also require a browser with WebAuthn support. A direct auth
runtime mounted elsewhere must use the same base path before these helpers can
call it.

## Runtime boundary

The Zod schemas and secret-free profile types are safe for shared code. The
`./browser` subpath performs browser network and WebAuthn operations. This
package doesn't resolve credentials, mint Databricks tokens, or register server
routes. Use [@dbx-tools/auth](../../node/auth) for Databricks credential
resolution and [@dbx-tools/auth-gate](../../node/auth-gate) for passwordless
server routes.

## Package exports

- `auth`: validates passwordless gate requests and responses.
- `browser`: performs email OTP, passkey, status, and logout operations.
- `config`: defines Databricks authentication and target values.
- `profile`: validates secret-free profile lists and selections.
- `client`: validates resolved, secret-free Databricks client information.
