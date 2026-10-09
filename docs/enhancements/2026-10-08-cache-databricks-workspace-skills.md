# Cache Databricks workspace skill discovery across turns

Date: 2026-10-08

Status: Implemented; production trace validation pending

## Problem

Every AppKit-Mastra turn currently re-reads the complete Databricks Assistant
skill trees mounted for that user. This includes every reference file under
every skill, even when the prompt does not require a skill and no workspace
file changed.

RaceTrac trace `98c9e1e07c60366f89d00edaafbee8b4` shows:

- 785 HTTP GET spans in one turn;
- 581 `workspace/export` calls;
- 99 successful `workspace/get-status` calls;
- 38 missing-path `workspace/get-status` calls;
- 65 `workspace/list` calls;
- 202 `workspace/export` responses with HTTP 429;
- 15.98 seconds in `skill_action Skills Processor`.

The next measured turn repeated the behavior with 752 GETs, 545 workspace
exports, 166 HTTP 429 responses, and 12.42 seconds in skill processing. This is
per-turn work rather than one-time startup or first-user discovery.

## Partial improvement in 0.9.64

Version 0.9.64 added user-scoped workspace caching and on-demand skill search.
It fixes warm turns but still materializes too much data on a cold refresh.

Two Store 2682 turns after upgrading show:

- cold turn: 540 GETs, 330 workspace exports, 131 HTTP 429 responses, 56.08
  seconds, and no final response because the browser stream failed;
- immediate warm retry: 2 GETs, no workspace exports, no HTTP 429 responses,
  and a completed response.

The five-minute default TTL means normal use can encounter the cold-refresh
storm repeatedly. Consumers can raise `workspaceSkillRefreshTtlMs`, but the
initial and post-expiry refresh still need bounded, lazy I/O.

## Cache trace amplification in 0.9.72

Trace `56fa5b4e17e7094a97a629ad702879e0` explicitly searched for a Databricks
Apps skill. The turn completed in 15.03 seconds but produced 5,917 spans:

- 1,510 `cache.getOrExecute` spans;
- 983 cache hits and 527 cache misses;
- 3,843 `lakebase.query` spans;
- 529 Databricks GET spans;
- 205 successful workspace exports;
- 257 workspace status checks, including 131 expected 404 responses;
- 65 workspace directory listings.

Persistent-cache bookkeeping generated most of the trace:

- 1,510 `SELECT value, expiry` statements;
- 1,417 `UPDATE ... SET last_accessed` statements;
- 434 stale-entry deletes;
- 434 insert/upsert statements;
- 48 cache-size aggregation statements.

The 3,843 database calls are not additional skill downloads. They are the
persistent cache reading, touching, expiring, and rewriting individual
filesystem-operation entries. Because each query receives its own OTel span,
one skill catalogue refresh expands into thousands of trace nodes even when
most operations are cache hits.

The cache needs a request-local or process-local L1 layer over the persistent
store, batched metadata/content operations, and sampled or aggregated
bookkeeping telemetry. A hit should not require both a database read and
`last_accessed` write for every file operation on every turn.

## Root cause

`createWorkspace()` enables the default Assistant skill folders and merges
consumer folders over them:

- `/Workspace/.assistant/skills`;
- `/Users/<email>/.assistant/skills`;
- consumer-defined folders such as ESADS global and app skills.

The workspace uses a dynamic `SkillsResolver`. On every turn,
`buildWorkspaceSkillsResolver()` calls `resolveWorkspaceContribution()` and
returns all readable mount roots to Mastra's Skills Processor.

The processor recursively scans those roots. `MastraFileSystemAdapter` delegates
each filesystem operation to `DatabricksFileSystem`:

- `readdir()` maps to `workspace.list`;
- `stat()` maps to `workspace.get-status`;
- `readFile()` maps to `workspace.export`.

Each request creates new Databricks-backed mount objects. There is no
cross-turn cache for directory listings, metadata, file contents, or parsed
skills. `checkSkillFileMtime` defaults to true when skill folders exist, so
unchanged skill trees are still checked and materialized repeatedly.

