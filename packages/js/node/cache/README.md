# `@dbx-tools/cache`

Memory-first caching for Node.js and Bun, built on Cacheable v2 and Keyv.

The default project cache keeps bounded values in memory and persists them to a
project-scoped portable disk file without blocking foreground writes. Additional
Keyv-compatible levels can be supplied in read order. Pending persistence is
tracked and can be drained during application shutdown.

```ts
import { closeCache, getOrSet, projectCache } from "@dbx-tools/cache/cache";

const cache = projectCache("models", { ttl: "5m" });
const models = await getOrSet(cache, "catalog", loadModels, {
  returnCachedOnError: true,
});

await closeCache(cache);
```

Use `createCache` for explicit memory-only or custom-level caches. The package
does not depend on AppKit; `@dbx-tools/appkit` adapts it to AppKit's storage
contract.
