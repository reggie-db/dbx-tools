# dbx-tools-core

Databricks-agnostic Rust runtime primitives shared by dbx-tools crates.

`FileLock` provides bounded asynchronous acquisition of a cross-process
filesystem lock. `FileCache` builds on that lock to provide file-backed TTL
caching with a check-lock-check-load sequence and atomic publication.

```rust
use std::time::Duration;

use dbx_tools_core::FileCache;

let cache = FileCache::new("/path/to/catalogue.json", Duration::from_secs(300));
let value = cache
    .get_or_try_init(|| async { load_value().await })
    .await?;
```
