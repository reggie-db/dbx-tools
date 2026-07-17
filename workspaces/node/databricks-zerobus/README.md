# @dbx-tools/node-databricks-zerobus

Region-aware Zerobus ingest helpers for Databricks workspaces.

Import this package when Node code needs to create a Zerobus SDK client and open
an ingest stream without hand-building the region-specific Zerobus endpoint.

Key features:

- Databricks workspace URL/id discovery through
  [`@dbx-tools/node-databricks`](../databricks).
- Cloud/region-aware Zerobus endpoint construction.
- Credential lookup with Zerobus-prefixed env vars and Databricks client-id
  fallbacks.
- Thin wrapper around the Zerobus SDK so callers can still use SDK-native stream
  methods after setup.

## Create A Zerobus SDK Client

```ts
import { zerobus } from "@dbx-tools/node-databricks-zerobus";

const sdk = await zerobus.createSdk();
```

`createSdk()` resolves the current Databricks workspace URL/id, detects its cloud
region through [`@dbx-tools/node-databricks`](../databricks), and constructs the
Zerobus endpoint for that region.

## Open An Ingest Stream

```ts
const stream = await zerobus.createStream(sdk, "main.default.events");

await stream.ingestRecord({
  id: crypto.randomUUID(),
  event_type: "clicked",
  created_at: new Date().toISOString(),
});
```

`createStream()` reads `ZEROBUS_DATABRICKS_CLIENT_ID` /
`ZEROBUS_DATABRICKS_CLIENT_SECRET`, falling back to unprefixed
`DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET`. Use the prefixed variables
when the app uses separate credentials for Zerobus ingestion.

This package does not model records or topics. It only resolves the correct SDK
client and stream endpoint, then leaves ingestion semantics to Zerobus.

## Module

- `zerobus` - `createSdk()` and `createStream()`.

This package has no AppKit dependency. Workspace and cloud detection are
delegated to [`@dbx-tools/node-databricks`](../databricks).
