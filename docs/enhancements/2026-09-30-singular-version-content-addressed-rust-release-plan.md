# Singular version and content-addressed Rust release plan

Date: 2026-09-30

Updated: 2026-10-01

Status: Implemented for the singular-version workflow, structured Rust version
slot, exact-key raw bundle reuse, Cargo timing artifacts, and first-pass docs
parallelism/caching. Persistent TypeDoc workers, per-package generated-output
caching, linker experiments, and workspace-crate cache benchmarking remain
optional measured follow-ups.

## Objective

Make the release system materially smaller while preserving these outcomes:

- source reaches `main` through a pull request, never a direct push;
- every public Node, Python, Cargo, native, and GitHub artifact has one shared
  repository version;
- unchanged Rust code does not consume a native build matrix on GitHub;
- reused native artifacts are selected by a version-independent build hash and
  have their visible release version updated through a dedicated binary section,
  never by unstructured byte replacement;
- a cache miss or validation failure falls back to a normal build rather than
  weakening release correctness;
- documentation generation reuses unchanged work and overlaps independent
  language phases on the existing runner;
- optimization does not require larger paid runners, persistent hosted build
  services, or new infrastructure with recurring cost.

The primary success measure is reduced release state and control flow, not the
maximum possible number of skipped jobs.

## Executive decision

Return this repository to the existing fixed-version release model and retain
the useful package and artifact discovery pieces without retaining independent
versions.

The target release has:

- one authoritative root `VERSION` file;
- one release branch and one pull request into `main`;
- one tag, `v<version>`;
- one GitHub Release and one repository release note;
- one generated version across all package manifests and runtime registries;
- one publication run that publishes all public packages at that version;
- one version-independent Rust source fingerprint plus target-specific build
  keys;
- automatic reuse of raw native bundles from a previous successful GitHub
  Release when a build key matches;
- one small private Rust release-tool crate for fingerprinting, inspection, and
  stamping.

Do not keep Release Please component state, per-component tags, propagated
version bumps, component recovery, or manual prior-run artifact selection.

## Why the current design is too complex

The current tree has 47 release units, multiple simultaneous versions, a
generated release graph, per-unit source hashes, per-unit changelogs and version
files, dependency-propagated version changes, component-qualified tags, and an
affected-unit publication plan. A normal release can also involve a source pull
request, a generated release pull request, explicit publication dispatch, and
post-publication branch synchronization.

That design optimizes for publishing only the changed components. In this
repository it has produced more control-plane work than product value:

- every package boundary also became a versioning boundary;
- release recovery needs component and version inputs;
- generated release metadata changes are carefully excluded from the next
  release calculation;
- native compilation reuse is tied to workflow runs rather than the actual Rust
  build inputs;
- the workflow must translate an affected graph into separate Rust, Python,
  Node, GitHub, and documentation stages;
- fixes to PR creation, generated-PR reconciliation, mergeability, workflow
  dispatch, and branch synchronization have become release-system work of their
  own.

The fixed-version implementation already present in the Projen engine is a
better base. The repository should simplify back to that path, then add only the
one optimization that has a material cost benefit: avoiding unchanged native
Rust builds.

## Measured baseline

The plan uses actual release timings as its baseline rather than generic CI
benchmarks.

Release `0.6.229` used six parallel Rust target jobs. Together they consumed
approximately 14.8 runner-minutes and completed in 3.8 minutes of wall time.
Representative workspace compilation phases were approximately:

- Linux x64: 44 seconds;
- Windows x64: 89 seconds;
- macOS x64: 117 seconds.

Cache restoration on those rows took approximately 9, 21, and 31 seconds. The
pipeline already builds selected Rust packages once per target, packages UniFFI
outputs with `--skip-build`, runs target rows in parallel, disables Cargo
incremental compilation, restores dependency artifacts through
`Swatinem/rust-cache`, and uses `rust-lld` on Windows. The remaining high-value
Rust optimization is therefore to skip unchanged target builds entirely.

The measured API documentation step took approximately 230 seconds:

