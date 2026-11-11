# Projen task pruning

Date: 2026-11-10

Status: Implemented; native release replacement remains deferred pending parity evidence

## Objective

Reduce the maintenance cost of `projen/tasks` without removing useful
capabilities merely because they are infrequent or specialized. Separate three
different outcomes:

1. move reusable implementation out of executable task files;
2. replace custom machinery with a proven native owner while preserving the
   task's behavior;
3. remove a capability only after an explicit value and usage decision.

The implementation should complete the structural tiers first. Capability
removal remains optional and separately reviewable.

## Initial baseline

`projen/tasks` contained 31 files and 5,877 lines:

- `python-node-bindings.ts`: 1,214 lines
- `release.ts`: 849 lines
- `dev-watch.ts`: 381 lines
- `python-sync.ts`: 340 lines
- `verify-publications.ts`: 298 lines
- `publish.ts`: 273 lines
- `appkit-deploy.ts`: 271 lines
- `test-workspace.ts`: 254 lines
- the remaining 23 files: 1,997 lines

The directory mixes executable entrypoints, reusable implementations,
repository diagnostics, generated-agent workflows, and process supervisors.
That boundary can be corrected without deciding that every capability should
disappear.

AI-SLOP Detector `pulse`, `dead-code`, and `dupes` checks reported no priority
hotspots, dead-code issues, or duplicate-code issues. Most task code is live.
Line count and execution frequency are therefore insufficient deletion
criteria.

## Barrel warning disposition

The repeated barrel warning was harmless. It came from the old barrel watcher
classifying Python or other unrelated paths without reporting those paths. The
replacement sync dispatcher classifies one debounced batch before running any
generator. Unrelated Python paths are ignored, existing package source paths
identify their owning barrel, and newly added or removed packages trigger full
synthesis. The unowned-path warning has no remaining runtime path.

## Installed owner findings

- Projen 0.104.26 owns task manifests, task composition, build phases, default
  synthesis, release triggers, npm and PyPI publishers, trusted publishing, and
  npm publication-availability waiting.
- Projen's native `--watch` recursively watches the repository and reruns full
  synthesis. It has no relevant-path filtering or generated-output exclusion.
  Projen 0.104.26 therefore cannot preserve focused barrel and binding updates;
  the unsupported filtering and dispatch remainder stays in `@dbx-tools/projen`.
- Projen's `clobber` hard-resets to the remote branch and runs `git clean -fdx`.
  It is materially more destructive than the interactive `clean` task.
- AppKit's generated development task runs `bun --watch server/server.ts`.
  Bun already follows imported dependencies, but parity with the current
  workspace-aware demo watcher must be demonstrated before deleting that
  workflow.
- Projen's native publishers do not yet prove equivalence for exact
  multi-package archives, Bun `publishConfig` projection, lockstep `workspace:`
  materialization, per-package Python environments, publication recovery, or
  exact registry hash verification.
- AppKit deployment staging, corporate-registry-neutral Bun lockfiles,
  PythonMonkey generation, pinned Python source synchronization, and generated
  PyPI trusted-publisher agent instructions have no verified native equivalent.

## Capability protection rules

Do not remove a task or option solely because it is small, infrequently used,
interactive, or absent from CI. A capability qualifies for removal only when
all applicable evidence is recorded:

- its current consumers, generated callers, documentation, and tests are known;
- an equivalent owner exists, or the loss of behavior is explicitly accepted;
- the replacement has been exercised through the real workflow;
- safety and recovery characteristics are no worse;
- the capability cannot be retained cheaply as a generated task or thin public
  module;
- the plan names the user-visible or agent-visible behavior that will disappear.

Generated agent instructions are product behavior. Evaluate their operational
value, safety constraints, and context derivation. Do not classify them as
ordinary documentation or disposable convenience output.

## Tier 1: correct ownership and parsing

Status: implemented for the supported findings.

The lifecycle boundary is:

- `projen/src` owns synthesis-time components, public library behavior, shared
  policy, and implementations called from more than one executable;
- `projen/tasks` may own one-off runtime transactions and process supervisors;
- a task becomes a thin launcher when its implementation is reusable or is also
  called during synthesis;
- code is not moved from `tasks` to `src` solely to reduce the task-directory
  line count.

Implemented changes:

- `@dbx-tools/cli-args` now owns module naming, Commander binding, layered
  configuration, coercion, and Zod validation;
- task schemas own their flags, environment metadata, defaults, and help;
- `tasks/options.ts` was deleted;
- `tasks/cli.ts` now owns only the Projen task environment, project-root
  resolution, positional access, and cross-runtime entrypoint behavior;
