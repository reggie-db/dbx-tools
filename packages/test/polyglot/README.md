# Polyglot parity tests

Private workspace package for contracts implemented in more than one dbx-tools
runtime. Shared JSON fixtures are executed by separate TypeScript and Python
emitters, then compared both to the expected output and to each other.

The harness deliberately uses native Bun and uv instead of Pyodide. That keeps
the test on the same runtimes and package-resolution paths used in production;
Pyodide remains a good future option for contracts that specifically need
browser/WASM Python coverage.

```bash
bun run --filter @dbx-tools/test-polyglot test
```

`fixtures/pgaddress.json` owns the Lakebase/Postgres address cases.
`fixtures/channel.json` owns Postgres topic-channel identity cases, covering the
shared stable-key, identifier, and FNV rules. Each test fails if either runtime
drifts from the expected output or from its counterpart.