- TypeDoc: approximately 142 seconds;
- Python API generation: under one second;
- Rustdoc: approximately 88 seconds.

The TypeScript, Python, and Rust phases currently run serially even though they
write to disjoint package directories. Rustdoc also deletes its complete target
directory before every run. These are the documentation path's first targets.

All later timing claims must be compared against these baselines on the existing
GitHub-hosted runner class. Do not justify a change only with a third-party
benchmark.

## Target release flow

### 1. Prepare locally

Run one local command, initially the existing fixed-mode `release` task:

```text
bun run release --patch
```

The command:

1. verifies the current integration branch and pushes pending source commits;
2. resolves the next singular semantic version;
3. creates `release/v<version>` from the integration branch;
4. writes `VERSION` and regenerates every owned version surface;
5. invokes the private Rust release tool to write the normalized Rust build
   manifest;
6. runs focused version, synthesis, and release validation;
7. commits the release preparation;
8. pushes the release branch and opens one pull request to `main`.

The pull request contains both the source delta and the release preparation.
There is no second generated release pull request. Repository merge policy may
require checks or review, but the release architecture does not depend on a bot
merging one PR in order to create another.

### 2. Merge through the normal PR boundary

Merging `release/v<version>` is the only operation that moves release source to
`main`. The merge commit changes `VERSION`, which triggers the release workflow.
The workflow verifies that:

- the checkout is exactly the merged `main` commit;
- `VERSION` is valid and greater than the latest `v*` tag;
- all generated Node, Python, Cargo, binding, and registry versions match
  `VERSION`;
- the committed Rust build manifest is reproducible from the merged source.

### 3. Reuse or build native artifacts

For each configured Rust target, the workflow computes the target build key from
the committed manifest and target configuration.

- If a previous successful GitHub Release contains a raw native bundle with the
  exact key, download and verify it.
- If no verified bundle exists, build the complete Rust workspace once for that
  target and create the raw bundle.
- Treat a target row as one unit: either reuse its complete bundle or rebuild
  that target. Do not add per-crate partial reuse in the first implementation.

Reused and newly built raw bundles then follow the same stamping and packaging
path.

### 4. Stamp, package, and publish

The Rust release tool updates the dedicated version section in each executable
or native library to the new repository version. Packaging then creates:

- release binary archives;
- native npm archives;
- Python wheels;
- any generated native facades.

Stamping happens before archive creation, checksums, code signing, or
notarization. Cargo source packages, handwritten npm packages, and handwritten
Python packages are prepared normally from the current release source.

All public packages are published at the singular version. Publishing all
packages is intentional: it removes changed-component planning, makes the
repository version truthful, and keeps exact cross-language dependency versions
coherent. Registry publication remains idempotent so a rerun skips an already
matching version and rejects conflicting content.

### 5. Complete one release

After publication succeeds, create or finalize:

- tag `v<version>`;
- one GitHub Release;
- one release summary under `docs/releases/v<version>.md`;
- documentation deployment;
- optional synchronization of the integration branch from released `main`.

Branch synchronization may retain the existing safe fast-forward/merge behavior
while `dev` remains the integration branch. It must not create another release
or bypass a pull request into `main`.

## Singular version model

`VERSION` is the only writable version source. Projen projects read it and
generate the same value into:

- root and package `package.json` files;
- generated `PACKAGE_VERSION` exports;
- Python `pyproject.toml` files;
- Rust `Cargo.toml` package versions and internal dependency requirements;
- generated native package metadata;
- Rust binary download registries;
- documentation and release metadata.

The package/artifact catalog remains useful for discovery, publication order,
target matrices, and private/public policy. It should stop owning release units,
component versions, propagation rules, or affected-unit selection.

The simplest model is:

```text
repository version + package inventory + publication dependency order
```

not:

```text
repository graph + release units + component versions + propagation + affected plan
```

The migration should therefore refactor the existing catalog rather than delete
automatic package discovery and replace it with handwritten package lists.

## Rust build fingerprint

### Ownership

Add one private, non-published workspace crate, tentatively
`packages/rs/release-tools`. It owns two commands:

```text
dbx-release-tools fingerprint
dbx-release-tools stamp
```

