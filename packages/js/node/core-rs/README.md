# `@dbx-tools/core-rs`

Generated Node bindings for Databricks authentication, runtime utilities, and
Lakebase address parsing from the `dbx-tools-core` Rust crate.

```ts
import { createPersistentAuth, DatabricksAuthOptions } from "@dbx-tools/core-rs";

const auth = await createPersistentAuth(DatabricksAuthOptions.create({}));
const token = await auth.token();
```

This package contains only generated UniFFI bindings and the matching native
library dependency. Databricks workspace, filesystem, cloud, and network
utilities remain in [`@dbx-tools/databricks`](../databricks).