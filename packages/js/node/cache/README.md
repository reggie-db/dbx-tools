# @dbx-tools/cache

Cache Node.js and Bun values in bounded memory with optional project-scoped
disk or Keyv-compatible persistence. Foreground writes don't wait for
persistence, and shutdown can drain tracked writes.

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
The package owns its Keyv runtime, so consumers do not install or pin Keyv to
align cache constructors.

## Limits

The memory level is process-local and isn't a cross-replica coordination
mechanism. Call `closeCache()` during shutdown when later levels must receive
pending writes. Use a shared Keyv-compatible level or an owning framework's
distributed cache when replicas must read the same persisted values.
