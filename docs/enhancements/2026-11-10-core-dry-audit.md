# Core-first duplication cleanup

Date: 2026-11-10

Status: In progress

## Scope

Audit shared and Node core first, then their filesystem, configuration,
authentication, model, and Projen engine consumers. Use Code Index structural
search to discover candidates and inspect current source, tests, dependencies,
and installed owner APIs before editing. Preserve concurrent work and keep
validation failures outside the changed behavior out of this cleanup.

Generated entrypoints and configuration must be regenerated from their owners.
Remove replaced implementations rather than retaining compatibility aliases.

## Findings and dispositions

| Priority | Finding | Owner and evidence | Disposition |
| --- | --- | --- | --- |
| 1 | Host-path boundary checks are repeated in core bundle/config/bin, Node filesystem/path, and Projen engine code. Several checks reject valid `..name` descendants. | Node's installed `path` declarations provide `relative` and `isAbsolute`, without a containment operation. Node core can own the missing host-path primitive without depending on the higher-level path package. Shared filesystem paths have separate portable namespace semantics. | Implement `file.relativePathWithin`; preserve caller-specific root rejection and realpath checks. |
| 2 | Foundational adjacent packages may repeat core collection, JSON, error, cache, and async behavior. | Inspect the existing shared-core and core APIs; parallel audit covers path, filesystem, cache, and Postgres. | In progress. |
| 2 | Auth, Databricks, Lakebase, and model engines may repeat core or package-owned policy. | Parallel audit checks exact owner APIs and lifecycle differences. | In progress. |
| 3 | Projen and Python binding engines may repeat dependency discovery, subprocess, parsing, and generation behavior. | Read-only structural audit compares current sources with installed Projen APIs. | In progress. |
| 3 | Bundle/configuration discovery duplicates bundle filenames and command construction. | `core/bundle.ts` and `core/config-utils.ts` have different async/sync, caching, logging, and error contracts. | Investigate after the containment change; do not merge the distinct lifecycles merely to reduce lines. |

## Acceptance checks

- Every changed utility has one owner and direct callers.
- Host containment covers root equality, filesystem roots, dot segments,
  sibling prefixes, real escapes, and names beginning with `..`.
- Focused changed-package tests pass; unrelated failures are reported without
  attempted repairs.
- Generated changes are synthesized twice with no second-pass changes.
- Documentation links, version/workspace invariants where applicable, and
  repository-wide structural review are checked.

## Baseline evidence

- Code Index searches found the host containment copies in core, filesystem,
  path, and Projen code, including copies with different function names.
- AI-SLOP Detector duplicate sweeps of shared core and Node core each reported
  zero issues. Semantic review remains necessary because these checks are
  scattered and syntactically different.
