# `dbx-tools-node-bindings`

Python host bindings for dbx-tools packages that execute bundled TypeScript
through PythonMonkey.

The package keeps cross-language plumbing out of capability packages:

- `require_runtime()` loads a committed CommonJS bundle beside a Python module.
- `MemoryLeaseLocks` provides keyed in-process check-lock-recheck leases.
- `FileLeaseLocks` provides keyed cross-process leases through `filelock`.
- `with_file_lock()` runs an async callback under a path-keyed file lock.
- `read_text()`, `read_json()`, and `atomic_write_json()` provide asynchronous
  file access without blocking the event loop.
- `open_browser()` delegates browser launch to Python's maintained `webbrowser`
  integration.
- `run_process()` maps plain arguments onto `dbx-tools-core` executable
  resolution and asyncio subprocesses.
- `execute_http()` maps plain arguments onto an HTTPX async client.

Capability packages still own their contracts and generated JavaScript entry
points. This package owns only reusable Python host behavior.

## Example

```python
from dbx_tools.node_bindings import require_runtime

runtime = require_runtime(__file__)
value = await runtime["run"]()
```

Generate committed bundles through the shared Projen task rather than writing a
package-specific bundler:

```sh
bun projen/tasks/python-node-bindings.ts \
  --entry packages/js/node/example/src/_python-bridge.ts \
  --output packages/py/example/src/dbx_tools/example/_runtime.js \
  --source '@dbx-tools/example for PythonMonkey'
```
