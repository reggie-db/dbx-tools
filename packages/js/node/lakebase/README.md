# @dbx-tools/lakebase

Node-native Lakebase connection primitives shared by AppKit and the local
PostgreSQL proxy.

```ts
import { LakebaseClient, parseAddress } from "@dbx-tools/lakebase";

const client = new LakebaseClient();
const resolved = await client.resolve(parseAddress("projects/example"));
const password = await client.generateDatabaseCredential(resolved.endpoint);
```

The package accepts PostgreSQL URLs, canonical project/branch/endpoint/database
resource paths, endpoint hostnames, and project IDs. Discovery follows paginated
Lakebase APIs, excludes inactive resources, selects usable defaults, caches
resolved metadata for 30 seconds, and caches authenticated Databricks sessions
for ten minutes. Database credentials are generated for each upstream
connection and are never persisted by this package.

A PostgreSQL startup user is treated as a Databricks profile only when it names
a configured profile. An explicitly configured profile always wins, and
Databricks App runtimes retain automatic App authentication.