Keeping both operations in one crate gives the fingerprint schema, version-slot
schema, binary parser, and validation rules one source of truth.

### Base fingerprint

`fingerprint` produces one repository-wide `rustSourceHash` using SHA-256 over a
canonical representation of behavior-affecting Rust build inputs:

- tracked Rust source, build scripts, embedded assets, and generated Rust source;
- normalized root and crate Cargo manifests;
- the resolved external dependency graph and features;
- the Rust release profile and relevant linker/build flags;
- the release Rust toolchain identifier;
- the fingerprint schema and native version-slot schema.

The canonical representation must remove version-only inputs:

- root `VERSION`;
- workspace package versions;
- version requirements for workspace path dependencies;
- generated release notes and release metadata;
- package-manager metadata that changes only because the singular version moved.

Do not hash raw `Cargo.toml` or `Cargo.lock` files and then attempt to maintain a
growing ignore list. Parse the manifests and Cargo metadata, normalize workspace
package identities, and hash the normalized data. External dependency versions,
sources, checksums, features, and target conditions remain significant.

### Target build keys

Derive one key per release target:

```text
SHA-256(
  schemaVersion,
  rustSourceHash,
  targetTriple,
  operatingSystem,
  architecture,
  libc,
  releaseProfile,
  cargoFeatureSet,
  rustToolchain,
  linkerIdentity,
  packagingInputSchema
)
```

The local release command writes a small committed file such as
`.release/rust-build.json`:

```json
{
  "schemaVersion": 1,
  "versionSlotSchema": 1,
  "rustSourceHash": "<sha256>",
  "targets": {
    "x86_64-unknown-linux-gnu": "<sha256>",
    "aarch64-apple-darwin": "<sha256>",
    "x86_64-pc-windows-msvc": "<sha256>"
  }
}
```

The release workflow recalculates and compares this file before trusting it.
This still satisfies the local-first release design while preventing a modified
or stale manifest from selecting an unrelated artifact.

Changing only `VERSION` must leave every target build key unchanged. Changing
Rust source, an external Rust dependency, features, release profile, toolchain,
linker identity, or version-slot ABI must change the appropriate key.

## Structured binary version slot

### Decision

Use the `object` crate to parse ELF, Mach-O, and PE files and locate a dedicated,
fixed-capacity version section. Do not use `sed`, an unrestricted byte search,
or a general string-table replacement.

`object` is preferred over `goblin` because the same section and file-range API
can cover the supported object formats. The stamp command may patch the exact
file range returned by `object`; it does not need a general-purpose executable
rewriter. Retain `goblin` only as a documented fallback if a required format
cannot expose the section range correctly through `object`.

### Slot layout

Add a small internal build-info module used by every release executable and
native library. It embeds one fixed-size record in a dedicated section:

```text
magic:       12 bytes  "DBXVERSION\0\0"
schema:       2 bytes
length:       2 bytes
version:     64 bytes, UTF-8 plus zero padding
reserved:    48 bytes
```

The exact Rust representation must have a compile-time fixed size and be marked
`#[used]`. Platform-specific `link_section` attributes place it in a uniquely
named section that respects each format's naming limits. The application reads
the length-delimited version payload from this record. It must not use
`env!("CARGO_PKG_VERSION")` or Clap's implicit `#[command(version)]` as a
runtime version source.

Both Rust binaries currently using Clap's implicit version flag must be changed
to set the command version from the shared build-info accessor. Native libraries
that expose a version should use the same accessor.

### Stamp algorithm

For every candidate executable or native library, `stamp` must:

1. parse the file with `object`;
2. require the expected executable format and target architecture;
3. locate exactly one version section;
4. require the expected fixed record size, magic, and schema;
5. require a valid existing payload;
6. reject a version longer than the fixed capacity;
7. overwrite only the version payload, length, and zero padding at the section's
   exact file offset;
8. reparse the file and verify the new version through the same reader used by
   the application;
9. write the final SHA-256 and provenance record.

The operation preserves file length and all unrelated offsets. Any failed
precondition is a cache miss or release failure, never permission to search the
binary for another string.

