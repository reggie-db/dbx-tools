# Independent Polyglot Versioning and Affected Releases

Date: 2026-09-30

Status: Implemented. Independent mode is enabled for this repository; fixed mode remains the consumer default.

## Implementation result

The implementation keeps Release Please as the semantic version, release PR,
component tag, and GitHub Release owner while preserving Projen as the only
writer of real package manifests. Each release unit uses a synthetic
`.release-units/<component>` control directory with the Release Please `simple`
strategy. This avoids competing Node, Python, and Rust manifest writers and
lets one unit own cross-language generated artifacts.

`DBXToolsReleaseCatalog` generates the normalized graph and source markers. A
custom Release Please workspace plugin retains direct semantic increments and
adds only required dependent patches. The reviewed graph diff produces the
affected release plan consumed by selective npm, PyPI, Cargo, UniFFI, binary,
GitHub Release, and documentation jobs. Release Please owns writable manifests
and changelogs; Projen reconciliation regenerates and validates every package
surface before the release PR is merged.

Two proposal details were corrected during implementation:

- ignored `bun.lock` and `uv.lock` are optional post-install evidence, not
  committed graph inputs;
- Release Please native ecosystem strategies do not edit Projen-owned package
  manifests. Synthetic `simple` components plus Projen rendering provide one
  source of truth for polyglot units.

Baseline and rollout evidence:

- fixed release `0.6.229` ran 21 jobs, including six Rust target jobs, and
  completed in 9 minutes 9 seconds;
- the independent Node-only recovery simulation selected one npm package,
  omitted Rust, Python, and GitHub asset stages, allocated zero Rust targets,
  and completed its package dry run successfully;
- the model-proxy recovery simulation selected only
  `dbx-tools-model-proxy` across its six supported targets.

## Objective

Replace the repository-wide fixed version with generated, per-release-unit
versions so an unchanged package or native artifact does not receive a new
version and does not enter the GitHub Actions release build.

The first required outcome is the cross-language case: when a Node package
changes but its Rust dependency does not, the Rust crate, native bindings, and
release binaries keep their existing versions and the Rust matrix is skipped.
The same rule should apply to unrelated Node, Python, and Rust packages.

This capability must live in `@dbx-tools/projen`, be generated rather than
hand-maintained, and work for consuming projects that contain any subset of
Node, Python, Rust, UniFFI bindings, native release binaries, and documentation.
Dependency discovery must cover every project attached to the Projen root and
must not be implemented as a Rust-specific or binding-specific feature.

## Executive Decision

Use Projen as the configuration and workflow-generation layer, but do not use
Projen's native `Release` component as the version solver. Projen's release
surface takes one `versionFile` per release component and is designed around a
single project version. It remains useful for `Component`, task, file, and
GitHub workflow generation, but it does not provide the polyglot dependency
graph and per-package manifest behavior required here.

Adopt Release Please manifest mode as the external version-management engine:

- its manifest records a version per configured component;
- it has native Node, Python, and Rust release strategies;
- its `node-workspace` and `cargo-workspace` plugins update local dependency
  relationships and transitive dependents;
- `extra-files` can update additional generated JSON and TOML version surfaces;
- a single combined release PR can contain only the components that changed.

Generate Release Please configuration, the version catalog, release-unit graph,
validation tasks, and affected-only GitHub Actions workflows from
`@dbx-tools/projen`.

Do not make Release Please's linked-version plugin the primary representation
of cross-language artifacts. Instead, model artifacts that must share a version
as one dbx-tools release unit. For example, a Rust UniFFI crate, its Node facade,
its platform-specific npm packages, and its Python wheel are one release unit
with one version and several publication targets. This avoids competing version
owners and keeps the coupling explicit in the Projen project model.

## Why Not the Alternatives

| Option                       | Decision                           | Reason                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Projen native `Release`      | Use only for generation primitives | It owns one version file and one project release. Building a polyglot package graph on top would duplicate a purpose-built release tool.                                                                     |
| Release Please manifest mode | Adopt                              | It supports Node, Python, and Rust manifests, component-specific tags, monorepo manifests, dependency plugins, and additional version files.                                                                 |
| Changesets                   | Do not use as the primary engine   | Its change-file workflow is strong for npm workspaces, but first-party version application is centered on `package.json`. Rust and Python would require a second version engine or virtual package adapters. |
| Lerna, Rush, or Beachball    | Do not adopt                       | They would solve only the JavaScript portion and leave Rust, Python, UniFFI, and GitHub release assets under custom logic.                                                                                   |
| A new custom version solver  | Avoid                              | The repository should own release-unit discovery and publication policy, not reimplement semantic version calculation, changelog generation, tag discovery, and release PR maintenance.                      |

