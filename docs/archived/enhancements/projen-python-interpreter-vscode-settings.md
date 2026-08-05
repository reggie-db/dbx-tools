# Projen: default Python interpreter for Cursor / VS Code

Date: 2026-08-04

Status: resolved in the project language split and `DBXToolsPythonWorkspace`
extraction; archived August 5, 2026.

## Purpose

Record a usability gap in `@dbx-tools/projen`'s root `.vscode/settings.json` emission, found
while working in `dbx-value-ontology`. The gap makes Python type checking look broken in Cursor
even when the uv workspace and runtime are fine.

## Symptom

In a monorepo that keeps a uv workspace under `python/` with `.venv` at `python/.venv`:

- `uv run` and the venv interpreter import workspace packages correctly
  (`lakespan_core`, `lakespan_collect`, `databricks-sdk`, etc.).
- Cursor's type checkers (Pyrefly, basedpyright, Pyright) report unresolved imports on the same
  files.

Diagnostics showed the language servers bound to Homebrew system Python
(`/opt/homebrew/Cellar/python@3.14/...`) and an inferred import root of `python/src`, not the uv
workspace members under `python/packages/*/src`.

## Root cause

`DBXToolsVsCode` (`packages/.../projen/src/vscode.ts`) only emits TypeScript-oriented workspace
settings (`typescript.tsdk`, Prettier, watcher excludes). It does not set
`python.defaultInterpreterPath`.

Consumers previously had to opt in manually. The direct projen accessor is:

```ts
project.vscode?.settings.addSetting(
  "python.defaultInterpreterPath",
  "${workspaceFolder}/python/.venv/bin/python",
);
```

The failure came from `DBXToolsVsCode` constructing a second `vscode.VsCode`
instead of reusing the one projen already places at `project.vscode`. Accessing
the original component then caused both components to claim
`.vscode/settings.json`.

## Why this should be fixed in dbx-tools

Any dbx-tools consumer that adds a sibling `python/` uv workspace will hit the same Cursor vs
runtime mismatch. Forcing each app to discover `project.vsCode.vsCode.settings` is not intuitive,
and the wrong accessor looks correct until synth crashes.

## Proposed fix

The implemented fix makes Python workspace configuration explicit and reusable.

1. **Reuse projen's component.** `DBXToolsVsCode` configures `project.vscode`
   rather than constructing another `vscode.VsCode`.
2. **Python workspace component.** `DBXToolsPythonWorkspace` emits:

   ```json
   "python.defaultInterpreterPath": "${workspaceFolder}/python/.venv/bin/python"
   ```

   through its `interpreterPath` option. It also owns uv workspace/member files,
   Python tasks, and the optional publishing workflow.

3. **No filesystem detection.** Configuration does not depend on the venv
   already existing during first synth or CI.
4. **Optional extras remain deferred.** Consider setting
   `python.analysis.extraPaths` for `python/packages/*/src` if editable installs are not enough
   for every checker. Start with the interpreter path alone; that fixed the observed Cursor
   failure.

## Workaround used in dbx-value-ontology

The local workaround can be replaced with `DBXToolsPythonWorkspace` and its
`interpreterPath: "${workspaceFolder}/python/.venv/bin/python"` option.

## Demand signal

- Repo: `dbx-value-ontology`
- Layout: `python/` uv workspace, venv at `python/.venv` (CPython 3.12 via uv)
- Failure mode: Cursor/Pyrefly against system Python 3.14; runtime via uv healthy
