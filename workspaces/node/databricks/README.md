# @dbx-tools/node-databricks

Generic server-side Databricks + cloud infrastructure with **no AppKit
requirement** - the pieces that need the Databricks SDK, DNS, or cloud metadata
but not the AppKit plugin runtime.

```ts
import { workspace, cloud, net } from "@dbx-tools/node-databricks";

const url = await workspace.getWorkspaceUrl();          // net.UrlBuilder | undefined
const id = await workspace.getWorkspaceId();            // "1234567890..." | undefined
const loc = await cloud.resolveCloudLocation(url!.toString()); // { provider, region }
const ips = await net.resolveHostIps(url!.toString());  // DNS A/AAAA
```

## Modules

- `workspace` - resolve the current workspace URL / numeric id from the AppKit
  execution context (when present), a default `WorkspaceClient`, or the env.
- `cloud` - detect the hyperscaler + region a workspace host lives in, matching
  its resolved IPs against the AWS / GCP / Azure published IP-range feeds (fetched
  and disk-cached for 24h).
- `net` - Node DNS resolution (`resolveHostIps`) + public-IP discovery
  (`getPublicIp`), layered over shared-core's browser-safe `net`.
- `http` - `createFetchError` and header/cookie readers.

AppKit is consumed only for its optional execution-context client (via
[`@dbx-tools/node-appkit`](../appkit)); this package works without an AppKit app.