## Current Constraints

The current release system assumes one version everywhere:

- `VERSION` is the source for every generated Node, Python, and Rust manifest.
- `projen/src/workspace-version.ts` reads, increments, and synchronizes that
  global value.
- `projen/tasks/version-check.ts` rejects any package whose version differs from
  `VERSION`.
- `projen/tasks/publish.ts` requires every npm workspace member and lockfile
  entry to match the release version.
- `projen/tasks/publish-python.ts` temporarily stamps every Python package and
  sibling dependency with one release version.
- the Cargo workspace uses `[workspace.package].version`, and every internal
  path dependency is generated with the same version.
- the generated release workflow starts the Rust matrix for every release.
- `@dbx-tools/rust-binary` builds GitHub release URLs from its own package
  version, so a Node package release currently implies a same-version Rust
  asset must exist.
- `@dbx-tools/cli` and `@dbx-tools/projen` intentionally use the CLI version as
  their lockstep compatibility boundary.

Independent versioning therefore cannot be added only to the bump task. The
version source, internal dependency ranges, native artifact lookup, publish
drivers, tags, and workflow matrices must move together.

## Desired Release Semantics

### Release units

A release unit is the smallest independently versioned set of artifacts. It has
one component name, one semantic version, one source boundary, and one or more
publication targets.

Examples:

| Release unit      | Owned artifacts                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `rs-core`         | `dbx-tools-core`, `@dbx-tools/core-rs`, platform-native npm packages, and `dbx-tools-core-rs` wheels         |
| `rs-google`       | `dbx-tools-google`, `@dbx-tools/google-rs`, platform-native npm packages, and `dbx-tools-google-rs` wheels   |
| `rs-model`        | `dbx-tools-model`, `@dbx-tools/model-rs`, and platform-native npm packages                                   |
| `rs-model-proxy`  | `dbx-tools-model-proxy` crate and `dbx-model-proxy` GitHub release archives                                  |
| `node-appkit`     | `@dbx-tools/appkit`                                                                                          |
| `python-postgres` | `dbx-tools-postgres`                                                                                         |
| `projen-cli`      | `@dbx-tools/projen` and `@dbx-tools/cli` until their existing bootstrap contract is intentionally redesigned |

Private example apps, root tooling packages, and unpublished Rust crates remain
outside the public version catalog unless they own a release asset.

### Version propagation

Apply these rules in order:

1. A directly changed release unit receives the semantic increment inferred by
   Release Please, with an explicit override available for exceptional releases.
2. Every artifact inside that release unit receives the same version.
3. An unchanged dependency never receives a new version merely because one of
   its dependents changed.
4. A dependent receives a new version when its dependency changes and the
   configured workspace policy requires a dependent patch, when its published
   dependency metadata must change, when it embeds or republishes the artifact,
   or when a compatibility boundary requires a coordinated release.
5. Version propagation never runs backward from a changed dependent to an
   unchanged dependency. A Node change cannot bump the Rust unit it consumes.
6. Exact native or generated relationships remain explicit release-unit
   coupling rather than being approximated with broad ranges.

The Projen test suite must pin these semantics because the selected release
tool's workspace behavior is part of the generated product contract.

### Tags and releases

Use stable component-qualified tags rather than one global `v<version>` tag.
Examples include `rs-core-v0.7.0`, `node-appkit-v1.4.2`, and
`python-postgres-v0.8.1`.

Component names must be explicit generated identifiers, not inferred forever
from directory paths. Renaming a folder must not silently create a new release
history.

A single release PR may advance several components. Publication still respects
the generated dependency order, but each component keeps its own tag, version,
release notes, and retry state.

## Proposed `@dbx-tools/projen` Design

### 1. Add a release catalog component

Add a root component such as `DBXToolsReleaseCatalog` that owns:

- release-unit registration and validation;
- reading the current per-component versions;
- mapping package names and generated artifacts to release units;
- constructing one normalized dependency graph for every project attached to
  the root, regardless of implementation language;
- dependency and publication edges;
- tag names and release types;
- generated Release Please configuration;
- generated workflow planning metadata.

The catalog should expose one lookup API, for example
`versionFor("rs-core")`, that every Node, Python, and Rust project generator
uses. Do not add language-specific copies of version records.

