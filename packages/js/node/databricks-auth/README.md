# @dbx-tools/databricks-auth

Generated Node bindings for the Rust `dbx-tools-databricks-auth`
package.

The [Rust package](../../../rs/databricks-auth/README.md) owns U2M and M2M
OAuth, profile resolution, refresh, locking, and built-in credential storage.
Use [`@dbx-tools/cli-auth`](../../cli/auth) for the `dbx auth` Commander
interface.

Import the Rust-generated binding directly:

```ts
import { createPersistentAuth, DatabricksAuthOptions } from "@dbx-tools/databricks-auth";
import { Storage } from "@dbx-tools/auth";

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

Custom persistence stays supported without a database dependency:

```ts
import { createStorageHandle, type StorageAdapter } from "@dbx-tools/auth";
import { createPersistentAuthWithStorage, DatabricksAuthOptions } from "@dbx-tools/databricks-auth";

const auth = await createPersistentAuthWithStorage(
  DatabricksAuthOptions.create({ profile: "DEFAULT" }),
  createStorageHandle(adapter),
);
```

Here `adapter` is your implementation of the generated `StorageAdapter`.
The shared handle keeps callback execution in its owning native library.
The package root exports Databricks-specific bindings; shared token, storage,
and error contracts are imported directly from `@dbx-tools/auth`.
