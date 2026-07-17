# @dbx-tools/databricks

Generic Node-side Databricks workspace and cloud infrastructure helpers.

Import this package when backend code needs workspace URL/id discovery, cloud
provider/region lookup, DNS resolution, or public-IP discovery without requiring
an AppKit plugin runtime.

Key features:

- Workspace URL and numeric workspace id resolution from AppKit context,
  Databricks SDK config, env, and config files.
- Cloud provider/region detection by resolving workspace hosts against public
  AWS, Azure, and GCP IP feeds.
- In-process and on-disk caching for cloud IP range feeds.
- DNS A/AAAA lookup helpers for Databricks and adjacent service hosts.
- Memoized outbound public-IP discovery for setup and diagnostics.

## Resolve Workspace Identity

```ts
import { workspace } from "@dbx-tools/databricks";

const url = await workspace.getWorkspaceUrl();
const id = await workspace.getWorkspaceId();
```

`workspace.getWorkspaceUrl()` checks the active AppKit execution context when
present, then a default Databricks SDK client, then environment/config. Use it in
libraries that should work inside an AppKit request and from a standalone
script.

## Detect Cloud Provider And Region

```ts
import { cloud } from "@dbx-tools/databricks";

const location = await cloud.resolveCloudLocation("https://adb-123.azuredatabricks.net");
```

`cloud.resolveCloudLocation()` DNS-resolves the workspace host and matches its
IPs against AWS, Azure, and GCP public range feeds. Feeds are cached on disk and
in process for 24 hours. Use this when constructing region-specific service URLs
or routing workspace-adjacent traffic.

Cloud detection is best-effort. It is intended for endpoint construction and
developer diagnostics, not for security policy decisions.

## Resolve Network Details

```ts
import { net } from "@dbx-tools/databricks";

const ips = await net.resolveHostIps("https://example.cloud.databricks.com");
const publicIp = await net.getPublicIp();
```

`net.resolveHostIps()` accepts the same URL-like values as
`@dbx-tools/shared-core` `net.urlBuilder()`. `net.getPublicIp()` is memoized for
short-lived reuse.

## Modules

- `workspace` - workspace URL and numeric id resolution.
- `cloud` - provider/region detection from public cloud IP ranges.
- `net` - DNS A/AAAA resolution and outbound public-IP discovery.

Zerobus endpoint construction builds on these helpers in
[`@dbx-tools/databricks-zerobus`](../databricks-zerobus).
