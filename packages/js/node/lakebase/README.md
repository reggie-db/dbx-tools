# @dbx-tools/lakebase

Resolve a Databricks Lakebase target into the host, database, and user a
PostgreSQL client needs, then request a short-lived database credential. The
package gives Node and Bun applications one profile-aware path from a project
name or resource URL to connection-ready values. When the target is a Lakebase
path or URL without a chosen database, discovery picks the branch default
(`status.default`, then Lakebase's provisioned `databricks_postgres`) instead of
PostgreSQL's generic `postgres` database.

## Quick Start

```ts
import { LakebaseClient, parseAddress } from "@dbx-tools/lakebase";

const client = new LakebaseClient({ profile: "PROFILE" });
const resolved = await client.resolve(parseAddress("projects/example"));
const password = await client.generateDatabaseCredential(resolved.endpoint);

const connection = {
  host: resolved.host,
  port: resolved.port,
  database: resolved.database,
  user: resolved.user,
  password,
  ssl: { rejectUnauthorized: true },
};
```

Pass the resolved values to `pg`, Drizzle, an ORM, or another PostgreSQL client.
Generate a fresh credential when opening a new upstream connection; this package
does not persist database passwords.

## Choose A Target

`parseAddress()` accepts project IDs, canonical project and branch resources,
endpoint or database resources, endpoint hostnames, and PostgreSQL URLs:

```ts
parseAddress("my-project");
parseAddress("projects/my-project/branches/production");
parseAddress("ep-example.database.cloud.databricks.com");
parseAddress("postgresql://host/database?sslmode=require");
```

Use `requireAddress()` when invalid input should fail immediately. Use
`parseResourcePath()` when the caller must provide a canonical Lakebase resource
path rather than any supported address form.

## Select Authentication

Pass a Databricks profile to `LakebaseClient` when a local application must use
a specific workspace:

```ts
const lakebase = new LakebaseClient({ profile: "PROFILE" });
```

In a Databricks App, ambient app authentication remains available. A startup
user supplied to `resolve()` or `generateDatabaseCredential()` is treated as a
profile only when it exactly matches a configured local profile; an explicit
client profile always wins.

## Build A Proxy URL

`connectionUrl()` formats the local URL expected by
[`@dbx-tools/cli/lakebase-proxy`](../../cli/dbx-tools):

```ts
import { connectionUrl } from "@dbx-tools/lakebase";

connectionUrl("projects/my-project", "localhost", 5432);
// postgresql://localhost:5432/projects/my-project?sslmode=disable
```

## API Reference

- `address` parses supported targets and formats local proxy URLs.
- `client` discovers Lakebase resources and creates database credentials.
