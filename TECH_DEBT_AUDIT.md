# Repository debt audit

Reviewed September 4, 2026. Scope: whole-repository structural and documentation
scan, with detailed implementation review of both Rust auth crates and their
generated Node/Python consumers. This is not a complete security assessment or
a claim that every source file was reviewed.

## Executive summary

- RESOLVED: shared lifecycle options now have one Rust-owned record, imported by
  both generated providers instead of copying fields and duration conversions.
- RESOLVED: Databricks wrappers inherit lifecycle forwarding through
  `AuthSession`; renewal and login-policy dispatch have shared implementations.
- RESOLVED: both custom-storage factories accept the same owning-library handle.
- RESOLVED: large signed refresh windows no longer overflow date arithmetic.
- RESOLVED: `ProfileOptions` debug output no longer discloses the M2M secret.
- OPEN: generated Python provider option representations still include secrets;
  fix at generation time, not by hand-editing generated bindings.
- OPEN: custom stores are reported as file storage in Databricks status.
- OPEN: documentation discovery and process-launch policy remain duplicated.
- The API changes are intentional source/ABI breaks, documented in the auth
  READMEs; rebuild both native libraries and regenerate bindings together.

## Architectural mental model

The JavaScript tree separates browser-safe contracts, Node runtimes, UI, and CLI
surfaces. Python packages group capabilities rather than mirroring those runtime
tiers. Projen owns package metadata, generation, and release composition. The
documentation site consumes package READMEs rather than a second authored tree.

Rust shared auth owns OAuth transport, persistent credentials, locking, and
refresh behavior; Databricks auth supplies profile and endpoint policy. UniFFI
is the cross-language contract boundary. Rust/UniFFI records cannot inherit
fields, so shared record composition is the compatible alternative. Rust trait
default bodies are useful for native wrappers but do not become Python or
TypeScript callback-method implementations. Keeping required refresh and lock
operations explicit is a correctness boundary, not missing inheritance.

## Method and scope limits

- Read root/package manifests, README guidance, repository instructions, and
  both Rust crates. Inspected the last 200 commits and six-month change stats.
- Ranked the largest 20 tracked source files and most-changed 20 files. The
  initial tracked source count was about 112,000 lines. Generated manifests
  dominate raw churn; source-only churn highlights `.projenrc.ts`, Rust release
  generation, bump tasks, and LiteLLM provider/catalogue code.
- Scanned JavaScript, Python, Rust, projen, docs, and examples for duplication,
  unsafe type escapes, swallowed errors, and documentation drift. Inspected
  representative matches before recording findings. UI review was structural,
  not a browser/accessibility or interaction audit.
- All 38 public JavaScript package manifests have READMEs. The README site build
  processed 45 package pages successfully; Rust reference generation also ran.
- Agent delegation was attempted, but the session rejected `spawn_agent` as
  unsupported. Reviews therefore ran locally rather than in independent agents.
- Cargo audit/machete/udeps, pip-audit, knip, madge, and depcheck were not installed.
  No global tools were installed, dependency vulnerability audit was not
  performed, and no clean security/dependency bill of health is implied.
- No full JavaScript/Python test-suite or coverage run was performed. Focused
  binding tests do not initiate live OAuth or contact real provider endpoints.

## Findings

Severity reflects the original issue for resolved rows. S/M/L are relative
implementation effort, not elapsed-time commitments.

