# @dbx-tools/auth

Generated Node bindings for [provider-neutral Rust authentication](../../../rs/auth).
This is outbound OAuth, not the incoming [`@dbx-tools/auth-gate`](../auth-gate).

```ts
import { createProviderAuth, ProviderOptions, OAuthGrant } from "@dbx-tools/auth";

const auth = await createProviderAuth(
  ProviderOptions.create({
    provider: "example",
    tokenEndpoint: "https://identity.example.com/oauth/token",
    clientId: process.env.OAUTH_CLIENT_ID!,
    clientSecret: process.env.OAUTH_CLIENT_SECRET!,
    grant: OAuthGrant.ClientCredentials,
    scopes: ["read"],
  }),
);
const token = await auth.token(false);
```

Omit `profile` for providers without profiles. `fileLayout` selects one shared
file or a separate file per provider/profile/sorted-scope identity. `cacheDir`
overrides the file location. Rust owns storage, locking, refresh, and browser
authorization; the TypeScript API is generated, not copied.

Both `ProviderOptions.auth` and `DatabricksAuthOptions.auth` accept the same
`AuthOptions` exported here. For example,
`auth: AuthOptions.create({ lockTimeoutSeconds: 10n })` overrides only the lock
timeout. Omit `auth` to use Rust defaults. Move former top-level timeout and
`callbackImageSrc` fields into this record; see the
[shared options guide](../../../rs/auth/README.md#shared-options-and-provider-implementations).

Use `StorageAdapter` for custom persistence. Wrap it with `createStorageHandle`
before passing it to either `createProviderAuthWithStorage` or
`@dbx-tools/databricks-auth`'s `createPersistentAuthWithStorage`. No Postgres client is bundled.
The standard package root exports generated contracts and `uniffiModule`, the
generator-owned converter table used by dependent bindings.
