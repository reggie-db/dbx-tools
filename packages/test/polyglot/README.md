# Polyglot parity tests

Private workspace package for contracts implemented in more than one dbx-tools
runtime. Shared JSON fixtures are executed by one generic TypeScript runner and
one generic Python runner, then compared both to the expected output and to each
other.

The harness deliberately uses native Bun and uv instead of Pyodide. That keeps
the test on the same runtimes and package-resolution paths used in production;
Pyodide remains a good future option for contracts that specifically need
browser/WASM Python coverage.

```bash
bun run --filter @dbx-tools/test-polyglot test
```

`fixtures/modules.json` is the only runtime mapping. Each logical root names its
TypeScript and Python modules, then maps shared function names to the actual
export paths in each language. A contract fixture only needs:

- `root` — one entry from `modules.json`;
- `cases[].function` — a shared function name under that root;
- `args` and optional `options`;
- `expected`, or `error` for an expected exception type.

The generic parity test discovers every other JSON file in `fixtures/`
automatically, so adding a contract needs no TypeScript or Python test code.
`pgaddress.json` owns Lakebase/Postgres address cases, `channel.json` owns the
Postgres channel-name contract, and `core-identity.json` owns FNV, stable-key,
and identifier behavior. Runtime-specific cases that cannot cross the fixture
boundary remain in their native package suites.
