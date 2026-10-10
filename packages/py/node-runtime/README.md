# `dbx-tools-node-runtime`

Run PythonMonkey-based packages in managed Python environments that do not
provide system Node.js or npm.

## Quick Start

```python
%pip install dbx-tools-node-runtime
```

On first use, the package installs the locked PythonMonkey runtime into the
active Python environment. It reuses npm when available; otherwise it installs
`nodejs-wheel>=22.20,<23` and uses the packaged Node and npm executables.

An existing npm executable or installed `nodejs-wheel` package is reused without
enforcing an exact Node wheel version. The range applies only when the runtime
must install `nodejs-wheel` itself.

Both installations use a check-lock-check sequence scoped to the active Python
environment. Concurrent processes wait for the same install, then recheck the
environment instead of installing a second copy. The lock files contain no
runtime packages. Set `DBX_TOOLS_NODE_RUNTIME_LOCK_DIRECTORY` only when the
default per-user lock directory is unsuitable.

## Runtime Installation

Install the package normally:

```python
%pip install dbx-tools-node-runtime
```

If the active environment was created without pip, the first runtime
installation uses CPython's bundled `ensurepip` before installing PythonMonkey.

Prewarm the runtime explicitly when desired:

```sh
dbx-tools-node-runtime
```

The same project script can execute a CommonJS file through the lazy runtime:

```sh
dbx-tools-node-runtime ./hello.js
```

Otherwise the first generated binding load performs the same initialization
through `ensure_pythonmonkey()`. Generated dbx-tools bindings use
PythonMonkey's standard `pythonmonkey.require` loader after installation.

The package also installs the Databricks SDK for Python. In notebooks and Jobs,
its shared runtime exposes the SDK's default `WorkspaceClient` authentication to
generated Node auth bindings. Empty auth options use that runtime credential
source automatically. Explicit profiles, hosts, and credentials continue
through the normal Node auth providers.

The shared PythonMonkey host lives under `shims/`. A shim path
encodes its specifier: `___` becomes `:`, `__` becomes `/`, and every other
character stays as written (`node___fs__promises.ts` becomes `node:fs/promises`).
Files whose derived name has no scheme, including `bootstrap.ts`, are support
modules rather than runtime registry entries. Duplicate derived specifiers or
registry aliases fail the build.

## Build and watch

`build-runtime.ts` bundles the bootstrap and shims into
`src/dbx_tools/node_runtime/runtime.js`. It adds a generated-file header, avoids
rewriting unchanged output, and leaves the committed artifact read-only. Build
or verify it directly with:

```sh
bun packages/py/node-runtime/build-runtime.ts
bun packages/py/node-runtime/build-runtime.ts --check
```

In a `@dbx-tools/projen` Python workspace, mark this package with
`nodeRuntime: true`. Projen then exposes repository-wide tasks rather than
package-specific tasks:

```sh
bun run python-node-runtime
bun run python-node-runtime:check
bun run python-node-runtime:watch
```

`bun run sync --watch` supervises `python-node-runtime:watch` with the shared
Python binding, barrel, and Projen configuration watchers.
