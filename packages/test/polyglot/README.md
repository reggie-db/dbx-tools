# Polyglot parity tests

Private workspace package for contracts implemented in more than one dbx-tools
runtime. Shared JSON or YAML fixtures are executed by generic TypeScript and
Python runners, then compared both to their expected output and to each other.

```bash
bun run --filter @dbx-tools/test-polyglot test
```

## Fixture layout

The test recursively discovers `fixture.json`, `fixture.yaml`, `fixture.yml`, and
files named `*.fixture.<format>` below `fixtures/`. Contract-specific TypeScript
or Python runner code is not needed.

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
arguments. `result` can normalize Python snake-case object keys to camel case.
See `schema.json` for the complete fixture contract.

The harness uses native Bun and uv rather than Pyodide so tests exercise the
same runtimes and package-resolution paths used in production. Runtime-specific
behavior remains in each package's native test suite.