Patching invalidates platform signatures. Therefore stamping must occur before
any future Authenticode signing, Apple code signing/notarization, or release
checksum generation.

## Previous-release artifact reuse

### Raw bundle format

A newly built target produces one raw bundle before version-specific packaging:

```text
rust-build-v1-<target>-<build-key-prefix>.tar.zst
```

It contains:

- release executables;
- UniFFI native libraries and binding inputs required by npm and wheel packaging;
- a manifest with full build key, source hash, target, toolchain, features,
  member files, and SHA-256 values;
- no credentials, workspace paths, or mutable release metadata.

Attach a raw bundle only to a successful GitHub Release. Pull-request artifacts,
failed workflow artifacts, and arbitrary workflow run IDs are never reuse
sources.

### Lookup algorithm

For each target, the workflow:

1. lists recent repository releases from newest to oldest;
2. reads their Rust build manifest assets;
3. finds an exact full build-key match;
4. downloads the named raw bundle;
5. verifies its SHA-256, manifest schema, target, architecture, toolchain, and
   member checksums;
6. records the source release tag and asset identity;
7. passes the raw bundle to the normal stamp/package jobs.

If lookup, download, or verification fails, build that target normally. Do not
fall back to a partial match, hash prefix, branch cache, or package version.

The first implementation should scan a bounded number of recent releases and
rebuild on a miss. Do not add a mutable global cache index, service, database,
or dedicated cache branch. A later optimization may add an Actions cache keyed
by the same build key, but GitHub Release assets remain the durable and auditable
reuse source.

### Provenance

The final GitHub Release records, per target:

- target build key;
- whether the target was built or reused;
- source release and raw asset when reused;
- raw bundle SHA-256;
- stamped artifact SHA-256 values;
- release version applied by the stamp tool.

Reused code is acceptable only because the build key proves the behavior-
affecting Rust inputs match and the visible version is isolated in the validated
section. Cargo source releases are still published from the current source and
are not replaced by prior compiled artifacts.

## Existing-runner Rust build improvements

Content-addressed target reuse remains the primary optimization. Apply the
following techniques only when they preserve the one-version architecture and
do not require larger instances or paid infrastructure.

### Keep the current dependency cache

Retain the tracked root `Cargo.lock`, `--locked`, main-branch cache writes, and
the generated cache configuration:

```yaml
cache-targets: true
cache-workspace-crates: false
add-rust-environment-hash-key: true
```

This cache is for registry and dependency artifacts. It is not the durable
contract for reusing final workspace outputs.

### Benchmark workspace-crate caching once

Run a controlled comparison with `cache-workspace-crates: true` on the same
source, runner class, toolchain, and target matrix. Measure cache restore time,
workspace build time, uploaded cache size, and aggregate runner-minutes.

Keep it only if repeated releases show a net reduction. Cargo may invalidate
restored workspace fingerprints after checkout or generated manifest changes,
and larger target caches may cost more time to transfer than they save. Never
depend on this option for version-only release reuse.

### Add Cargo timing artifacts

Capture `cargo build --timings` output for release target rows and upload it as a
short-retention workflow artifact. Use it to identify whether compilation,
monomorphization, a build script, or linking dominates before changing profiles
or linkers.

Timing output is diagnostic only and must not become another release input or
committed generated tree.

### Pilot `mold` on Linux

Benchmark the open-source `mold` linker on the existing Linux runners. Compare
workspace build time, binary behavior, size, symbols, packaging, and smoke tests
against the current linker. Adopt it only if the repository's own target rows
show a material improvement.

Windows keeps `rust-lld`. Do not change the macOS linker without a separate
compatibility and signing analysis.

### Benchmark release-profile changes carefully

The current effective release profile is already compilation-friendly: Cargo
incremental compilation is disabled in CI, full LTO is not enabled, release
debug information is not requested, and Cargo uses multiple codegen units.

Permitted experiments include increasing `codegen-units` while keeping
`lto = false` and `debug = 0`. Every experiment must compare proxy throughput,
latency, binary size, and native package smoke tests, not build time alone. Do
not trade material runtime performance for a small release improvement.

