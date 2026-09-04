# @dbx-tools/auth-u2m

Private generated Node bindings for the Rust `dbx-tools-auth-u2m` package.

The implementation and complete API semantics live in the
[Rust package](../../../rs/auth-u2m/README.md). This README may add Node-specific
integration guidance without duplicating the Rust documentation.

Pass a caller-owned `pg.Pool` when credentials and advisory locks should be
shared through Postgres:

```ts
import { bindings, postgres } from "@dbx-tools/auth-u2m";

const auth = await bindings.createPersistentAuthWithStorage(
  { profile: "DEFAULT" },
  postgres.createStorage(pool),
);
```

The adapter stores refresh credentials as sensitive JSON. Its first read is
read-only; it creates the token table only when Rust is about to log in or save
a refreshed token.
