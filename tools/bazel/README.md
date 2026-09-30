# Bazel development

This branch explores Bazel-native builds for the existing JavaScript, Rust, and
Python packages. Releases and publication are intentionally out of scope.

## Design

- Package manifests are the authoritative package and dependency declarations.
- Explicit BUILD files make the graph inspectable before a build starts.
- Reusable macros apply package-kind defaults; there is no auto-discovery or synth step.
- Standard language rules compile individual targets and share Bazel's action cache.
- Checked-in barrels and UniFFI source have explicit update and freshness checks.
- Native binding compilation is separate from JavaScript compilation.

## Dependency bootstrap

Bun remains the local command runner. The explicit bootstrap delegates every
ecosystem to its configured package manager so corporate proxies remain
package-manager-owned:

```sh
bun install
bun run deps:lock
bun run bazel --version
bun run bazel build //packages/js/shared/core:pkg
bun run bazel build //packages/js/ui/branding:pkg
bun run bazel build //packages/rs/model:lib
bun run bazel test //packages/py/core:unit_tests
bun run barrels --check
bun run test:tooling
```

`deps:lock` runs pinned pnpm to update rules_js's committed lock, uv to refresh
the hash-pinned Python export and prefetch its wheels, and `cargo fetch --locked`.
Bazel's Python repository invokes `uv pip install` itself, trying the uv cache
offline before using uv's configured indexes. crate_universe uses Cargo's normal
home/configuration, and rules_js reads the user's npm configuration. Do not run
pnpm for ordinary development or commit registry URLs.

## Adding a package

Create its native package manifest and a BUILD file, then register a JavaScript
package in the root workspace manifests. Existing package kinds need one macro:

```python
load("//tools/bazel:defs.bzl", "dbx_ui")

dbx_ui()
```

`dbx_node()` and `dbx_shared()` have the same shape; `dbx_app()` includes the
package-root entry point for a browser application. The macros import dependency
edges from rules_js's lockfile translator rather than restating versions in BUILD
files. First-party links resolve to `js_library` source/type providers, while
`:pkg` creates the compiled package artifact. Shared compiler presets replace
repeated compiler-option blocks. Package-specific compiler overrides remain in
the package's small `tsconfig.json`.

Source exports remain suitable for Bun and editors. The Bazel `:pkg` target
contains compiled JavaScript, declarations, assets, and a derived manifest whose
exports point at compiled files. This is a local build artifact, not a release.

Rust uses `dbx_rust_library` / `dbx_rust_binary` over rules_rust, importing locked
third-party dependencies from Cargo. Only local crate edges need explicit labels.
`lib`, `native`, `bindgen`, and `bindings` are separate targets. Development Rust
binaries report `0.0.0-bazel`; release version stamping is deliberately absent.

Python package BUILD files declare only local package edges. `uv_repository`
installs the external set exported from the package manifests into one Bazel
repository, and `dbx_python` supplies that repository to libraries and tests.
The package manifests remain the dependency source of truth.

## Generated source

`bun run barrels` updates package-root barrels from the packages already registered
in the workspace. `--check` never writes. The existing namespace, collision,
handwritten-override, and UniFFI direct-export semantics are preserved.

```sh
bun run bindings core
bun run bindings google
bun run bindings model
bun run bindings core --check
```

The `:bindings` action builds the native library and pinned UBRN tool with Bazel.
The npm UBRN launcher is not used: it would run Cargo outside Bazel's build graph.
Generation happens in Bazel's output tree. Only the explicit update command copies
source back into the existing read-only `src` files and installs ignored native
libraries for local use. Checks compare bytes, not timestamps.

UBRN requires Cargo metadata even when the native library is already built. The
adapter supplies a temporary metadata-only workspace using the declared crate
names and UniFFI configs, with no Rust implementation or external dependencies.
It invokes Bazel's pinned Cargo/Rust toolchain offline. Binding types still come
exclusively from the native library; there are no handwritten type mirrors.

## Locks and network configuration

- `pnpm-lock.yaml` is rules_js's committed JavaScript dependency graph.
- `Cargo.lock` supplies workspace Rust versions.
- `MODULE.bazel.lock` pins Bazel module resolution.
- `tools/bazel/requirements.txt` is the hash-pinned Python dependency export.

Update all three dependency inputs with `bun run deps:lock`. Bun, pnpm, uv, and
Cargo remain available for interactive development; Bazel does not read ambient
JavaScript or Python installations.

Corporate registry and credential configuration stays in package-manager user
configuration. rules_js reads the user's npm settings, the Python repository
executes uv, and crate_universe imports Cargo's configured home. An ignored
`.bazelrc.local` may still carry general Bazel downloader rewrites for toolchain
archives, but package registry URLs and credentials do not belong in source.

## Scope

This is an experimental development branch, not a release-ready migration. It
removes the generator package, synthesis tasks, self-bootstrapping CLI, and release
workflows. Databricks runtime packages retain their public source APIs.

There is intentionally no remote cache endpoint configured. Bazel's local action
cache already applies; a trusted remote service can be added without changing
targets. Builds do not write generated source back to the checkout.

## References

- Bazel BUILD style: https://bazel.build/build/style-guide
- Macros: https://bazel.build/extending/macros
- Hermeticity: https://bazel.build/basics/hermeticity
- rules_rust Cargo integration: https://bazelbuild.github.io/rules_rust/crate_universe_bzlmod.html
- rules_js: https://github.com/aspect-build/rules_js
- rules_ts: https://github.com/aspect-build/rules_ts
- rules_python: https://rules-python.readthedocs.io/