## Requirements

- Keep default user, workspace, and consumer skill folders enabled.
- Preserve per-user identity and permissions.
- Reflect skill edits within a bounded refresh interval.
- Avoid exporting reference files until the selected skill needs them.
- Coalesce concurrent reads for the same user, mount, and path.
- Bound cache size and retained content.
- Keep failures, permission denials, and explicit refreshes visible.
- Reduce one normal no-skill turn to a small, stable number of workspace API
  calls with no rate limiting.

## Proposed design

### 1. Per-user materialized skill cache

Cache a local read-only materialization keyed by:

```text
workspace host + attributed user + source root
```

Reuse it across turns. Store an index containing source path, object type,
modified time, size when available, and local content path.

### 2. Bounded refresh

Add a `workspaceSkillRefreshTtlMs` option with a conservative default. Within
the TTL, return the cached skill paths without touching the Workspace API.
After expiry:

1. list roots and compare metadata;
2. export only changed `SKILL.md` files;
3. retain unchanged local content;
4. remove deleted entries;
5. refresh reference files lazily.

Support an explicit invalidation function for tests, administration, and a
future user-facing refresh action.

### 3. Lazy references

Discovery should parse `SKILL.md` only. Do not recursively export `references/`,
scripts, templates, or assets while assembling the initial skill catalogue.
Load those files through the mounted filesystem only after the model selects
the skill or requests the referenced path.

If Mastra requires eager recursive materialization, provide a cached local
filesystem to Mastra so recursion is local after the first refresh.

### 4. Check-lock-check concurrency

Check the cache before locking, recheck after acquiring the per-key lock, and
perform remote listing or export only when the entry is still stale. Share the
same in-flight refresh across concurrent turns.

### 5. Trace aggregation

Keep one skill refresh span with counts for listed, exported, reused, missing,
rate-limited, and failed objects. Avoid attaching hundreds of low-level cached
GET spans to every chat root after materialization.

## Implemented design

- `@dbx-tools/appkit` layers a bounded `lru-cache` L1 over persistent AppKit
  storage. A warm process hit performs no Lakebase query or `last_accessed`
  update.
- `@dbx-tools/appkit-mastra` persists one versioned catalogue per workspace
  host, attributed user, and ordered root set. The record contains parsed
  `SKILL.md` metadata and instructions only.
- Catalogue refresh lists each root and immediate skill directory, compares
  available listing metadata, exports only changed `SKILL.md` files, removes
  deleted skills, negatively caches missing roots, coalesces concurrent misses,
  and retains the last valid catalogue after a refresh failure.
- The dbx-tools catalogue processor preserves `search_skills` and `load_skill`
  and provides `skill_read`. References, scripts, templates, and assets are read
  directly from the current request's filesystem only after the skill is loaded.
- Ordinary workspace file operations bypass catalogue persistence and remain
  fresh. Remote-skill writes invalidate affected host catalogues.
- Bounded workspace, catalogue, Genie-suggestion, and AppKit L1 caches use the
  shared `lru-cache` dependency rather than hand-rolled Map eviction.

## Tests

- A second turn for the same user performs no workspace exports within TTL.
- Two concurrent first turns share one materialization.
- Different users never share OBO clients or private skill content.
- Shared read-only skills may reuse content only when authorization boundaries
  are preserved.
- An edited `SKILL.md` appears after refresh.
- An unchanged tree does not export reference files again.
- A selected skill can lazily read one reference file.
- Deleted skills disappear after refresh.
- Missing roots degrade to scratch without repeated 404s within TTL.
- Cache limits evict old users and large trees safely.
- Refresh failures preserve the last valid cache and remain observable.

## Acceptance criteria

For the RaceTrac reproduction:

- no-skill turns issue fewer than 20 workspace GETs after warm-up;
- no workspace 429 responses occur;
- skill processing after warm-up completes in under 500 ms;
- all default and ESADS skill folders remain available;
- user skill edits become visible within the configured refresh interval.
