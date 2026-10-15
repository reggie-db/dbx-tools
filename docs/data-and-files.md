# Work with Databricks files and ingestion

Choose native AppKit Files, a portable Databricks filesystem, or Zerobus based
on whether the application serves files, gives an agent a workspace, or ingests
records.

## Choose file access

Use AppKit's Files plugin when application routes or UI components need
governed Unity Catalog volume operations.

Use [`DatabricksFileSystem`](../packages/js/node/databricks/README.md) when a
backend library or Mastra workspace needs the shared `FileSystem` contract over
Workspace files, Unity Catalog volumes, or DBFS.

Use [`LocalFileSystem`](../packages/js/node/fs/README.md) for files on the
application host.

## Read and write a Unity Catalog volume

```ts
import { DatabricksFileSystem } from "@dbx-tools/databricks";

const files = new DatabricksFileSystem({
  root: "main.default.assets",
});

await files.writeFile("reports/latest.txt", "ready");
const report = await files.readFile("reports/latest.txt", { encoding: "utf8" });
```

Three-part volume names normalize to `/Volumes/<catalog>/<schema>/<volume>`.
Workspace paths, user-home paths, and DBFS paths use their corresponding
Databricks APIs.

## Give a Mastra agent file tools

Mount a `FileSystem` through the Mastra workspace when the agent needs to read
or write files during a turn. AppKit's Files plugin remains the better choice
for browser routes and UI components.

Configure approvals through Mastra workspace-tool policy when file mutations
require review.

## Ingest records with Zerobus

Use [`@dbx-tools/databricks-zerobus`](../packages/js/node/databricks-zerobus/README.md)
to resolve the workspace, cloud region, Zerobus endpoint, and credentials:

```ts
import { zerobus } from "@dbx-tools/databricks-zerobus";

const sdk = await zerobus.createSdk();
const stream = await zerobus.createStream(sdk, "main.default.events");

await stream.ingestRecord({
  id: crypto.randomUUID(),
  event_type: "clicked",
  created_at: new Date().toISOString(),
});
```

Use `ZEROBUS_DATABRICKS_CLIENT_ID` and
`ZEROBUS_DATABRICKS_CLIENT_SECRET` when ingestion uses credentials that differ
from the application's Databricks credentials.

The package leaves record schemas, acknowledgements, and retry policy to the
Zerobus SDK.

## Read the package guides

- [`@dbx-tools/databricks`](../packages/js/node/databricks/README.md)
- [`@dbx-tools/databricks-zerobus`](../packages/js/node/databricks-zerobus/README.md)
- [`@dbx-tools/shared-fs`](../packages/js/shared/fs/README.md)
- [`@dbx-tools/fs`](../packages/js/node/fs/README.md)
- [`@dbx-tools/appkit-mastra`](../packages/js/node/appkit-mastra/README.md)
