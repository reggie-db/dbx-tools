# `dbx-tools-postgres`

Python Lakebase/Postgres connection setup for services that already hold a
Databricks `WorkspaceClient`. This package is currently an unpublished workspace
package.

Key features:

- accepts the same Postgres URI, Lakebase resource path, hostname, and project-id
  address shapes as `@dbx-tools/appkit`;
- resolves missing autoscaling endpoint fields through
  `WorkspaceClient.api_client`;
- resolves provisioned Lakebase instance DNS through
  `WorkspaceClient.database`;
- injects a fresh database credential on SQLAlchemy's `do_connect` event rather
  than storing an expiring password in the engine URL, using the SDK's
  provisioned-instance API or the Autoscaling `/postgres/credentials` endpoint;
- supports sync psycopg and asyncpg SQLAlchemy engines.

```python
from databricks.sdk import WorkspaceClient
from dbx_tools.postgres import PostgresEngineConfig, create_async_engine

engine = create_async_engine(
    WorkspaceClient(),
    PostgresEngineConfig(instance_name="my-lakebase", database="databricks_postgres"),
    pool_pre_ping=True,
    pool_recycle=1800,
)
```

Pass `credential_provider=` to either engine factory to inject credentials from
another source while retaining the same connect-time rotation behavior.