### 2. Generate the canonical files

Generate and commit:

- `release-please-config.json` from the registered release units;
- `.release-please-manifest.json` as the current version map managed by Release
  Please;
- `.projen/release-units.json` as a generated execution graph containing unit
  ids, owned paths, artifacts, dependency edges, build targets, and publish
  targets.

The Projen project model remains the source of truth for release-unit shape.
Release Please owns only the changing version values and changelog state.

Ordinary synthesis must read the manifest and reproduce the same versions. It
must never reset a component to a default or derive a version from another
component.

### 3. Add an opt-in compatibility mode

Introduce a root option such as:

```ts
versioningMode: "fixed" | "independent";
```

Keep `fixed` as the migration default until this repository and external
consumer fixtures pass the full release simulation. New projects can default to
`independent` only after the generated surface is stable.

The independent mode should be available without enabling publication so a
consumer can adopt per-package manifests before adopting the generated GitHub
release workflow.

### 4. Discover the complete root dependency graph

Start with the projects registered under the root Projen project, not with a
Rust workspace or one package directory. Every publishable project and generated
artifact becomes a node in one normalized graph. Internal dependency edges are
merged from ecosystem adapters:

- Node reads declared internal dependencies from `package.json` and workspace
  membership, then validates their resolved workspace versions against
  `bun.lock`;
- Python reads declared requirements from `pyproject.toml` and
  `[tool.uv.sources]` workspace mappings, then validates the resolved packages
  against `uv.lock`;
- Rust reads path and workspace dependencies from `Cargo.toml` through
  `cargo metadata`, then validates their resolved package versions against
  `Cargo.lock`;
- generated and cross-language edges come from the owning Projen components,
  including UniFFI crate-to-Node/Python artifacts, native release binaries,
  code generation, and explicit publication dependencies;
- consuming projects can register another ecosystem adapter without changing
  the release planner.

Normalize the discovered relationships into typed edges such as `runtime`,
`build`, `generated`, `publish`, and `development`. Only edge types that affect
the published artifact or release order participate in version propagation.
Development-only edges remain available for validation and task ordering but do
not cause releases.

Use lockfiles as resolved evidence, not as the sole source of dependency intent.
Lockfiles can be stale, contain external and transitive packages, omit generated
artifact ownership, and cannot describe every cross-language build relationship.
The declared manifests and Projen project relationships define the graph;
`bun.lock`, `uv.lock`, `Cargo.lock`, and ecosystem metadata commands verify that
the installed resolution agrees with it.

Synthesis or release validation must fail when a declared internal edge cannot
be resolved, a lockfile resolves a different internal version, or a generated
cross-language artifact has no owning release unit. A lockfile-only change must
not automatically mark every package as changed; the planner should map the
changed resolution back to the affected internal graph nodes.

### 5. Discover release units and allow explicit grouping

Default discovery rules:

- each publishable Node package is one `node` release unit;
- each publishable handwritten Python package is one `python` release unit;
- each publishable Rust crate or binary is one `rust` release unit;
- a UniFFI crate absorbs its generated Node, native npm, and Python artifacts;
- private projects are excluded;
- an explicit `releaseUnit` option groups projects that intentionally share a
  version;
- an explicit stable `component` option overrides the generated component id.

Synthesis must fail when a publishable artifact is unowned, owned by two units,
or depends on an unknown internal package.

### 6. Replace global version reads

Update generated project classes to resolve their version from their release
unit:

- Node `package.json` versions use the package's unit version.
- Python `project.version` uses the package's unit version.
- Rust crates use explicit `[package].version`; remove
  `[workspace.package].version` in independent mode.
- internal Cargo dependencies receive the target crate's version rather than
  the current crate's version.
- generated `PACKAGE_VERSION` constants stay package-local.
- the self-synthesizing `projen/` package reads the `projen-cli` unit version.
- root and private manifests use a non-published development version or omit
  release participation instead of impersonating a public package version.

Retain `projen/src/workspace-version.ts` only for fixed-mode compatibility during
migration. Replace it with a release-catalog module once fixed mode is removed.

### 7. Generate ecosystem dependency policies

Node:

- keep workspace links in source manifests;
- project published dependency ranges from the target unit version;
- use compatible ranges for normal runtime dependencies;
- use exact versions only for ABI, native-loader, or generated facade edges;
- configure and test `node-workspace` with `always-link-local: false` so package
  discovery honors declared SemVer relationships instead of force-linking every
  local package across breaking ranges;
