# Code cleanup audit

Date: 2026-10-09

Status: Complete

Archived: October 29, 2026

## Scope

This audit reviewed the filesystem cache and approval path, AppKit and Mastra ownership boundaries, repeated local utilities, search client/server contracts, workspace task orchestration, and the generated build and release pipeline. It combined focused source review with AI-SLOP Detector `3.8.6` pulse, duplicate, boundary, dead-code, and unused-dependency scans.

The automated duplicate and unused-dependency results are dominated by generated Graphiti sources and monorepo dependency declarations. The boundary scan reported no violations, and the final changed-code review attributed no findings to this cleanup. Manual review against the exact installed AppKit, Mastra, and Projen versions produced the actionable findings below.

## Changes completed

- `/tmp` is an explicitly writable Mastra workspace mount and no longer requires approval for filesystem mutations. User workspace paths retain the existing ownership check, and every other absolute path still requires approval.
- `sharedFS.cache()` can cache `readFile` only under declared filesystem-relative roots. AppKit Mastra passes resolved skill roots into that option, so skill files use the existing process-local `FilesCachePlugin` LRU while ordinary file reads remain live.
- Workspace decoration is tracked in a `WeakSet` instead of mutating Mastra `Workspace` instances with a private symbol property.
- Demo deployment resolves default environment or configured credentials directly through `@dbx-tools/auth`, including profile, host, and the other auth options. A resolved profile is forwarded to every Databricks bundle command when present.
- AppKit Mastra shutdown now awaits Mastra's native `shutdown()` lifecycle before flushing direct MLflow traces. Cancellation no longer starts asynchronous teardown while AppKit still considers the plugin active.
- Workspace compilation reads Projen's native `TaskSpec` and `TasksManifest` shapes. Tasks with conditions, working directories, environment policy, required variables, or shell selection remain under Projen execution instead of being incorrectly collapsed into the TypeScript batch.
- Workspace test discovery reuses `@dbx-tools/path/findFilesSync`, includes JavaScript and modern module test extensions, and keeps repository-level documentation tests in changed-mode selection.
- Search plugin names, extension routes, and the default mount path now have one browser-safe owner in `@dbx-tools/shared-search`. The React hook reads and validates AppKit's native boot-time `clientConfig()` payload, while single-index queries continue to use AppKit's native `useAiSearchQuery` hook.

## Ownership findings

### AppKit cache

AppKit's Lakebase-backed cache and cache-schema provisioning remain enabled. This is the correct cache for AppKit request and plugin results, but it is not used for skill filesystem `readFile` caching because the extra database round trip is inappropriate for frequent file reads.

`packages/js/node/appkit/src/_cache-storage.ts` currently deep-loads AppKit's private `PersistentStorage`, layers an L1 LRU over it, and patches initialization behavior. The installed public `CacheConfig.storage` extension point is stable, but the persistent implementation is not publicly exported. Preserve the current behavior until AppKit exposes the required persistent storage lifecycle or absorbs the soft-failure behavior; do not copy this pattern into another package.

### Mastra composite filesystem

`MountedCompositeFilesystem` handles Mastra's virtual-root `.gitignore` probe because native `CompositeFilesystem` cannot route that file when the root is only a mount namespace. This is a narrow compatibility gap rather than general filesystem policy. Keep it isolated and remove it when Mastra handles an unmounted virtual root natively.

### Mastra PostgreSQL storage

The installed Mastra PostgreSQL package does not expose public replacements for ownership-error recovery or `PgVector` pool injection. Keep the existing narrow initialization and pool adaptations until the owner publishes equivalent extension points; replacing them now would remove behavior rather than reuse native capability.

## DRY findings

`retainedSize()` is implemented separately in AppKit's persistent-cache L1 and process-local files cache. The implementations are similar but size different entry shapes and belong to different cache lifecycles. Do not extract a generic helper unless a single cache owner can define the retained-value contract; a shared helper that accepts arbitrary values would hide rather than remove ownership duplication.

Generated Graphiti source contains the duplicate blocks reported by the scanner. Those files are derived artifacts and must be fixed in their upstream source or generator, not edited locally.

The `@dbx-tools/ui/auth/react` browser-auth re-export remains intentionally retained. It is the public authentication surface of the consolidated React package, not a second implementation; behavior and state remain owned only by `@dbx-tools/shared-auth/browser`.

## Build assessment

The build graph is large but follows repository ownership: Projen defines package tasks, generated files are synthesized, and Python source synchronization is attached to package compile and test phases. No second build orchestrator was found.

The custom release transaction is complex because it owns branch preparation, synchronized versioning, validation selection, release notes, local publication, annotated tags, and optional demo deployment. That complexity is concentrated in `projen/tasks/release.ts` instead of duplicated across workflows. Demo authentication remains owned by `scripts/demo-deploy.ts` and `@dbx-tools/auth`, rather than by the release transaction. Future cleanup should split pure selection and validation helpers from side-effecting Git operations only when tests can preserve the transaction order.

## Upstream watch items

The cleanup identified no remaining repository-owned implementation work. Keep
the compatibility adaptations below until their owning frameworks expose the
required public extension points:

- Replace the private AppKit persistent-storage load when AppKit publishes the required storage API.
- Remove `MountedCompositeFilesystem` after Mastra supports virtual-root ignore probing.
- Remove the Mastra PostgreSQL initialization and pool adaptations when public lifecycle and pool extension points cover those cases.
- Keep scanner exclusions aware of generated Graphiti trees so duplicate and dead-code reports remain actionable.
