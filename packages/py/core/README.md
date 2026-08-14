# `dbx-tools-core`

Dependency-free Python configuration, identity, and mise-backed executable
helpers shared by dbx-tools packages.

Install from PyPI:

```bash
pip install dbx-tools-core
```

To install the current `main` branch directly from the repository instead:

```bash
pip install "dbx-tools-core @ git+https://github.com/reggie-db/dbx-tools.git@main#subdirectory=packages/py/core"
```

## Key features

- `config.text()` resolves scoped keys from constant `data`, the process
  environment, the nearest project `.env` file, the single App's `config.env`
  in validated Databricks bundle JSON, then `app.yaml` / `app.yml` env values. Root
  bundle `variables` are not a config source: they
  are authoring inputs interpolated into the bundle's own targets, resources, and
  paths, so reading one as a process setting resolves names the deployed App
  never sees. Reference a variable from `config.env` to make it one.
- `.env.<NODE_ENV>` wins over `.env`, with `production`/`prod` and
  `development`/`dev` treated as aliases.
- Bundle validation stays lazy: the Databricks CLI runs only after environment
  and dotenv lookup miss; app YAML runs only after bundle lookup misses. Parsed
  dotenv records are cached by file path, bundle output by bundle path plus
  Databricks profile, and app YAML by app path. Bundle `value_from` and App YAML
  `valueFrom` references resolve supported values from named resources.
  Config-file discovery and parsed results are single-attempt per source key:
  found paths, missing files, empty records, invalid records, and `None` results
  all cache.
- Deployed Databricks Apps skip local files and bundle validation because the
  platform has already populated real environment variables.
- `DBX_TOOLS_DATABRICKS_APP_ENV=true` or `false` forces Databricks App runtime
  detection; absent or unrecognized values retain automatic detection.
- `DBX_TOOLS_CONFIG_DOTENV`, `DBX_TOOLS_CONFIG_BUNDLE`, and
  `DBX_TOOLS_CONFIG_APP` independently force each local source on or off,
  overriding the usual deployed-App skip.
- Bundle reads default off when `NODE_ENV=production` unless
  `DBX_TOOLS_CONFIG_BUNDLE=true` explicitly enables them.
- String, boolean, positive-number, positive-integer, and list helpers use the
  same loose configuration coercions as `@dbx-tools/core`.
- Stable-key, FNV hash, and identifier functions preserve deterministic Node and
  Python identity contracts.
- `bin.resolve()` reuses executables from `PATH`, otherwise performs a
  check-lock-check mise installation and returns the path reported by
  `mise which`.
- `bin.execute()` has the `asyncio.create_subprocess_exec` calling convention,
  adds only `mise_tool=`, and returns the native `asyncio.subprocess.Process`.
  If mise itself is missing on macOS or Linux, the official checksum-verifying
  installer is run under the same cross-process lock.

## Quick start

```python
from dbx_tools.core import config

host = config.text("HOST", {"prefix": "SMTP"})
port = config.positive_int(None, "PORT", 587, {"prefix": "SMTP"})
endpoint = config.resolve_value(
    "lakebaseEndpoint",
    {
        "data": {"LAKEBASE_ENDPOINT": flags.endpoint},
        "sources": ["env", "dotenv", "bundle", "app"],
    },
)
```

Mise-backed async subprocesses retain the standard library process API:

```python
import asyncio

from dbx_tools.core import bin

process = await bin.execute(
    "uv",
    "--version",
    mise_tool="uv@0.11",
    stdout=asyncio.subprocess.PIPE,
)
stdout, _ = await process.communicate()
```

Use `bin.ensure_tool("neo4j@5.26.12").root` when a caller needs an installed
tool directory rather than one executable.

The default key order for `HOST` with prefix `SMTP` is
`DBX_TOOLS_SMTP_HOST`, `SMTP_HOST`, then `HOST`. Pass `config.ENV_ONLY` when a
caller must read the exact process environment without local file fallbacks.
Constant `data` is first by default. If custom `sources` omit `config`, passed
data is still read and appended last, as in the environment-first example.
`resolve_value()` tries exact, uppercase, and tokenized-uppercase names through
the same scope and prefix rules.
`config.is_databricks_app_env()` validates the App name, HTTP(S) workspace host,
and TCP port unless `config.DATABRICKS_APP_ENV_KEY` names a recognized boolean
override in the environment.
`config.CONFIG_DOTENV_KEY`, `config.CONFIG_BUNDLE_KEY`, and
`config.CONFIG_APP_KEY` name the equivalent per-source overrides. Recognized
booleans win; absent or unrecognized values read files outside a Databricks App
and skip them inside one. Bundle validation also stays off by default in
production.

## Modules

- `bin` — locked mise bootstrap, tool installation, executable resolution, and
  native asyncio subprocess creation;
- `config` — layered environment, dotenv, Databricks bundle, and app YAML configuration;
- `hash.fnv_hash()` — the single-string subset of TypeScript
  `fnvHashWithOptions`, including UTF-16 code-unit hashing and base-32 output;
- `object.to_stable_key()` — strict structured identity canonicalization;
- `string.to_identifier()` — readable identifier tokenization, with the same
  hyphen default as TypeScript and an explicit delimiter override for consumers
  such as the underscore-delimited Postgres bus channel.

The identity functions exist so Python packages do not copy the TypeScript
algorithms locally and silently drift. Their shared behavior is exercised by
colocated `polygotTest` callbacks in the owning TypeScript packages.
Configuration precedence, dotenv discovery/parsing, bundle fallback, laziness,
and parsed-record caching are covered by each runtime's native config tests.