- pin the resulting dependent patch behavior in generated fixtures.

Rust:

- keep local `path` dependencies for development;
- generate the dependency crate's current version beside the path;
- use the `cargo-workspace` plugin for dependency and lockfile updates;
- verify pre-1.0 range behavior with fixtures rather than assuming an update
  policy from post-1.0 semantics.

Python:

- keep root `[tool.uv.sources]` workspace overrides for local development;
- publish registry-based compatible requirements instead of `git+...@main`
  dependencies;
- use exact requirements only for generated native bindings that must match;
- add a Projen-generated Python dependency validator because Release Please has
  no Python workspace plugin equivalent;
- require an explicit dependent release when a dependency crosses the generated
  compatibility range.

### 8. Decouple Rust binary lookup from npm package versions

Extend each generated `RustReleaseBinaryCommand` entry with its owning component
and current binary version. Build release URLs from the command's component tag
and version, not from `@dbx-tools/rust-binary`'s `PACKAGE_VERSION`.

For example, the registry should contain enough information to resolve:

```text
rs-model-proxy-v0.9.3/dbx-model-proxy-linux-x64-gnu.tar.gz
```

The `@dbx-tools/rust-binary` package then receives a release only when the
registry or runtime changes. A Node-only release elsewhere no longer requires a
matching Rust GitHub asset.

Keep `@dbx-tools/cli` and `@dbx-tools/projen` in one release unit initially. A
separate follow-up can replace the CLI's own-version bootstrap rule with an
explicit engine dependency range if independent versions for those two packages
become valuable.

### 9. Generate an affected release plan

Add a deterministic task such as `release:plan` that compares the old and new
release manifests, maps changed files and resolved dependency changes onto the
root-wide graph, and emits JSON containing:

- changed release units and old/new versions;
- direct and required dependent releases;
- topologically ordered publish batches;
- all affected internal dependencies across language boundaries;
- Rust build targets;
- Node packages;
- Python distributions;
- GitHub release assets;
- documentation work;
- omitted stages.

The generated GitHub workflow must consume this plan, not broad repository path
filters. Path filters do not understand generated artifacts, dependency edges,
release groups, or manual release overrides.

Persist the plan as a workflow artifact and support a manual
`workflow_dispatch` component/version override for recovery. Release Please
action outputs may seed the first run, but they must not be the only source for
a retry after tags or releases already exist.

### 10. Replace all-or-nothing jobs with matrices

Generate the release chain as selected stages:

```text
plan -> Rust -> Python -> Node -> docs
```

Each stage is omitted when the plan contains no work for it. Within a stage,
use matrices over release units rather than rebuilding or publishing the entire
ecosystem.

Required behavior:

- a Node-only plan creates no Rust runner jobs;
- a Rust library plan builds only the target crate and its owned bindings;
- a Rust binary plan builds only that binary's supported platform matrix;
- Python publishes only changed Python units and wheels owned by changed Rust
  units;
- Node publishes only changed Node units and npm artifacts owned by changed Rust
  units;
- publishing follows the topological dependency order;
- projects without one or more languages generate no empty jobs for them;
- docs run after all selected publication stages and only when release or docs
  content requires regeneration.

### 11. Preserve content-addressed caching

Skipping unchanged release units provides the largest saving. Keep a second
layer of caching for units that do run:

- cache keys should use toolchain, target, lockfile, build configuration, and
  source/dependency hashes;
- exclude changelog-only and version-catalog-only changes from compilation
  cache keys when the produced binary does not embed those values;
- rerun packaging and metadata stamping even when compilation output is reused;
- do not key Rust, Node, or Python build caches on the release batch or another
  ecosystem's version.

The release plan should print cache-relevant source hashes so missed reuse can
be diagnosed from workflow logs.

## Release Please Configuration Policy

Generate one combined release PR by default. This keeps cross-language version
and generated dependency updates reviewable as one atomic change while
preserving independent versions inside the PR.

Recommended generated settings:

- `separate-pull-requests: false`;
- `include-component-in-tag: true`;
- `include-v-in-tag: true`;
- `plugins` containing `node-workspace` and `cargo-workspace` only when those
  ecosystems are present;
- `always-link-local: false` for normal internal dependency edges;
- package entries using `node`, `python`, or `rust` release types;
- `extra-files` only for additional version surfaces owned by the same release
  unit;