### Audit dependencies and features

Periodically use Cargo timings and metadata to identify expensive unused
dependencies, unnecessary default features, avoidable proc macros, and crates
that can be split without duplicating contracts. Treat this as product
architecture work, not as a release-workflow workaround.

### Evaluate target reduction using evidence

Windows ARM64, macOS x64, and Linux ARM64 are candidates for usage review, not
automatic removal. Collect GitHub asset downloads and native package download
telemetry before proposing a support change. Removing an unused target is the
only zero-infrastructure optimization comparable to artifact reuse because it
eliminates compilation, packaging, upload, cache, and maintenance permanently.

### Optional architecture consolidation

One existing runner may build both architectures for its operating system when
the native SDK and linker support it. This can share checkout, setup, and some
host-side artifacts, but target-specific dependencies still compile separately
and wall time may increase.

Treat this as a later benchmark. Do not introduce cross-platform release builds
for Node native modules, Python wheels, Windows MSVC artifacts, or macOS
signing-sensitive outputs merely to reduce the number of jobs.

### Explicitly excluded techniques

The following are outside this plan unless the repository already has free,
maintained infrastructure that changes their cost or complexity:

- larger paid GitHub runners or paid managed-runner services;
- persistent self-hosted runners maintained only for release caching;
- a new remote `sccache` service or paid object-storage backend;
- `cargo-chef` outside a Docker-layer build;
- cross-compiling all release artifacts from one operating system;
- nightly or Cranelift release builds;
- Bazel, Buck2, Nix, or remote-execution migration solely for release speed;
- `cargo-nextest` as a release compilation optimization.

`cargo-nextest` may be evaluated separately for test scheduling. It does not
replace the release-native build or artifact-reuse design.

## Documentation generation improvements

Documentation optimization must stay on the current runner class and preserve
the generated README/API ownership model.

### Run independent language phases concurrently

Refactor `generate-api-docs.mjs` so TypeScript, Python, and Rust generation start
together and the API index is written after all three resolve. Their generated
package directories are disjoint.

Use explicit resource limits rather than allowing every tool to consume every
core. The initial configuration should retain two TypeDoc workers and run
Rustdoc with a bounded Cargo job count. Benchmark CPU contention and memory on
the existing GitHub runner.

With the measured inputs, phase overlap changes the uncached theoretical wall
time from approximately 230 seconds toward the slower of TypeDoc and Rustdoc,
before accounting for contention.

### Preserve and cache Rustdoc build state

Stop deleting `.docs-build/rustdoc-target` in full. Delete or replace only its
published `doc` output while preserving Cargo fingerprints and compiled
documentation dependencies.

Add a workflow cache for the Rustdoc target directory keyed by:

- Rust toolchain identity;
- normalized Cargo dependency inputs;
- relevant features and Rustdoc flags;
- documentation generator schema.

Restore a prior compatible prefix when the exact key misses, then let Cargo
validate the restored state. Package versions alone must not prevent reuse.
Continue deleting `.docs-build/site/public/rustdoc` before copying the newly
generated public tree so removed crates cannot leave stale pages.

### Skip duplicate TypeDoc error checking

Add TypeDoc's `--skipErrorChecking` option after confirming the normal build
workflow remains the authoritative TypeScript validation gate. The release docs
job may skip duplicate semantic diagnostics, but it must not become the only
place type errors are detected.

Benchmark the option and retain it only when generated content and link checks
remain identical.

### Make TypeDoc concurrency configurable

Replace the hard-coded worker count with a bounded
`DOCS_TYPEDOC_WORKERS` setting whose default derives from available parallelism
and is capped conservatively. Benchmark two, three, and four workers on the
existing runner class and choose the best time without memory pressure.

Do not increase runner size to support additional TypeDoc workers.

### Reuse persistent TypeDoc workers if needed

If process startup remains material, add a small persistent worker pool using
TypeDoc's programmatic application API. Each worker imports TypeDoc and the
Markdown plugin once, then processes several package-isolated configurations in
sequence.