| ID | Category | File:Line | Severity | Effort | Description | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| R01 | Contract / RESOLVED | `packages/rs/auth/src/client.rs:22` | Medium | Provider bindings duplicated lifecycle fields and duration conversions. | Both now compose the shared `AuthOptions` record through `auth`; regression tests cover both language bindings. |
| R02 | DRY / RESOLVED | `packages/rs/auth/src/client.rs:70` | Medium | Databricks repeated lifecycle forwarding and binding wrappers repeated login-policy selection. | `AuthSession` defaults own forwarding and `token_with_login` owns tri-state dispatch. |
| R03 | DRY / RESOLVED | `packages/rs/auth/src/client.rs:256` | Medium | Normal and rejected-token refresh duplicated write-preflight, acquisition, persistence, and redaction. | Shared `renew` and `can_reuse` paths retain locking in the caller. |
| R04 | Contract / RESOLVED | `packages/rs/auth/src/provider.rs:178` | Medium | Generic and Databricks factories took different custom-storage contracts. | Both accept the shared `StorageHandle`; Node/Python tests pass one handle to both factories. |
| R05 | Correctness / RESOLVED | `packages/rs/auth/src/token.rs:30` | High | Adding an arbitrary binding-supplied signed refresh window to a date could panic. | Compare expiry minus current time with the duration; test both signed 64-bit extremes. |
| R06 | Security / RESOLVED | `packages/rs/databricks-auth/src/profile.rs:233` | High | Derived `Debug` printed `ProfileOptions.client_secret` despite its redaction documentation. | Custom redacted debug output and a regression test now protect the options record. |
| A01 | Security / OPEN | `projen/tasks/uniffi.ts:93` | High | Python generation preserves UniFFI's record `__str__`, which interpolates `ProviderOptions.client_secret`. This is a logging exposure risk, not evidence of existing exfiltration. | Add generator-owned sensitive-field redaction driven by the Rust contract, with generated-output tests; never hand-edit bindings. Avoid logging provider option objects meanwhile. |
| A02 | Contract / OPEN | `packages/rs/databricks-auth/src/lib.rs:227` | Medium | `storage_from_name` maps all unknown names to `Storage.File`; foreign stores report `custom` at `packages/rs/auth/src/bindings.rs:131`. | Design a Rust-owned status discriminator separate from selectable built-in storage backends, and test custom-store status. |
| A03 | DRY / OPEN | `docs/scripts/sync-readmes.mjs:100`; `docs/scripts/generate-api-docs.mjs:82` | Medium | Both generators repeat package discovery, public filtering, slugging, and traversal. | Share metadata discovery while preserving README-only versus exported-API selection differences. |
| A04 | Error handling / OPEN | `projen/tasks/publish-uniffi-local.ts:20` | Medium | Local publish checks exit status but not `spawnSync.error`, unlike release packaging. Failed process launch can report a null status instead of the underlying cause. | Reuse the error policy in `projen/tasks/uniffi-release.mjs:57`; retain standalone release constraints. |
| A05 | Output policy / OPEN | `projen/tasks/uniffi-release.mjs:59`; `projen/tasks/publish-uniffi-local.ts:24` | Low | Inherited child output bypasses the symbol normalization used in `projen/tasks/uniffi.ts:60`. | Consolidate bounded/streaming normalization policy without buffering unbounded release logs. |
| A06 | Documentation / OPEN | `packages/rs/auth/src/oauth.rs:22`; `packages/rs/auth/src/token.rs:46` | Medium | Public Rust transport/token APIs still lack rustdoc; the new lifecycle and callback boundaries are documented, not every existing API. | Document transport/error/expiry invariants and then establish a missing-docs ratchet by module. |
| A07 | Type hygiene / OPEN | `packages/js/node/path/src/find.ts:49` | Low | The IgnoreLike guard uses `as any` despite already checking for an object. | Narrow with the existing record guard or an indexed unknown record; keep callable-field validation. |
| A08 | Resource hygiene / OPEN | `packages/py/litellm/src/dbx_tools/litellm/backend.py:54` | Medium | Default-profile lookup runs a subprocess without a timeout; a hung CLI can stall startup. | Bound profile enumeration and report a specific timeout error; add a subprocess-failure test. |
| A09 | Lint / OPEN | `packages/py/databricks-auth/test/cli.py:48` | Low | The existing broad exception handler triggers Ruff BLE001; this is a diagnostic CLI, not a swallowed runtime error. | Catch the generated auth error specifically, or document an intentional top-level diagnostic exception policy. |
| R07 | Documentation / RESOLVED | `AGENTS.md:1544`; `AGENTS.md:1737` | Medium | Instructions described a failure-swallowing test command and an obsolete auth UI import. | Instructions now match the separate test condition and actual `@dbx-tools/ui-auth/react` import. |

## Top five remaining fixes

1. **Generated secret redaction (A01):** introduce Rust-owned sensitive-field
   metadata, consume it in binding generation, and assert Python string/repr
   output cannot contain a sentinel secret. Preserve converter fields unchanged.
