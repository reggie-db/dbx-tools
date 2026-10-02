# Repository code-quality audit

Date: 2026-10-01

Status: Implementation complete. Keep this audit active through the first
observed release using the consolidated Node publication compile, then archive
it after comparing the release log with the baseline captured below.

Scope: repository-wide architecture, package boundaries, generated Projen
behavior, release workflows, AppKit and Mastra reuse, Rust ownership, tunnel
authentication UX, model-proxy metrics usability, documentation accuracy, and
current dependency lines.

## Executive summary

- The model-proxy dashboard is a no-manifest React frontend hosted by the
  in-process Tauri desktop. Generated Specta bindings replace HTTP polling and
  SSE, ECharts renders timestamped traffic and reasoning views, and the model
  table exposes typed profile and limiter controls
  (`packages/rs/model-proxy/desktop/src/App.tsx`,
  `packages/rs/model-proxy/src/desktop.rs`,
  `packages/rs/model-proxy/src/operator.rs`).
- Reasoning classification is owned by the Rust request boundary and aggregated
  by the existing bounded metrics store. The UI does not infer provider policy
  independently (`packages/rs/model-proxy/src/request_log.rs:64`,
  `packages/rs/model-proxy/src/metrics.rs:660`,
  `packages/rs/model-proxy/src/metrics.rs:809`).
- The tunnel login starts conditional passkey mediation automatically when the
  browser supports it. The explicit button remains only as a fallback when
  conditional mediation is unavailable or fails
  (`packages/js/ui/auth/src/react/auth-gate.tsx:51`,
  `packages/js/ui/auth/src/react/auth-gate.tsx:179`).
- Rust release orchestration no longer requires a private helper crate. Projen
  generates a dependency-free Node helper into each consumer, and Rust workspace
  members are native Projen projects with object-style options and repository-
  neutral defaults (`projen/src/project-rs.ts:80`,
  `projen/src/project-rs.ts:464`, `projen/src/project-rs.ts:1202`).
- Node release publication now compiles selected publishable packages once from
  the workspace root and packs with lifecycle scripts disabled. Local release
  publication reuses only the immediately preceding validated compile and checks
  that expected outputs exist (`projen/tasks/publish.ts:29`,
  `projen/tasks/publish.ts:343`, `projen/tasks/publish.ts:384`,
  `projen/tasks/local-publish.ts:53`, `projen/tasks/release-pr.ts:486`).
- Projen, AppKit, Better Auth, and Mastra were reconciled to their current tested
  stable lines. Several Mastra packages publish alpha builds under the npm
  `latest` tag, so this repository intentionally pins the newest non-prerelease
  versions rather than accepting those alphas (`package.json:156`,
  `package.json:162`, `package.json:175`).
- No package merge is recommended from consumer count alone. The reviewed
  shared, Node, UI, CLI, and generated UniFFI packages represent runtime or
  publication boundaries, and merging them would either pull server code into
  browser graphs or restore handwritten cross-language mirrors.

## Architectural mental model

The repository is a source-first polyglot monorepo. Projen discovers and owns
JavaScript, Python, and Cargo project metadata; handwritten packages are split
by runtime boundary, while generated UniFFI packages expose Rust-owned contracts
to Node and Python. AppKit owns application lifecycle and plugin composition,
Mastra owns agent behavior, Better Auth owns sessions and passkeys, and the
dbx-tools packages add Databricks-specific policy only where those frameworks do
not provide equivalent public contracts.

The release path is intentionally singular: one reviewed repository version,
one generated workflow, one Cargo build per selected target, and one root-owned
Node compile before package publication. Generated files remain outputs of the
Projen engine; repository-specific behavior belongs in `.projenrc.ts`, while
reusable behavior belongs in the published engine.

## Findings and disposition

