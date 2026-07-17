# @dbx-tools/node-databricks-zerobus

Thin helpers over `@databricks/zerobus-ingest-sdk`: build a region-aware Zerobus
SDK client for the current workspace and open an ingest stream to a table.

```ts
import { zerobus } from "@dbx-tools/node-databricks-zerobus";

const sdk = await zerobus.createSdk(); // resolves workspace URL/id + cloud region
const stream = await zerobus.createStream(sdk, "main.default.events");
await stream.ingestRecord(record);
```

`createSdk` derives the `https://<workspaceId>.zerobus.<region>.<domain>`
endpoint from [`@dbx-tools/node-databricks`](../databricks) (workspace URL/id +
cloud provider/region). `createStream` reads `ZEROBUS_DATABRICKS_CLIENT_ID` /
`ZEROBUS_DATABRICKS_CLIENT_SECRET` (or the unprefixed `DATABRICKS_*` fallbacks).
No AppKit dependency.
