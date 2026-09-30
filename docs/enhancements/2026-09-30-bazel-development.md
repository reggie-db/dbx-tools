# Bazel-native development experiment

Status: implementation and validation in progress on `dev-bazel`.

## Decisions

- Work exclusively in the sibling `dbx-tools-bazel` worktree.
- Remove Projen rather than invoking its tasks inside Bazel actions.
- Prefer explicit BUILD files and reusable package-kind macros to discovery.
- Keep native manifests and import third-party dependency graphs from locks.
- Preserve existing barrel and UniFFI public APIs and checked-in generated source.
- Separate cacheable generation from explicit checkout updates.
- Disable publication and leave release design for a separate effort.

## Implemented

- Bzlmod with pinned Rust, Node, TypeScript, and Python tooling.
- Explicit JavaScript, Rust, and Python package targets.
- Shared Node/shared/UI compiler presets and package macros.
- Standalone barrel generation with a read-only freshness check and regression tests.
- Native Rust compilation and a Bazel-owned UniFFI generation action.
- CLI development forwarding without engine bootstrap or synthesis.
- Local-only corporate mirror configuration.

## Validation

Record confirmed builds and unresolved boundaries here before handing off the
experiment. Do not change unrelated runtime code to mask migration failures.

## References

See `tools/bazel/README.md` for the upstream guides and command reference.
