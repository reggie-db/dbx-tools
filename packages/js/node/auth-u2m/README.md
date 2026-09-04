# @dbx-tools/auth-u2m

Private generated Node bindings for the Rust `dbx-tools-auth-u2m` package.

The [Rust package](../../../rs/auth-u2m/README.md) owns OAuth, profile
resolution, refresh, locking, and built-in credential storage. Use
[`@dbx-tools/cli-auth`](../../cli/auth) for the `dbx auth` Commander interface.

Load the native module on demand through the stable runtime subpath:

```ts
import { loadBindings } from "@dbx-tools/auth-u2m/runtime";

const bindings = await loadBindings();
const auth = await bindings.createPersistentAuth(
  bindings.U2mOptions.create({ profile: "DEFAULT" }),
  bindings.Storage.Auto,
);
const token = await auth.token(false);
```

Set `callbackImageSrc` on `U2mOptions` to use a logo URL or data URI on the
browser callback page. The default uses the dbx tools root brand.

Pass a caller-owned `pg.Pool` when credentials and advisory locks should be
shared through Postgres:

```ts
import { loadBindings } from "@dbx-tools/auth-u2m/runtime";
import { createStorage } from "@dbx-tools/auth-u2m/postgres";

const bindings = await loadBindings();
const auth = await bindings.createPersistentAuthWithStorage(
  bindings.U2mOptions.create({ profile: "DEFAULT" }),
  createStorage(pool),
);
```

The adapter stores refresh credentials as sensitive JSON. Its first read is
read-only; it creates the token table only when Rust is about to log in or save
a refreshed token.

## Modules

- `runtime` - stable records/interfaces plus lazy native-binding loading;
- `postgres` - `pg.Pool` credential storage with advisory locking;
- `bindings` - generated UniFFI API.