- stable `component` names explicitly generated from the Projen release-unit
  registry.

Pin Release Please and its GitHub Action to tested versions or immutable action
SHAs. Add an upgrade test fixture before changing those pins because plugin
behavior is part of the generated release contract.

Use conventional PR titles or squash commit messages as the normal semantic
increment source. Generate a validation workflow for that convention. Preserve
an explicit maintainer override using Release Please's release override support
for exceptional major, minor, or patch choices.

## Migration Plan

### Phase 0: Inventory and baseline

- generate an inventory of every public package, native artifact, current tag,
  registry destination, internal dependency, and release job;
- record current release duration, runner count, cache hit rate, and Rust matrix
  cost;
- decide the stable component ids before generating any component tags;
- document existing intentional lockstep relationships separately from
  accidental global-version coupling.

Exit criteria: every published artifact has one proposed owner and every
internal dependency has a compatibility policy.

### Phase 1: Add the catalog in fixed compatibility mode

- implement `DBXToolsReleaseCatalog` and release-unit registration;
- generate `.projen/release-units.json`;
- make every language generator ask the catalog for versions while the catalog
  still returns the single current version;
- replace the old global equality check with catalog ownership and consistency
  validation;
- add consumer fixtures for Node-only, Python-only, Rust-only, and mixed roots.

Exit criteria: synthesis and release output remain behaviorally unchanged, but
no project class reads `VERSION` directly.

### Phase 2: Bootstrap Release Please manifests

- generate `release-please-config.json` and
  `.release-please-manifest.json` with every component initialized to its current
  published version;
- run Release Please in a non-publishing test repository or branch;
- verify generated version changes survive `bun run sync` with no diff;
- validate component tags against the existing global-tag history and define
  the first independent tag for each unit.

Exit criteria: a dry-run release PR changes only selected component versions
and their required generated dependency metadata.

### Phase 3: Remove cross-language lockstep assumptions

- move Rust crates to explicit per-crate versions;
- update internal Cargo versions from dependency units;
- change Python publication from one workspace stamp to selected package builds
  with real registry dependency ranges;
- embed binary component versions in the Rust command registry;
- update UniFFI packaging to accept a release-unit version per binding rather
  than one `RELEASE_VERSION`;
- keep `projen-cli` as the explicit remaining lockstep unit.

Exit criteria: changing a handwritten Node package produces no Rust, Python, or
native artifact version changes.

### Phase 4: Add affected-only release workflows

- generate `release:plan` and its schema;
- replace scalar `RELEASE_VERSION` workflow state with a release-unit matrix;
- make Rust, Python, Node, and docs jobs conditional on plan contents;
- retain the Rust -> Python -> Node -> docs ordering for selected stages;
- add idempotent manual recovery for one component and version;
- retain local registry preflight, but run it only for planned units and their
  required dependency closure.

Exit criteria: a Node-only release has no Rust job, and a one-package Node
release does not build or publish unrelated Node packages.

### Phase 5: Enable independent releases

- enable Release Please on the default branch;
- make the reviewed release PR the only normal version mutation path;
- retire `bun run bump` and adapt `bun run release` into a release-status or
  release-PR wrapper;
- remove the root `VERSION` file and fixed-mode synchronization only after all
  consumer fixtures and recovery drills pass;
- update `projen/README.md`, package READMEs, and release operator docs.

Exit criteria: unchanged release units preserve their versions across several
real releases and registry/tag state can be reconstructed from committed
manifests.

### Phase 6: Make independent mode the consumer default

- publish the new `@dbx-tools/projen` option as opt-in first;
- exercise it in at least one external fixture or consuming repository;
- document migration from fixed mode;
- change the default only in a separately reviewed release after compatibility
  evidence is available.

Exit criteria: projects omitting Rust, Node, Python, UniFFI, or docs synthesize
valid minimal workflows without custom patches.

## Validation Matrix

Add generated-project and release-plan tests for at least these cases:

