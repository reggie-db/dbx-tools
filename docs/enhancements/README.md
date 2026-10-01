# Active enhancements

Keep plans here while code or documentation changes are still active. Move a
plan to `docs/archived/enhancements` once its tracked work is complete or
explicitly abandoned.

Prefix new audits and plans with their creation date in `YYYY-MM-DD-` form so
repeated reviews remain distinct. Update the active document as findings are
completed or reprioritized. When all tracked work is complete or intentionally
closed, move the document to `docs/archived/enhancements` and record its archive
date and final status.

## Active plans

- [Deep code quality and reuse plan](2026-10-01-deep-code-quality-and-reuse-plan.md)
  - Tracks verified isolation defects, Rust release/project parity, publication
    correctness, model and auth ownership, and concrete DRY consolidation after
    the Kanna audit baseline.
- [Repository code-quality audit](2026-10-01-repository-code-quality-audit.md)
  - Records the model-proxy metrics redesign, conditional passkey flow, reusable
    Rust Projen project and release helper, release compile ownership, dependency
    upgrades, package-boundary review, and remaining measured follow-up.
- [Model proxy adaptive rate-limit and observability plan](2026-09-30-model-proxy-adaptive-rate-limit-decay-plan.md)
  - Recover auto-mode workspace/model queues from temporary input-token
    contention through conservative activation, clean-traffic evidence,
    stepwise relaxation, and eventual deactivation; add concise logging, bounded
    metrics, optional persistence, and a Figma-designed embedded dashboard.
- [Singular version and content-addressed Rust release plan](2026-09-30-singular-version-content-addressed-rust-release-plan.md)
  - Implemented singular-version release flow: one reviewed PR into `main`, one
    repository version, exact-key reuse of checksummed raw Rust target bundles,
    structured binary version stamping, Cargo timings, and existing-runner
    documentation parallelism/cache improvements.

## Cross-repository suggestions

When work in another repository identifies a change for this project, copy a
self-contained plan into this repository rather than leaving the suggestion
only in the source project. Track and update the work here, where the code
lives. When its tracked work is complete or explicitly abandoned, move it to
`docs/archived/enhancements`.

Use the same lifecycle for defects: copy them into `docs/bugs`, handle them in
this repository, and move them to `docs/archived/bugs` when resolved or no
longer active.
