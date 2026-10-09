# Code cleanup audit

## Scope

This audit reviewed the filesystem cache and approval path, AppKit and Mastra ownership boundaries, repeated local utilities, and the generated build and release pipeline. It combined focused source review with AI-SLOP Detector `3.8.6` pulse, duplicate, boundary, dead-code, and unused-dependency scans.

The automated duplicate and unused-dependency results are dominated by generated Graphiti sources and monorepo dependency declarations. The boundary scan reported no violations. Manual review against the exact installed AppKit and Mastra versions produced the actionable findings below.

## Changes completed

- `/tmp` is an explicitly writable Mastra workspace mount and no longer requires approval for filesystem mutations. User workspace paths retain the existing ownership check, and every other absolute path still requires approval.
- `sharedFS.cache()` can cache `readFile` only under declared filesystem-relative roots. AppKit Mastra passes resolved skill roots into that option, so skill files use the existing process-local `FilesCachePlugin` LRU while ordinary file reads remain live.
- Workspace decoration is tracked in a `WeakSet` instead of mutating Mastra `Workspace` instances with a private symbol property.
- Demo deployment requires an explicit Databricks profile before release preparation mutates Git state. The selected profile is forwarded to every Databricks bundle command.

## Ownership findings

### AppKit cache

AppKit's Lakebase-backed cache and cache-schema provisioning remain enabled. This is the correct cache for AppKit request and plugin results, but it is not used for skill filesystem `readFile` caching because the extra database round trip is inappropriate for frequent file reads.

`packages/js/node/appkit/src/_cache-storage.ts` currently deep-loads AppKit's private `PersistentStorage`, layers an L1 LRU over it, and patches initialization behavior. The installed public `CacheConfig.storage` extension point is stable, but the persistent implementation is not publicly exported. Preserve the current behavior until AppKit exposes the required persistent storage lifecycle or absorbs the soft-failure behavior; do not copy this pattern into another package.

### Mastra composite filesystem

`MountedCompositeFilesystem` handles Mastra's virtual-root `.gitignore` probe because native `CompositeFilesystem` cannot route that file when the root is only a mount namespace. This is a narrow compatibility gap rather than general filesystem policy. Keep it isolated and remove it when Mastra handles an unmounted virtual root natively.

## DRY findings

`retainedSize()` is implemented separately in AppKit's persistent-cache L1 and process-local files cache. The implementations are similar but size different entry shapes and belong to different cache lifecycles. Do not extract a generic helper unless a single cache owner can define the retained-value contract; a shared helper that accepts arbitrary values would hide rather than remove ownership duplication.

Generated Graphiti source contains the duplicate blocks reported by the scanner. Those files are derived artifacts and must be fixed in their upstream source or generator, not edited locally.

## Build assessment

The build graph is large but follows repository ownership: Projen defines package tasks, generated files are synthesized, and Python source synchronization is attached to package compile and test phases. No second build orchestrator was found.

The custom release transaction is complex because it owns branch preparation, synchronized versioning, validation selection, release notes, local publication, annotated tags, and optional demo deployment. That complexity is concentrated in `projen/tasks/release.ts` instead of duplicated across workflows. The implicit Databricks profile was the main unsafe edge and is now fail-closed. Future cleanup should split pure selection and validation helpers from side-effecting Git operations only when tests can preserve the transaction order.

## Remaining work

- Replace the private AppKit persistent-storage load when AppKit publishes the required storage API.
- Remove `MountedCompositeFilesystem` after Mastra supports virtual-root ignore probing.
- Keep scanner exclusions aware of generated Graphiti trees so duplicate and dead-code reports remain actionable.
