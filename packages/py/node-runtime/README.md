# dbx-tools-node-runtime

Run dbx-tools Python packages that contain generated PythonMonkey bindings in
managed Python environments without a system Node.js or npm installation.

## Install the runtime

```python
%pip install dbx-tools-node-runtime
```

Most users don't import this package directly. Packages with generated
dbx-tools Node bindings depend on it and initialize it when the first binding
loads.

On first use, the runtime installs PythonMonkey 1.3.2 into the active Python
environment. It uses an available npm executable. If npm is unavailable, it
installs `nodejs-wheel>=22.20,<23` and creates temporary Node and npm launchers
from that wheel.

An existing npm executable or installed `nodejs-wheel` package is reused
without an exact wheel-version check. The version range applies when this
package installs the wheel.

## Prewarm the environment

Run the project script to install or verify PythonMonkey before an application
loads generated bindings:

```bash
dbx-tools-node-runtime
```

The command prints the resolved PythonMonkey package path. You can also run
a CommonJS file through PythonMonkey:

```bash
dbx-tools-node-runtime ./hello.js
```

If the environment has no pip, bootstrap uses CPython's bundled `ensurepip`
before it installs PythonMonkey.

## Use generated bindings

Generated packages call the shared runtime through `load_bundle()`. You can
also load a generated CommonJS bundle directly:

```python
from dbx_tools.node_runtime.runtime import load_bundle

bundle = load_bundle("./generated-runtime.cjs", bundle_id="example")
module = bundle.module("config")
```

The runtime loads one process-wide compatibility registry and caches each
bundle by ID. Generated wrappers convert supported records, arrays,
dataclasses, promises, and JavaScript class instances between Python and
JavaScript.

## Use Databricks authentication

The package also installs the Databricks SDK for Python. In notebooks and Jobs,
its shared runtime exposes the SDK's default `WorkspaceClient` authentication to
generated Node auth bindings. Empty auth options use that runtime credential
source automatically. Explicit profiles, hosts, and credentials continue
through the normal Node auth providers.

In a Databricks notebook or Lakeflow Job, you can omit a profile when the
default Python SDK credential source is correct for that runtime. Pass an
explicit profile when you need to select a local Databricks CLI profile.

## Configure installation locks

Node-wheel and PythonMonkey installation use separate check-lock-check
sequences scoped to the active Python environment. Concurrent processes wait
for the lock, recheck the environment, and skip a second installation when the
first process completed it.

Lock files contain no runtime packages. Set
`DBX_TOOLS_NODE_RUNTIME_LOCK_DIRECTORY` only when the default per-user cache
directory is unavailable or isn't shared correctly by the processes that use
the same Python environment.

## Understand runtime limits

- PythonMonkey must be version 1.3.2. Loading another PythonMonkey version in
  the process raises an error.
- First use can install Python packages into the active environment. Prewarm
  images or managed services that must not install packages during startup.
- The package provides compatibility only for Node built-ins imported by a
  generated dbx-tools bundle.
- Bundles must use the same runtime ABI as the installed package.
- The runtime doesn't provide a general Node package manager or a replacement
  for arbitrary Node applications.

## Contribute runtime changes

`build-runtime.ts` bundles the bootstrap and shims into
`src/dbx_tools/node_runtime/runtime.js`. It adds a generated-file header, avoids
rewriting unchanged output, and leaves the committed artifact read-only. Edit
`build-runtime.ts` or `shims/`, then build or verify the artifact:

```bash
bun packages/py/node-runtime/build-runtime.ts
bun packages/py/node-runtime/build-runtime.ts --check
```

In this repository, use the root tasks:

```bash
bun run python-node-runtime
bun run python-node-runtime:check
bun run python-node-runtime:watch
```

`bun run sync --watch` supervises `python-node-runtime:watch` with the shared
Python binding, barrel, and Projen configuration watchers. Don't edit the
generated `runtime.js` file directly.
