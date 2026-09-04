# @dbx-tools/databricks-auth

Private generated Node bindings for the Rust `dbx-tools-databricks-auth`
package.

The [Rust package](../../../rs/databricks-auth/README.md) owns U2M and M2M
OAuth, profile resolution, refresh, locking, and built-in credential storage.
Use [`@dbx-tools/cli-auth`](../../cli/auth) for the `dbx auth` Commander
interface.

Import the Rust-generated binding directly:

```ts
import { createPersistentAuth, DatabricksAuthOptions, Storage } from "@dbx-tools/databricks-auth";

const auth = await createPersistentAuth(
  DatabricksAuthOptions.create({ profile: "DEFAULT" }),
  Storage.Auto,
);
const token = await auth.token(false);
```

Set `callbackImageSrc` on `DatabricksAuthOptions` to use a logo URL or data URI
on the browser callback page. `preferUserToMachine` defaults to `true`; set it
to `false` to keep standard M2M resolution for an implicitly selected service
principal profile. M2M reads `client_secret` from the selected Databricks
profile or `DATABRICKS_CLIENT_SECRET`.

Pass a caller-owned `pg.Pool` when credentials and advisory locks should be
shared through Postgres:

```ts
import {
  createPersistentAuthWithStorage,
  DatabricksAuthOptions,
  postgres,
} from "@dbx-tools/databricks-auth";

const auth = await createPersistentAuthWithStorage(
  DatabricksAuthOptions.create({ profile: "DEFAULT" }),
  postgres.createStorage(pool),
);
```

The adapter stores refresh credentials as sensitive JSON. Its first read is
read-only; it creates the token table only when Rust is about to log in or save
a refreshed token.

The package root exports the generated UniFFI API directly and exposes the
`bindings` and `postgres` namespaces.
