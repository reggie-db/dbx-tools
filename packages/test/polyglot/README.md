# Polyglot parity tests

Private workspace package for contracts implemented in more than one dbx-tools
runtime. Pure deterministic contracts run in their owning TypeScript package
through the Bun-native `./polyglot` helper, which invokes the Python equivalent
through embedded CPython. Process-isolated JSON/YAML fixtures remain here for
configuration behavior that mutates cwd, environment, files, subprocesses, and
module caches.

```bash
bun run --filter @dbx-tools/test-polyglot test
```

## In-process package tests

Published packages take `@dbx-tools/test-polyglot` only as a test dependency:

```ts
import { polygotTest } from "@dbx-tools/test-polyglot/polyglot";

await polygotTest(
  () => import("../index.ts"),
  "object",
  (implementation, language) => {
    describe(`object.toStableKey (${language})`, () => {
      it("canonicalizes values", () => {
        assert.equal(implementation.toStableKey({ a: 1 }), "object:{string:1:a=number:1}");
      });
    });
  },
);
```

The generated package barrel supplies `PACKAGE_IDENTIFIER`; the helper uses it
with the selected export name to find the Python module. Pass
`options.identifiers.python` only when the Python module does not follow that
mapping.

## Fixture layout

The test recursively discovers every `.json`, `.yaml`, and `.yml` document below
`fixtures/` except directory defaults named `default.*`. Use descriptive names
such as `fixture.json` inside a contract-specific directory.

Top-level fixture directories follow the TypeScript source-of-truth package,
with contracts nested beneath them where needed. The retained configuration
suite lives under `fixtures/core/config` and maps test adapters for both
runtimes through its directory default.

Each directory may contain one `default.json`, `default.yaml`, or `default.yml`.
Defaults inherit from the `fixtures/` root toward the fixture and are merged in
this order:

1. parent-directory defaults;
2. nearest-directory default;
3. fixture document;
4. named function target;
5. individual test target overrides.

Directory defaults are useful for module names and language-specific export
paths shared by several fixture files:

```yaml
modules:
  typescript: "@dbx-tools/shared-core"
  python: dbx_tools.core
functions:
  toStableKey:
    path:
      typescript: object.toStableKey
      python: to_stable_key
```

A fixture normally groups tests under logical function names:

```yaml
description: Stable-key behavior shared by TypeScript and Python.
functions:
  toStableKey:
    tests:
      - name: stable null
        args: [null]
        expected: "null"
```

Top-level `tests` can explicitly select or override a target. `module` and
`path` accept either one shared string or a `{ typescript, python }` mapping.
This makes one-off exports and reorganized package layouts possible without
adding code to either runner:

```json
{
  "tests": [
    {
      "name": "explicit target",
      "module": {
        "typescript": "@dbx-tools/shared-core",
        "python": "dbx_tools.core"
      },
      "path": {
        "typescript": "string.toIdentifier",
        "python": "to_identifier"
      },
      "args": ["myApp"],
      "expected": "my-app"
    }
  ]
}
```

`invoke` adapts options passed first in TypeScript or as Python keyword
arguments. The `value` mode reads a constant instead of calling a function.
`result` can normalize Python snake-case object keys to camel case. Every suite
should have a concise `description`; add function or test descriptions where the
name alone does not explain the compatibility rule. See `schema.json` for the
complete fixture contract.

The harness uses native Bun and uv rather than Pyodide so tests exercise the
same runtimes and package-resolution paths used in production. Runtime-specific
behavior remains in each package's native test suite.