| ID   | Area                          | Severity | Status   | Finding and disposition                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CQ01 | Metrics usability             | High     | Complete | Hand-drawn charts lacked a real time scale and exposed color names as legend text. The Tauri React desktop uses ECharts for timestamped traffic and reasoning views and keeps the legend accessible (`packages/rs/model-proxy/desktop/src/App.tsx`).                                                                                                                                                                                                             |
| CQ02 | Metrics semantics             | Medium   | Complete | Open sockets were presented as active work even though keep-alive connections remain open while idle. The primary value is `active_requests`; connections and streams remain supporting context in the generated Specta snapshot (`packages/rs/model-proxy/src/metrics.rs`, `packages/rs/model-proxy/desktop/src/bindings.ts`).                                                                                                                                  |
| CQ03 | Thinking observability        | Medium   | Complete | Request reasoning or thinking settings were not measurable. The request boundary normalizes supported wire shapes once, bounded snapshots retain distributions, and the desktop renders them as a pie chart (`packages/rs/model-proxy/src/request_log.rs`, `packages/rs/model-proxy/src/metrics.rs`, `packages/rs/model-proxy/desktop/src/App.tsx`).                                                                                                             |
| CQ04 | Passkey UX                    | Medium   | Complete | A dedicated passkey button made passkey-first login an extra action. Conditional mediation now starts from the WebAuthn-enabled email input, with the button retained only for unsupported or failed conditional flows (`packages/js/ui/auth/src/react/auth-gate.tsx:51`, `packages/js/ui/auth/src/react/auth-gate.tsx:181`).                                                                                                                                    |
| CQ05 | Release compilation           | High     | Complete | npm release publication could trigger each package's `prepack`, repeating `tsc --build` across local validation and publication. The publisher now selects compiled packages once, runs one filtered root compile, and uses `--ignore-scripts`; `--skip-compile` refuses missing outputs (`projen/tasks/publish.ts:29`, `projen/tasks/publish.ts:343`, `projen/tasks/publish.ts:384`).                                                                           |
| CQ06 | Reusable Rust release tooling | High     | Complete | The previous private Rust helper made orchestration repository-specific and added a Cargo build before the actual release matrix. The same fingerprint and stamp contract now ships as a dependency-free Node helper generated by Projen (`projen/tasks/rust-release.mjs:1`, `projen/src/project-rs.ts:1202`).                                                                                                                                                   |
| CQ07 | Projen project parity         | High     | Complete | Rust members behaved as Projen projects but exposed a positional constructor and did not apply the workspace `private` option. `DBXToolsRustProject` now accepts object-style options, inherits scope and root defaults, and applies a workspace publication default with package overrides (`projen/src/project-rs.ts:80`, `projen/src/project-rs.ts:474`, `projen/src/project-rs.ts:105`).                                                                     |
| CQ08 | Consumer Projen runtime       | High     | Complete | A bundled second Projen runtime can break Projen's remaining `instanceof` checks. The engine centralizes the tested version, exposes Projen as a peer, and the packed-consumer test proves that consumer roots and generated Rust members share the same `Project` class (`projen/src/projen-version.ts:1`, `projen/package.json:23`, `projen/package.json:27`, `projen/test/packed-consumer.test.ts:69`).                                                       |
| CQ09 | Framework upgrades            | Medium   | Complete | Projen, AppKit, Mastra, and Better Auth were behind the current tested stable surface. The catalog now uses Projen 0.103.27, AppKit 0.81.0, Better Auth 1.7.6, and the newest non-prerelease Mastra package versions (`package.json:156`, `package.json:162`, `package.json:175`, `projen/package.json:23`).                                                                                                                                                     |
| CQ10 | Documentation drift           | Low      | Complete | The active Rust release plan still described the removed helper crate, and the archived AppKit review contained title typos. Both now describe the implemented architecture and current names (`docs/enhancements/2026-09-30-singular-version-content-addressed-rust-release-plan.md:45`, `docs/archived/enhancements/2026-09-29-latest-appkit-reuse-plan.md:1`).                                                                                                |
| CQ11 | Generator concentration       | Medium   | Observe  | `projen/src/project-rs.ts` remains a 2,120-line concentration point spanning Cargo project modeling and release workflow generation (`projen/src/project-rs.ts:464`, `projen/src/project-rs.ts:1202`). The reusable Node helper removed one concrete responsibility. Do not split the file solely by line count; extract the release workflow builder only when the next material Rust release change can preserve generated output with focused snapshot tests. |

## Package and contract review

- `packages/js/shared/*` remains browser-safe contract ownership. Matching
  `packages/js/node/*` and `packages/js/ui/*` packages add server runtime and
  presentation dependencies respectively. Consolidating these layers would
  worsen dependency direction rather than reduce meaningful duplication.
