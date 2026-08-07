# Polyglot parity tests

Private workspace package for contracts implemented in more than one dbx-tools
runtime. Pure deterministic contracts run in their owning TypeScript package
through the Bun-native `./polyglot` helper, which invokes the Python equivalent
through embedded CPython. Runtime-specific and process-isolated behavior remains
in each owning package's native tests.

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

## Runtime

The helper uses Bun and embedded CPython rather than Pyodide so tests exercise
the same package-resolution paths used in production. Set `BUN_PYTHON_PATH` when
the compatible Python shared library cannot be discovered automatically.