Preserve the current output directories and post-processing. Do not adopt
TypeDoc package mode if it forces a merged output structure or duplicates the
existing link, slug, namespace, and frontmatter transforms.

### Add per-package generated-output caching last

If the preceding changes are insufficient, cache each package's generated API
directory by a hash of:

- exported entry points and relevant source files;
- package TypeScript configuration;
- TypeDoc and Markdown plugin versions;
- documentation generator schema.

Restore the previous generated API tree, regenerate changed package hashes, and
save the resulting tree under a new immutable cache key. Exclude package-version
changes when they do not affect generated API content.

This is the largest warm-run optimization and the most complicated docs change,
so implement it only after phase overlap, Rustdoc caching, duplicate-check
removal, and worker tuning are measured.

### Documentation optimization order

1. Run TypeScript, Python, and Rustdoc concurrently.
2. Preserve and cache the Rustdoc target directory.
3. Add `--skipErrorChecking` with the normal compile gate retained.
4. Benchmark two, three, and four TypeDoc workers.
5. Add persistent TypeDoc workers only if startup remains material.
6. Add per-package output caching only if releases remain too slow.

## Publication behavior

The singular release publishes every public package at `VERSION`.

Retain dependency ordering where registries require it, but express it as a
package publication graph rather than release-unit propagation. For example,
Cargo dependencies publish before their dependents, native npm packages publish
before Node facades that reference them, and native wheels publish before Python
facades that require them.

Private packages and unsupported platform rows remain excluded by their existing
package policy. A package's unchanged source is not a reason to give it a stale
version or omit the repository version from its registry.

Recovery is a rerun of the same tag/commit. Registry drivers compare existing
content, skip exact matches, and reject conflicts. Remove component/version
recovery and the manual `source_run_id` mechanism after automatic build-key reuse
is proven.

## Migration plan

### Phase 0: Lock the contracts

- Add tests that describe one-version synthesis using the existing fixed mode.
- Capture the current package inventory, publication ordering, Rust target
  matrix, native archive names, and private-package exclusions.
- Add a release fixture proving one release PR changes `VERSION` and all package
  versions together.
- Record workflow duration and Rust matrix cost for comparison.
- Record TypeDoc, Python API, Rustdoc, complete API-generation, documentation
  build, and link-check durations separately.

Exit criteria:

- package discovery and target coverage can be compared before and after the
  release-unit removal;
- fixed mode has current tests rather than relying on older compatibility tests.
- documentation timing has explicit language-phase boundaries.

### Phase 1: Restore one version and one PR

- Set the repository to `versioningMode: "fixed"`.
- Restore `VERSION` as the authoritative generated version input.
- Use the existing local `release-pr.ts` path as the only release preparation
  command.
- Generate one root release note and one `v<version>` tag.
- Publish all public packages at the same version.
- Keep safe `dev` synchronization only if `dev` remains the integration branch.
- Remove Release Please from the repository release path.
- Remove `.release-please-manifest.json`, `release-please-config.json`,
  `.release-units/**`, component changelogs, component tags, component recovery,
  and affected-unit planning.

Exit criteria:

- one release PR into `main` is sufficient to publish a dry run;
- every generated package version equals `VERSION`;
- no generated release-unit files change during synthesis;
- one dry-run release produces one tag name and one release-note path.

### Phase 2: Add Rust fingerprinting

- Add the private Rust release-tool crate.
- Implement normalized Cargo/source fingerprinting and target build keys.
- Invoke it from local release preparation and commit
  `.release/rust-build.json`.
- Recalculate and verify the manifest in release CI.
- Add fixtures proving version-only changes preserve keys and behavior changes
  invalidate them.

Exit criteria:

- two checkouts differing only in singular version produce identical target
  keys;
- source, dependency, feature, toolchain, and profile changes produce misses;
- a forged or stale manifest fails validation.

### Phase 3: Add the structured version section

- Add the shared build-info record and platform-specific sections.
- Replace implicit Cargo/Clap runtime version sources.
- Implement `object`-based inspection and stamping.
- Test ELF, Mach-O, and PE fixtures in the existing release platform matrix.
- Verify `--version` and any native version API after stamping.