- `packages/js/node/core-rs`, `packages/js/node/google-rs`,
  `packages/js/node/model-rs`, and their Python counterparts remain dedicated
  generated facades. Records, enums, and policy originate in Rust; the generated
  package-root barrels are the supported language surfaces. No handwritten
  `nodeExports` compatibility layer was added.
- `packages/js/node/model` remains separate from `packages/rs/model`: the Rust
  package owns pure catalogue and capability policy, while the Node package owns
  workspace SDK integration and runtime endpoint selection. Existing imports
  consume generated Rust policy rather than redeclaring it.
- `packages/js/node/tunnel` and `packages/js/cli/tunnel` remain separate transport
  adapters over the same `@dbx-tools/auth-gate` plugin. The authentication UI
  imports directly from `@dbx-tools/ui-auth`; email packages do not re-export it.
- One-consumer packages were not merged merely to reduce package count. Public
  publication boundaries, browser safety, optional native artifacts, and
  independent consumer installation are stronger signals than in-repository
  fan-out.

## Framework reuse review

- AppKit 0.81 documentation and installed declaration files were checked before
  retaining custom AppKit-facing behavior. Existing custom Mastra, Genie Agent
  Mode, durable approval, Graphiti MCP, and shutdown behavior remains where the
  public AppKit surface does not provide contract parity.
- Tauri owns the desktop window and system tray, ECharts owns chart rendering,
  and Specta owns the frontend IPC contract. No HTTP dashboard transport,
  handwritten window runtime, or duplicated TypeScript contract remains.
- Better Auth remains the passkey and session owner. The UI uses the browser's
  conditional-mediation capability and the existing auth client rather than
  introducing credential detection or storage (`packages/js/ui/auth/src/react/auth-gate.tsx:58`).
- `DBXToolsRustWorkspace` extends Projen `Component`, and every discovered Cargo
  member is a Projen `Project`; generated files and tasks remain within normal
  synthesis ownership (`projen/src/project-rs.ts:464`,
  `projen/src/project-rs.ts:1932`).

## Release compile baseline

Before this audit, release logs showed 32 publishable TypeScript packages each
entering their own `compile` task after an earlier local validation compile.
Lifecycle-driven packing could trigger the same work again. The current design
has two explicit modes:

1. normal CI publication performs one root-owned filtered compile for every
   publishable package with compiled targets;
2. local release publication passes `--skip-compile` only when the release
   command has just completed its validation compile.

The first production release after this change should confirm one publication
compile block and no per-package `prepack` compile blocks. Record the before and
after wall time here, then archive this audit.

## Things that look questionable but are intentional

- Generated UniFFI TypeScript contains `any`, `@ts-ignore`, and generator TODOs.
  Those files are committed, read-only generator output; handwritten mirrors
  would create a second contract source. Fix the generator when a generated
  shape is unsafe rather than editing the outputs.
- Several source files exceed 1,000 lines. The model-proxy route, throttle, and
  metrics modules represent distinct hot-path state machines with focused Rust
  tests. Line count alone is not evidence that another package or abstraction
  would improve them.
- The release workflow has separate native npm, normal npm, facade npm, PyPI,
  Cargo, GitHub asset, and docs jobs. These are different trust, runner, and
  artifact boundaries; merging them would couple credentials and recovery.
- Mastra package pins do not follow every npm `latest` tag because those tags can
  resolve to alpha builds. Exact stable pins make the co-tested surface explicit.

## Validation record

- Projen synthesis completed without drift. The focused Rust-project,
  release-helper, local-publication, release-summary, and packed external
  consumer suites passed 27 tests.
- The complete TypeScript workspace compiled, ESLint passed without warnings,
  and the root JavaScript test task passed every package suite. The standalone
  installer suite passed 27 tests and intentionally skipped its three opt-in
  container cases.
- Desktop binding and asset validation, the source-documentation ratchet, and
  README synchronization passed.
- Python Ruff validation passed, followed by 87 passing pytest cases.
- `cargo test -p dbx-tools-model-proxy --all-features` passed 95 tests,
  including Specta binding parity and JavaScript-safe metric projection.
  Service lifecycle tests passed with single-process desktop selection, and
  Clippy passed across model-proxy, service, and service-desktop.
