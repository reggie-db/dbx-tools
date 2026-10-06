# `@dbx-tools/shared-auth`

Keep passwordless sign-in, passkey controls, and Databricks profile selectors
consistent across browser and server packages. The package provides shared
schemas for validating responses at the network boundary plus browser helpers
that work with `@dbx-tools/auth-gate`.

## Read Authentication Status

```ts
import { authStatusSchema } from "@dbx-tools/shared-auth";

const response = await fetch("/api/auth/status", { credentials: "include" });
const status = authStatusSchema.parse(await response.json());

if (status.enabled && !status.authenticated) {
  showSignIn();
}
```

Use the request, verification, logout, and status schemas when custom UI or
transport code calls the auth gate directly.

## Build A Profile Selector

Profile summaries never include tokens or client secrets. Validate values before
rendering or persisting a selection:

```ts
import {
  databricksProfileListSchema,
  databricksProfileSelectionSchema,
} from "@dbx-tools/shared-auth";

const profiles = databricksProfileListSchema.parse(await response.json());
const selection = databricksProfileSelectionSchema.parse({
  kind: "profile",
  profile: profiles[0].name,
});
```

Use `{ kind: "ambient" }` when the consuming runtime should choose its normal
Databricks authentication source.

## Use Browser Sign-In Helpers

The `browser` module requests and verifies email OTPs, starts passkey sign-in or
enrollment, manages enrolled passkeys, reads gate status, and logs out through
the server-provided same-origin redirect.

```ts
import { requestEmailOtp, verifyEmailOtp } from "@dbx-tools/shared-auth/browser";

await requestEmailOtp("person@example.com");
await verifyEmailOtp("person@example.com", code, "Person");
```

## Package API

- `auth` validates passwordless gate requests and responses.
- `browser` performs email OTP, passkey, status, and logout operations.
- `config` defines Databricks authentication and target values.
- `profile` validates secret-free profile lists and selections.
- `client` validates resolved, secret-free Databricks client information.