- the 1,205-line PythonMonkey generator moved to
  `src/_python-node-bindings-generator.ts`; its task is now a 30-line Zod
  launcher;
- the generator fingerprint follows the source owner rather than the launcher;
- watcher-only Python binding selectors and `recordedRoots()` were deleted after
  their last production callers disappeared;
- the watcher-specific `runSynth()` wrapper and `src/scaffold.ts` were deleted;
  `bump` now executes the repository's `.projenrc.ts` directly without a second
  synthesis abstraction.

Zod metadata remains the task annotation system. No decorator or parallel
option model is needed.

### Retained task inventory

`projen/tasks` now contains 26 files and 4,171 lines. The remaining large files
are runtime transactions rather than duplicated synthesis owners.

| Files                                                                                                                   | Retained purpose                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`, `sync.ts`                                                                                                     | Shared task entrypoint/parsing adapter and the single focused continuous-generation dispatcher.                                           |
| `barrels.ts`, `bun-lockfile.ts`, `clean.ts`, `shared-core-usage.ts`, `test-workspace.ts`, `python-node-bindings.ts`     | Thin CLIs over source-owned generation, normalization, cleanup, diagnostics, dynamic test selection, and PythonMonkey generation.         |
| `bump.ts`, `version-check.ts`                                                                                           | Canonical `VERSION` mutation and cross-language manifest verification.                                                                    |
| `dev-watch.ts`                                                                                                          | Workspace-aware development process restart, include/exclude filtering, HMR-preserving one-shot mode, and process-tree shutdown.          |
| `python-sync.ts`, `python-localize-imports.py`                                                                          | Pinned upstream Python source selection, import localization, atomic replacement, and freshness verification.                             |
| `appkit-deploy.ts`                                                                                                      | Isolated AppKit upload staging, workspace dependency vendoring, local validation, and failure-log retrieval.                              |
| `publish.ts`, `publish-npm.ts`, `publish-python.ts`, `local-publish.ts`, `python-registry.ts`, `verify-publications.ts` | Immutable artifact construction, local/public registry publication, recovery, registry discovery, and exact public artifact verification. |
| `release.ts`, `release-options.ts`, `release-version.ts`, `release-notes.ts`                                            | Local release transaction, immutable tag selection, version validation, cumulative release notes, and GitHub Actions observation.         |
| `pypi-trusted-publisher-instructions.ts`                                                                                | Repository-derived PyPI account setup and reconciliation instructions for an authenticated agent.                                         |
| `ui-bundle-sizes.ts`                                                                                                    | Focused browser bundle-size diagnostic for the three public UI subpaths.                                                                  |

### Protected PyPI workflow

`pypiTrustedPublisherInstructions` remains because Projen's trusted-publishing
option configures CI authentication but does not set up or reconcile PyPI
publishers. The generated workflow still owns repository and environment
selection, credential-file safety, CAPTCHA handoff, mismatch repair, duplicate
publisher handling, and verification.

## Tier 2: replace machinery while preserving capabilities

Tier 2 removes custom implementation only when a simpler owner preserves the
workflow. Each item can land independently.

### Continuous generation

Status: complete after correcting the native-watch performance regression.

Final state:

- `bun run sync` performs one complete synthesis;
- `bun run sync -- --watch` performs one initial synthesis, then uses one
  debounced and serialized dispatcher process;
- ordinary source edits regenerate affected barrels and refresh only stale
  Python Node bindings without evaluating `.projenrc.ts`;
- shared Python Node runtime inputs run the package-owned runtime builder
  directly;
- `.projenrc.ts`, configured synthesis inputs, and package additions or removals
  trigger full synthesis;
- VS Code starts the same task on folder open;
- `bun run barrels` remains available as an explicit one-shot task;
- the old multi-process supervisor, dedicated watcher tasks, `concurrently`,
  `src/watch.ts`, and `src/workspace-lock.ts` remain deleted.

The single dispatcher retains automatic synchronization without the repeated
full synthesis cost of native Projen watch.

Acceptance checks:

- `bun run sync` and `bun run default` produce identical output;
- one synthesis discovers a newly added JS/TS package;
- Python-only changes produce no barrel warning;
- binding generation and the shared runtime build run during synthesis and
  before compilation, while freshness checks still run during tests;
- two consecutive synthesis runs produce no second-pass diff.

Implemented disposition:

- one `tasks/sync.ts` process owns initial synthesis, watch batching, action
  selection, and shutdown;
- `@dbx-tools/path` still owns filesystem watching, package discovery owns
  topology comparison, and the barrel and Python Node binding modules retain
  generation ownership;
- generated root configuration records package roots, focused resynthesis
  inputs, and the Python Node runtime directory for the dispatcher;
- Python binding generation remains in the generated-source synthesis phase,
  and the shared runtime still builds during post-synthesis and `pre-compile`;
  both retain freshness checks on `test`;
- native Projen watch is not used because it runs the complete default task for
  routine source changes.

### Workspace compilation

Status: complete for the current workspace task model.

Replace runtime inspection of `.projen/tasks.json` with synthesis-time task
composition:

- generate a TypeScript solution/reference configuration;
- let `tsc --build` own TypeScript dependency ordering;
- generate explicit task steps for non-TypeScript compile lifecycles;
- retain the root `compile` command and its coverage.

Delete `compile-workspace.ts` only after command coverage and failure reporting
match the existing task.

Implemented disposition:

- synthesis emits one `bunx tsc --build` step for ordinary TypeScript projects;
- synthesis emits explicit child lifecycle steps for projects with custom
  compile behavior and for extra workspace members;
- `compile-workspace.ts` and its runtime task-manifest inspection were deleted;
- root compile coverage and non-recursion remain covered by generated-task
  tests.

### Workspace testing

Status: complete for static test tiers; dynamic selection retained.

Preserve task names while replacing runtime discovery where possible:

- generate `test:unit`, `test:integration`, and `test:all` inputs at synthesis;
- generate the workspace graph during synthesis if it remains useful;
- use Bun test paths or workspace scripts directly;
- retain `test:focused` and `test:changed` until a native Bun/Projen expression
  provides equivalent package and reverse-dependency selection, or Tier 3
  explicitly accepts their removal.

Delete only the runtime portions that a generated task graph replaces.

Implemented disposition:

- synthesis writes explicit Bun test paths into `test:unit` and
  `test:integration`;
- `test:all` composes those tasks and `py:test` when Python is configured;
- workspace graph construction and dependency-aware `test:focused` and
  `test:changed` selection moved to `src/workspace-validation.ts`;
- `test-workspace.ts` remains as a thin runtime selector for the dynamic modes.

### AppKit development

Status: retained pending runtime parity testing.

Test the AppKit/Bun development task against the real demo before reducing
`dev:watch`:

- server edits restart correctly;
- imported workspace package edits restart correctly;
- client HMR does not restart sidecars;
- one-shot `bun run demo -- -d` behavior remains available;
- shutdown terminates the same process tree safely.

If parity holds, replace the generic supervisor with two explicit generated
tasks or a small demo-specific selector. Remove custom include/exclude globs,
restart keys, and debounce controls only after confirming they have no active
consumer.

No change was made to `dev:watch`. The repository still depends on its process
restart, HMR, include/exclude, and shutdown behavior, and this pass did not run
the real AppKit parity test required for deletion.

## Tier 3: explicit capability decisions

Tier 3 items remain available by default. Each removal requires a separate
decision recorded in this plan or its implementation PR.

| Capability                              | Default disposition                | Removal question                                                                                                                                             |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interactive `clean`                     | Keep                               | Does its safer selective deletion justify the small implementation and `@clack/prompts`, given that native `clobber` is destructive?                         |
| `pypiTrustedPublisherInstructions`      | Keep                               | No removal planned. Reconsider only if another owner produces the same repository-derived agent workflow and safety rules.                                   |
| UI bundle sizes and shared-core usage   | Keep or move to repository scripts | Are these still useful diagnostics but inappropriate to publish in `@dbx-tools/projen`? Moving them can reduce package scope without deleting the workflows. |
| `test:focused` and `test:changed`       | Keep                               | Do direct Bun paths and CI coverage replace dependency-aware local iteration adequately?                                                                     |
| Local npm/devpi publication             | Keep until reviewed                | Is it used for release recovery or offline validation, and can explicit publisher commands replace auto-discovery safely?                                    |
| Generated release notes                 | Keep until reviewed                | Is cumulative successful-release baseline selection still valuable enough to remain part of release preparation?                                             |
| GitHub Actions release watcher          | Keep until reviewed                | Does append-only local status and failed-step output materially improve release operation?                                                                   |
| Per-release tag selections              | Keep until reviewed                | Are selective npm, PyPI, docs, and validation releases used for recovery, or can one fixed release contract cover every case?                                |
| Optional demo deployment during release | Keep separate or retain flag       | Is coupling release and demo deploy valuable, or should the same behavior remain as an explicit post-release command?                                        |

For infrequent operational workflows, inspect git history, generated callers,
release records, and documentation. Absence from ordinary development commands
does not establish low value.

## Tier 4: native Projen release experiment

Create an isolated fixture using Projen 0.104.26 `ReleaseTrigger.manual()` and
`Publisher`. Do not change the production release until the fixture proves:

- the reviewed `VERSION` is used without conventional-commit recalculation;
- the annotated `vX.Y.Z` tag resolves to the exact `origin/main` commit;
- no GitHub Release is required;
- one build produces immutable npm and Python artifacts consumed by separate
  publisher jobs;
- Bun-packed npm manifests contain concrete `workspace:*` and `catalog:`
  versions and compiled `publishConfig` entrypoints;
- every Python distribution is built from its package-owned uv environment;
- trusted npm and PyPI publishing work without rebuilding artifacts;
- publication recovery does not republish an existing matching version;
- public verification compares exact npm archive identity and Python hashes, or
  a separate decision explicitly accepts weaker availability-only checks.

Adopt public native APIs for the capabilities that pass. Retain a narrow custom
remainder for requirements that fail. Do not wrap, patch, or subclass Projen's
release internals.

## Expected reduction by tier

| Tier   | Behavior change                    | Expected effect                                                                                                                                        |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tier 1 | None                               | Remove repeated parsing and inverted ownership. Runtime-only transactions may remain in `tasks`; the current directory is 26 files and 4,171 lines.    |
| Tier 2 | No intended capability loss        | Watcher infrastructure and the compile runtime planner are removed. Static test planning moved to synthesis; dynamic selectors and `dev:watch` remain. |
| Tier 3 | Explicitly approved per capability | Additional deletion depends on operational value decisions. Do not include these lines in the committed cleanup target.                                |
| Tier 4 | No intended release-contract loss  | Potentially remove substantial custom release code, but only after artifact and recovery parity.                                                       |

This accounting prevents a small task-directory number from hiding code that
was merely relocated or useful behavior that was removed.

## Validation

- Run focused tests for each moved owner and its thin entrypoint.
- Snapshot or compare task help and generated `.projen/tasks.json` across Tier
  1 changes.
- Run packed external-consumer tests after changing published task paths or
  exports.
- Run the real AppKit development workflow before changing watchers.
- Run release artifact, recovery, and public-verification fixtures before any
  release ownership change.
- Run `bunx projen` twice and require no second-pass diff.
- Run documentation checks, `bun run version:check`, and
  `bun run slop:review` for implementation changes.

### Current implementation evidence

- Two consecutive `bunx projen` runs produced the same diff hash.
- A live `bun run sync -- --watch` session reached its ready state and classified
  a touch of `packages/js/shared/core/src/options.ts` as one package barrel plus
  Python Node bindings. It produced no full-synthesis output after the touch.
- Focused tests cover ordinary source edits, binding-owned source edits, runtime
  inputs, configured resynthesis inputs, package topology changes, unrelated
  Python paths, generated task wiring, and VS Code folder-open execution.
- `bun run barrels` reported that barrels were current and emitted no ownership
  warning.
- `bun run pre-compile` regenerated or checked the Python runtime, Python Node
  bindings, and pinned Python sources without watcher tasks.
- The generated root `bun run compile` completed with one TypeScript build step
  plus explicit local lifecycles for custom JavaScript projects. Python
  subprojects were excluded from Bun lifecycle composition to prevent them from
  delegating back to the root compile task.
- The Projen suite contains 268 tests across 49 files. Every test passed during
  this change's validation runs. The final aggregate run reported 267 passes and
  one existing changed-mode test timeout while corporate Git hooks exceeded its
  fixed five-second budget; that same test passed earlier in 3.82 seconds.
- Source documentation, generated-link, lockfile-registry, version, ESLint, and
  AI-SLOP Detector checks passed. ESLint retained two unrelated import-order
  warnings in `appkit-model-gateway`.

## Audit evidence

- Installed Projen version: 0.104.26.
- Initial task inventory: 31 files, 5,877 lines.
- Current task inventory: 26 files, 4,171 lines.
- AI-SLOP Detector pulse: clean, no priority hotspots.
- AI-SLOP Detector dead-code sweep: zero issues.
- AI-SLOP Detector duplicate sweep: zero issues.
- The generated PyPI trusted-publisher workflow is assembled from current
  repository and Python publication configuration and is covered by generated
  helper execution tests.
- Git history shows the watcher stack, workspace planners, and release options
  were added for specific workflows. Review those workflows individually rather
  than treating their code size as evidence for deletion.