| Scenario                                                              | Expected result                                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| One handwritten Node package changes                                  | Only that unit and required dependents bump; Rust and Python stages are absent.                             |
| A Node package changes while its Rust binding dependency is unchanged | The Rust unit keeps its version and no Rust build runs.                                                     |
| A Node dependency receives a release                                  | Required dependents receive the pinned `node-workspace` patch behavior; unrelated dependencies do not bump. |
| A Node dependency crosses its allowed range                           | The release plan requires an explicit compatible range or coordinated dependent release.                    |
| A Rust UniFFI crate changes                                           | The crate, Node facade, native npm packages, and Python wheel share one new unit version.                   |
| A core Rust crate changes                                             | Cargo dependency updates and only required Rust dependents enter the plan.                                  |
| A Rust binary changes                                                 | Only that binary platform matrix runs; runtime registry records the new component version.                  |
| A Python dependency remains within range                              | The dependent Python package does not bump.                                                                 |
| A Python dependency becomes incompatible                              | Validation requires an explicit dependent release and updated range.                                        |
| CLI changes without Rust changes                                      | `projen-cli` may bump; Rust binary component versions and builds remain unchanged.                          |
| Version-only release PR reruns                                        | Synthesis is idempotent and publication skips artifacts already present.                                    |
| Consumer has no Rust                                                  | No Cargo files, Rust plugin, Rust workflow jobs, or Rust secrets are generated.                             |
| Consumer has no Python                                                | No uv setup or PyPI jobs are generated.                                                                     |
| Consumer has only one package                                         | Independent mode remains valid without monorepo-only assumptions.                                           |

Run an end-to-end fixture against temporary npm, PyPI/devpi, Cargo, and GitHub
release substitutes before enabling the default-branch workflow.

## Acceptance Criteria

- Release PRs do not change versions for unaffected release units.
- A Node-only release schedules zero Rust build jobs.
- A release containing one independent Node package does not publish the entire
  npm workspace.
- UniFFI artifact families remain exact-version consistent across Rust, npm, and
  Python.
- Rust release binaries resolve their own component version rather than an npm
  consumer package version.
- Internal dependency versions and ranges are generated from one release-unit
  graph.
- Release workflows remain valid when Rust, Node, Python, or docs are absent.
- Failed publication can be retried for one component without changing another
  component's version or rebuilding unrelated artifacts.
- `bun run sync` after a generated release PR produces no uncommitted version
  changes.
- `@dbx-tools/projen` exposes the feature to consuming projects through stable
  project options and generated files, with no repository-specific hard-coded
  package names.
- Release duration and GitHub Actions runner minutes are reported before and
  after rollout, with unchanged-language jobs eliminated from the comparison.

## Risks and Mitigations

### Release-tool behavior changes

Release Please workspace plugins are external behavior. Pin versions, generate
their configuration, and keep fixture tests that assert exact release plans
before upgrading.

### Generated-file ownership

Release Please will edit versions that Projen also renders. Make the release
manifest readable by Projen, validate all secondary files against it, and require
post-release synthesis to be clean.

### Partial publication

Several registries can succeed before another fails. Publish in topological
order, make each upload idempotent, record plan state, and support a targeted
manual recovery run.

### Dependency over-release

Workspace tools can conservatively patch dependents. Configure compatible-range
behavior, represent exact artifact families as one unit, and pin expected graph
results in tests.

### Existing global tags

Component tags start new histories. Bootstrap every component from the current
published version and validate that the first independent version is greater
than the corresponding registry version.

### Conventional commit quality

Release Please infers changes from commits. Generate PR-title validation,
document squash-merge expectations, and keep an explicit release-level override
for maintainers.

## Likely Implementation Surface

Future implementation is expected to touch:

- `projen/src/workspace-version.ts` or its replacement release-catalog module;
- `projen/src/project-js.ts`;
- `projen/src/project-py.ts`;
- `projen/src/project-rs.ts`;
- `projen/src/release.ts` and release dispatch helpers;
- `projen/tasks/bump.ts`, `release-pr.ts`, `version-check.ts`, `publish.ts`, and
  `publish-python.ts`;
- UniFFI release packaging tasks;
- Rust binary registry generation and runtime lookup;
- Projen release and consumer fixture tests;
- `projen/README.md` and release operator documentation;
- root `.projenrc.ts` only to declare repository-specific release-unit
  groupings that cannot be inferred.

Do not begin by editing the generated `.github/workflows/release.yml` directly.
The reusable Projen component and its tests must own every generated workflow
change.

## Primary References

- [Projen Release API](https://projen.io/docs/api/release)
- [Release Please manifest releaser](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- [Release Please customization and extra files](https://github.com/googleapis/release-please/blob/main/docs/customizing.md)
- [Release Please Action outputs](https://github.com/googleapis/release-please-action/blob/main/README.md)
- [Changesets configuration](https://github.com/changesets/changesets/blob/main/docs/config-file-options.md)
