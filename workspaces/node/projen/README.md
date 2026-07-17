# @dbx-tools/projen

The [projen](https://projen.io) engine behind this repo: a pnpm monorepo
generator. Exports `DBXToolsNodeProject` / `DBXToolsTypeScriptProject` and the
mixin / predicate helpers. Drop a `src`-bearing folder under
`workspaces/<tag>/<name>` and it is configured, type-checked, and barrelled
automatically.

Node-tagged (it uses `node:*`, `tsx`, and shells out), so it lives under
`workspaces/node/`. The published package name is `@dbx-tools/projen`; the
`dbxtools` CLI that drives it ships as [`@dbx-tools/cli`](../../cli/dbx-tools).

```ts
// .projenrc.ts
import { project as projectApi, mixin, projectPredicate } from "@dbx-tools/projen";

const p = new projectApi.DBXToolsNodeProject();
p.with(
  mixin.mixin(projectPredicate.hasTag("shared"), (pkg) => pkg.addDeps("zod@catalog:")),
);
p.synth();
```

## What it does on synth

- Discovers packages by scanning workspace roots; a folder's path drives its
  tags (e.g. `workspaces/node/*` -> `node`).
- Generates each package's `package.json` / `tsconfig` / root `index.ts` barrel
  (namespaces per module; unique **types** hoisted flat).
- Runs `dbxtools codegen` (ts-to-zod) and barrels in the post-synth pass.
- Owns `pnpm-workspace.yaml` (members + catalog + build allowlist).

Subpath exports: `@dbx-tools/projen` (main), `./log`, `./engine-root`.