Exit criteria:

- stamping changes only the dedicated fixed-size section;
- every supported native artifact reports the requested version;
- missing, duplicate, malformed, oversized, wrong-target, or wrong-schema slots
  fail closed;
- packaging, checksums, and any signing happen after stamping.

### Phase 4: Reuse previous release bundles

- Upload a raw target bundle and build manifest on a real build.
- Add exact-key release lookup and verification.
- Route reused and built bundles through one stamping/packaging implementation.
- Record reuse provenance in the release summary.
- Remove manual prior-run selection after two successful reuse releases.

Exit criteria:

- a version-only release performs no native Rust matrix compilation when all
  target bundles are available;
- changing one Rust build input rebuilds affected target rows;
- a corrupted or incomplete prior asset rebuilds safely;
- final public artifacts contain the new version and pass smoke tests.

### Phase 5: Optimize documentation generation

- Run TypeScript, Python, and Rust API generation concurrently with bounded
  resource use.
- Preserve and cache the Rustdoc target state.
- Benchmark TypeDoc duplicate-check removal and configurable worker counts.
- Add persistent workers or per-package output caching only if the simpler
  changes do not meet the measured goal.
- Upload phase timings so later regressions identify the responsible language.

Exit criteria:

- documentation uses no larger or paid runner class;
- an unchanged Rust documentation input reuses compatible Rustdoc state;
- normal TypeScript compilation remains the authoritative type-error gate;
- generated titles, internal links, package counts, and public Rustdoc routes are
  unchanged;
- API generation improves materially against the 230-second baseline without
  increasing recurring infrastructure cost.

### Phase 6: Delete compatibility machinery

- Remove independent-version options and code after this repository and any
  known consumers use fixed mode.
- Collapse release-plan types to a singular release descriptor or delete the
  plan artifact if workflow outputs are sufficient.
- Remove component release summaries, propagation tests, generated source
  snapshots, and workflow conditions that can no longer occur.
- Update `AGENTS.md` and `projen/README.md` to describe only the final model.
- Archive this plan with final before/after workflow and maintenance metrics.

Exit criteria:

- the release implementation has no component version or release-unit concept;
- the generated workflow has one version path and one recovery path;
- deleted machinery exceeds the new fingerprint/stamp implementation in both
  conceptual surface and maintained workflow branches.

## Expected file-level impact

| Area                                                             | Direction                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `.projenrc.ts`                                                   | Switch to fixed mode; remove repository release-unit declarations; retain package/artifact discovery.              |
| `VERSION`                                                        | Restore as the sole writable release version.                                                                      |
| `.release-units/**`                                              | Delete after migration.                                                                                            |
| `.projen/release-units.json`                                     | Delete or replace with a version-neutral package/artifact inventory only if another task still needs it.           |
| `release-please-config.json` and `.release-please-manifest.json` | Delete from this repository release path.                                                                          |
| `projen/src/release-catalog.ts`                                  | Remove version ownership and propagation; retain discovery, publication ordering, and target metadata.             |
| `projen/src/release-plan.ts` and `projen/tasks/release-plan.ts`  | Collapse to one release descriptor or remove.                                                                      |
| `projen/src/release.ts`                                          | Generate the fixed one-PR workflow and automatic Rust bundle reuse.                                                |
| `projen/tasks/release-pr.ts`                                     | Become the primary local release entry point and invoke Rust fingerprinting.                                       |
| `projen/tasks/bump.ts`                                           | Remain a local version/synthesis primitive used by release preparation.                                            |
| `packages/rs/release-tools`                                      | New private fingerprint, inspect, stamp, and provenance tool.                                                      |
| Rust binaries and native crates                                  | Read the dedicated build-info version section instead of implicit Cargo package version strings.                   |
| `.github/workflows/release.yml`                                  | One singular release path; target rows reuse or build raw Rust bundles.                                            |
| `docs/scripts/generate-api-docs.mjs`                             | Concurrent language phases, bounded TypeDoc workers, preserved Rustdoc state, and optional incremental generation. |
| `.docs-build/rustdoc-target`                                     | Ignored local output and restorable CI cache; never committed.                                                     |
| `docs/releases`                                                  | One file per repository version.                                                                                   |