2. **Accurate storage status (A02):** separate selectable backend configuration
   from resolved backend status; add `custom` only to the status contract and
   regenerate both languages. Do not silently reinterpret custom storage as file.
3. **Shared docs discovery (A03):** extract one package metadata iterator and
   slug function; let each generator filter for its output requirements. Test a
   public package, private package, missing README, and missing API entry point.
4. **Consistent process failures (A04/A05):** centralize launch-error handling
   and output normalization, with standalone release generation retaining its
   no-workspace-install property. Test missing executable and signal termination.
5. **Bound profile enumeration (A08):** provide a finite subprocess timeout,
   preserve CLI stderr for ordinary failures, and distinguish a timeout from
   absent or ambiguous profiles.

## Quick wins

- [x] Share auth lifecycle options and wrapper defaults (R01–R03).
- [x] Align custom-storage handles across providers (R04).
- [x] Remove refresh date overflow and redact Rust option debug output (R05/R06).
- [x] Correct stale test-runner and auth UI instructions (R07).
- [ ] Report `spawnSync.error` in local publishing (A04).
- [ ] Bound default-profile CLI enumeration (A08).
- [ ] Add a module-level Rust missing-docs baseline before expanding enforcement (A06).

## Things that look bad but are actually fine

- Generated `_bindings.ts` files are large and repetitive. They are ABI outputs,
  not handwritten duplication; the Databricks binding imports shared converters
  from `@dbx-tools/auth` (`packages/js/node/databricks-auth/src/_bindings.ts:16`).
- Shared and Databricks OAuth acquisition differ in endpoint/profile policy.
  Forcing browser and machine grants through one default `refresh` method could
  start interactive login during noninteractive calls
  (`packages/rs/auth/src/client.rs:9`). Required provider methods are deliberate.
- Foreign storage callbacks must explicitly implement locking. Rust's default
  no-op preflight does not propagate into generated foreign callback classes;
  pretending otherwise would undermine lease correctness
  (`packages/rs/auth/src/bindings.rs:5`).
- Graphiti's broad process-launch catch stops Neo4j and rethrows; it is resource
  cleanup, not swallowed failure (`packages/py/graphiti/src/dbx_tools/graphiti/runtime.py:138`).
- Graphiti already imports LiteLLM's `require_profile`; a second Python profile
  resolver is not justified (`packages/py/graphiti/src/dbx_tools/graphiti/runtime.py:23`).
- The large chat hook maintains per-turn model/thread routing. File size alone
  does not justify splitting its state ownership; the comments explain the
  concurrent-thread constraints (`packages/js/ui/mastra/src/react/mastra-chat.tsx:279`).
- Python binding files remain generator-owned ignored outputs under current
  workspace policy (`projen/src/project-rs.ts:566`). They were regenerated and
  tested locally; Node target-independent binding sources remain tracked.

## Validation

- Rust workspace tests: 38 passed with default features; no-default-features
  workspace tests also passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- Both release native libraries built; both Node and Python bindings regenerated.
- Focused Node tests: 5 passed, including CLI mapping and shared native callbacks.
- Focused Python tests: 2 passed, including shared options and both provider factories.
- Auth CLI TypeScript check: passed with repository root as `rootDir`.
- Focused ESLint: no findings using the repository's legacy config mode;
  ESLint reports its existing configuration deprecation notice.
- Focused Python regression-test Ruff check passed. Whole-Python Ruff found the
  existing diagnostic-CLI BLE001 issue recorded as A09.
- README site generation passed. `cargo doc --workspace --no-deps` with
  `-W missing_docs` generated reference docs and exposed remaining rustdoc gaps.
- `git diff --check`: passed. No publication, commit, or push was performed.

## Open questions

- Should custom storage status preserve the adapter's caller-supplied name, or
  expose only a stable `custom` variant? That choice belongs in the Rust contract.
- Should generated options representations redact only declared secrets, or
  omit all fields by default? Rust-owned metadata avoids per-language field lists.
- Should default numeric literals be generated from Rust defaults too? UniFFI
  field annotations and Rust `Default` still each declare the same values within
  the owning record; cross-language tests now guard against divergence.
- Which remaining Rust APIs are intended public versus internal? Narrowing
  accidental exports may be preferable to documenting them as supported APIs.
