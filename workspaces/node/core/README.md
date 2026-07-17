# @dbx-tools/node-core

The Node-only half of the shared runtime: helpers that touch `node:*` builtins
and so can't live in the browser-safe [`@dbx-tools/shared-core`](../../shared/core).
Node-tagged (node types, ES2022 lib, no DOM) by virtue of living under
`workspaces/node/`.

```ts
import { exec, project } from "@dbx-tools/node-core";

const { stdout } = exec.spawnSync("git", ["rev-parse", "HEAD"], { stdout: "capture" });
const repoRoot = project.root();
```

## Modules

- `exec` - `spawn` / `spawnSync` over `node:child_process` with captured
  stdout/stderr lines, string stdin, and abort support.
- `project` - repo-root detection (`npm prefix` -> git top-level -> cwd) over
  `node:fs` / `node:path`.

Anything needing `child_process` / `fs` / `process` depends on node-core; keep
`shared-core` browser-safe.