## Complexity budget

The implementation must follow these limits:

- at most one new private Rust crate;
- no new service, database, cache branch, or mutable global artifact index;
- no per-crate native reuse decisions inside a target row;
- no binary string search or variable-length executable rewrite;
- no second release PR;
- no per-package semantic version decisions;
- no manual workflow-run ID for normal recovery;
- no duplicated fingerprint contract in TypeScript, shell, or workflow YAML.
- no larger paid runner requirement or new recurring infrastructure cost;
- no documentation cache whose correctness depends on package version alone.

The Rust tool owns fingerprint and stamp schemas. Projen owns orchestration. The
generated workflow passes values between them but does not reimplement either
algorithm.

## Risks and mitigations

### Hidden version-dependent Rust behavior

Risk: source may still use `CARGO_PKG_VERSION`, Clap's implicit version support,
or generated version constants outside the dedicated slot.

Mitigation: add a repository check that rejects those patterns in release Rust
targets, and smoke-test every executable/native version surface after stamping.

### Incorrect build-key normalization

Risk: removing too much from the fingerprint could reuse behaviorally different
code; removing too little would rebuild on every version change.

Mitigation: normalize parsed Cargo structures rather than lines, keep external
dependency and toolchain inputs, version the fingerprint schema, and maintain
positive and negative fixtures.

### Binary format differences

Risk: section names, alignment, stripping, and signing differ across ELF,
Mach-O, and PE.

Mitigation: use format-aware `object` parsing, one platform fixture per release
target family, fixed-size in-place writes, and stamp before signing.

### Reusing compromised or incomplete artifacts

Risk: a matching filename or hash prefix could select the wrong asset.

Mitigation: trust only successful repository GitHub Releases, match full keys,
verify target metadata and every member checksum, and rebuild on any ambiguity.

### Publishing every package increases registry operations

Risk: singular releases publish more unchanged source packages.

Mitigation: publication is substantially cheaper than the native build matrix,
drivers are idempotent, and the simpler version contract is worth the bounded
registry work. Revisit only with measured evidence.

### Documentation concurrency causes resource contention

Risk: TypeDoc and Rustdoc can oversubscribe the existing runner, increasing wall
time or memory pressure instead of reducing it.

Mitigation: bound both worker pools, expose TypeDoc concurrency as a workflow
setting, record phase timings, and retain the measured fastest configuration on
the current runner class.

### Generated documentation cache becomes stale

Risk: an incomplete hash could restore API pages that no longer match source or
tool behavior.

Mitigation: version the cache schema, include source/config/tool inputs, always
rerun title and link validation, and fall back to regeneration on any missing or
ambiguous metadata.

## Final acceptance criteria

The enhancement is complete when:

1. every publishable artifact in one release reports the same version;
2. source reaches `main` through exactly one reviewed release pull request;
3. one merged `VERSION` change triggers one release workflow, tag, GitHub
   Release, release note, and docs deployment;
4. `.release-units`, component manifests, component tags, propagation logic,
   and affected-unit release planning are absent;
5. a docs-only or JavaScript-only version release reuses all matching Rust
   target bundles and performs no native Rust compilation;
6. a Rust behavior change invalidates the relevant keys and builds normally;
7. stamping uses a dedicated validated section located through `object` and
   never searches arbitrary binary bytes;
8. reused and rebuilt artifacts pass the same package, version, checksum, and
   smoke-test path;
9. release reruns are idempotent without component or prior-run inputs;
10. API documentation generation overlaps independent language phases, reuses
    compatible Rustdoc state, and materially improves against the 230-second
    baseline on the existing runner class;
11. Cargo timing artifacts support measured linker, profile, dependency, and
    target decisions without becoming release inputs;
12. the implementation requires no larger paid runner or new recurring build
    infrastructure;
13. the final release implementation and documentation are demonstrably smaller
    than the independent release-unit system they replace.
