# Slim Projen engine

Date: 2026-10-05

Status: Implemented and archived on 2026-10-05.

## Objective

Reduce the Projen engine by deleting abandoned and duplicate systems, make the
`src` and `tasks` boundary explicit, reuse native Projen and dbx-tools core
utilities, and fix generated Projen TypeScript configuration.

## Implementation result

- Both generated `tsconfig.projen.json` files now extend their canonical project
  configs and limit their roots to `.projenrc.ts` and `projenrc/**/*.ts`.
  Explicit `.ts` imports type-check without TS5096 or TS5097.
- The unused release catalog, graph types, tests, options, registrations, and
  OpenAPI fallback were deleted. `VERSION` is the single lockstep version owner.
- Stable `projen/tasks/*.ts` paths are thin guarded launchers. Reusable command
  implementations live under `projen/tasks/lib/`.
- The path-keyed package description and shared-core dependency maps were
  removed. Descriptions and `workspace:^` dependencies are configured directly
  on their owning projects.
- Internal engine imports now target owning modules instead of routing through
  the generated package barrel.
- `DBXToolsConfig` is a typed state holder rendered lazily through Projen's
  package field API. Reflection and unrestricted string fields were removed.
- VS Code settings and extensions use Projen's native `project.vscode`.
  Custom code remains only for `.vscode/tasks.json`, which Projen does not own.
- Projen's native build workflow, pull-request lint, package entrypoint,
  repository, version, bin, package resolution, task argv, TypeScript version,
  Bun version, and pnpm schema APIs replaced custom implementations.
- Browser-safe, shared, UI, app, and OpenAPI packages no longer carry blanket
  Node type dependencies. Bun types are declared only where Bun globals are
  compiled.
- Python workspace dependencies use package names plus
  `[tool.uv.sources.<name>] workspace = true`. Native per-package uv publish
  tasks were removed so publication cannot bypass dependency projection.
- Native Projen file inventories and durable generated markers replaced
  read-only mode as generated-file ownership evidence.
- The release command now requires a clean checked-out release branch, runs
  validation before publication, and atomically pushes the branch and annotated
  tag. The workflow creates an idempotent GitHub Release.
- `PACKAGE_VERSION` was removed from generated barrels because package manifests
  already own version metadata.

## Installed Projen cross-reference

The implementation was audited against installed Projen 0.103.27. Custom code
was retained only for capabilities without a matching native owner:

- filesystem package discovery and path-derived tags;
- Bun workspace mirroring and Databricks Apps pnpm output;
- root-only workspace installation;
- child generated-file suppression where Projen exposes no option;
- Bun app, Tailwind, and HTML build generation;
- focused watch loops and cross-process mutation locking;
- barrels, Zod codegen, OpenAPI generation, and PythonMonkey bindings;
- source-first workspace exports with compiled npm publication;
- the plain-text lockstep `VERSION` release model and multi-package uv
  publication.

Generic `ProjenrcTs` remains intentional for root projects because the required
generated artifact is `tsconfig.projen.json`. The TypeScriptProject-specific
native component emits `projenrc/tsconfig.json`, which does not satisfy that
repository contract.

## Validation

- `bun test projen/test`: 149 passed.
- Packed external consumer lifecycle: passed as part of the Projen suite.
- Root and engine synthesis were each run twice with no second-pass diff.
- `bunx tsc --noEmit -p tsconfig.projen.json`: passed.
- `bunx tsc --noEmit -p projen/tsconfig.projen.json`: passed.
- `bunx tsc --noEmit -p projen/tsconfig.json`: passed.
- Scoped Projen ESLint validation: passed.
- `bun run compile`: passed for 45 workspaces.
- `bun run version:check`: passed at `0.9.32`.

The repository-wide `bun run test` still reports pre-existing lint errors in
unrelated authentication, Lakebase, model, and shared-core source files. Those
files are outside this enhancement and were not changed to widen its scope.
