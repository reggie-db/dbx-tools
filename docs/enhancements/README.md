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

- [Repository code-quality audit](2026-10-01-repository-code-quality-audit.md)
  - Records the model-proxy metrics redesign, conditional passkey flow, reusable
    Rust Projen project and release helper, release compile ownership, dependency
    upgrades, package-boundary review, and remaining measured follow-up.
- [Model proxy adaptive rate-limit and observability plan](2026-09-30-model-proxy-adaptive-rate-limit-decay-plan.md)
  - Recover auto-mode workspace/model queues from temporary input-token
    contention through conservative activation, clean-traffic evidence,
    stepwise relaxation, and eventual deactivation; add concise logging, bounded
    metrics, optional persistence, and a Figma-designed embedded dashboard.
- [Singular-version draft-promotion release architecture](2026-09-30-singular-version-content-addressed-rust-release-plan.md)
  - Tracks the implemented one-checkout transaction, root `VERSION` ownership,
    immutable candidate manifest, manual GitHub Release approval, and
    `release.published` registry promotion.

## Cross-repository suggestions

When work in another repository identifies a change for this project, copy a
self-contained plan into this repository rather than leaving the suggestion
only in the source project. Track and update the work here, where the code
lives. When its tracked work is complete or explicitly abandoned, move it to
`docs/archived/enhancements`.

Use the same lifecycle for defects: copy them into `docs/bugs`, handle them in
this repository, and move them to `docs/archived/bugs` when resolved or no
longer active.
