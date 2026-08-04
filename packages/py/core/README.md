# `dbx-tools-core`

Dependency-free Python configuration and identity helpers shared by dbx-tools
packages.

Install from PyPI:

```bash
pip install dbx-tools-core
```

To install the current `main` branch directly from the repository instead:

```bash
pip install "dbx-tools-core @ git+https://github.com/reggie-db/dbx-tools.git@main#subdirectory=packages/py/core"
```

## Key features

- `config.text()` resolves scoped keys from the process environment, then the
  nearest project `.env` file, then validated Databricks bundle JSON.
- `.env.<NODE_ENV>` wins over `.env`, with `production`/`prod` and
  `development`/`dev` treated as aliases.
- Bundle validation stays lazy: the Databricks CLI runs only after environment
  and dotenv lookup miss. Dotenv files and bundle results are each loaded once
  per resolved working-directory context.
- Deployed Databricks Apps skip local files and bundle validation because the
  platform has already populated real environment variables.
- `DBX_TOOLS_DATABRICKS_APP_ENV=true` or `false` forces Databricks App runtime
  detection; absent or unrecognized values retain automatic detection.
- `DBX_TOOLS_CONFIG_DOTENV` and `DBX_TOOLS_CONFIG_BUNDLE` independently force
  each local source on or off, overriding the usual deployed-App skip.
- Bundle reads default off when `NODE_ENV=production` unless
  `DBX_TOOLS_CONFIG_BUNDLE=true` explicitly enables them.
- String, boolean, positive-number, positive-integer, and list helpers use the
  same loose configuration coercions as `@dbx-tools/core`.
- Stable-key, FNV hash, and identifier functions preserve deterministic Node and
  Python identity contracts.

## Quick start

```python
from dbx_tools.core import config

host = config.text("HOST", {"prefix": "SMTP"})
port = config.positive_int(None, "PORT", 587, {"prefix": "SMTP"})
```

The default key order for `HOST` with prefix `SMTP` is
`DBX_TOOLS_SMTP_HOST`, `SMTP_HOST`, then `HOST`. Pass `config.ENV_ONLY` when a
caller must read the exact process environment without local file fallbacks.
`config.is_databricks_app_env()` validates the App name, HTTP(S) workspace host,
and TCP port unless `config.DATABRICKS_APP_ENV_KEY` names a recognized boolean
override in the environment.
`config.CONFIG_DOTENV_KEY` and `config.CONFIG_BUNDLE_KEY` name the equivalent
per-source overrides. Recognized booleans win; absent or unrecognized values
read files outside a Databricks App and skip them inside one. Bundle validation
also stays off by default in production.

## Modules

- `config` — layered environment, dotenv, and Databricks bundle configuration;
- `hash.fnv_hash()` — the single-string subset of TypeScript
  `fnvHashWithOptions`, including UTF-16 code-unit hashing and base-32 output;
- `object.to_stable_key()` — strict structured identity canonicalization;
- `string.to_identifier()` — readable identifier tokenization, with the same
  hyphen default as TypeScript and an explicit delimiter override for consumers
  such as the underscore-delimited Postgres bus channel.

The identity functions exist so Python packages do not copy the TypeScript
algorithms locally and silently drift. Their shared behavior is tested from
`packages/test/polyglot/fixtures/core/fixture.json`. Configuration precedence,
dotenv discovery/parsing, bundle fallback, laziness, and cache behavior are
shared fixtures under `packages/test/polyglot/fixtures/core/config`.
