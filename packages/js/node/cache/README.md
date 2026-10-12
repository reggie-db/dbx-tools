# `@dbx-tools/cache`

Memory-first caching for Node.js and Bun, built on Cacheable v2 and Keyv.

The default project cache keeps bounded values in memory and persists them to a
project-scoped portable disk file without blocking foreground writes. Additional
Keyv-compatible levels can be supplied in read order. Pending persistence is
tracked and can be drained during application shutdown.

## Cache project data

```ts
import { closeCache, getOrSet, projectCache } from "@dbx-tools/cache/cache";

const cache = projectCache("models", { ttl: "5m" });
const models = await getOrSet(cache, "catalog", loadModels, {
  returnCachedOnError: true,
});

await closeCache(cache);
```

`projectCache` reuses the same named cache within the process. Call `closeCache`
during application shutdown to flush pending disk writes.

## Create a memory-only cache

Use `createCache` without persistence levels when values should remain local to
the current process:

```ts
import { closeCache, createCache } from "@dbx-tools/cache/cache";

const cache = createCache({ maxEntries: 250, ttl: "30s" });
await cache.set("health", { status: "ready" });

await closeCache(cache);
```

Pass ordered Keyv-compatible `levels` to `createCache` when an application needs
custom persistence. The package does not depend on AppKit;
`@dbx-tools/appkit` adapts it to AppKit's storage contract.
