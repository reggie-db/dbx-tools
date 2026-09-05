# @dbx-tools/databricks

Databricks runtime, workspace, filesystem, cloud, and network utilities.

Import this package when backend code needs workspace URL/id discovery, cloud
provider/region lookup, App runtime detection, DNS resolution, or public-IP
discovery without requiring an AppKit plugin runtime.

Key features:

- Workspace URL and numeric workspace id resolution from AppKit context,
  Databricks SDK config, env, and config files.
- Rust-backed Databricks App detection shared with authentication providers.
- Cached detection of whether the Databricks CLI auth surface is available.
- `DatabricksFileSystem` (`FileSystem` over workspace files, UC volumes, and DBFS)
  with intelligent roots: `/Workspace/...`, `/Volumes/...` (also `/Volume/...` and
  `catalog.schema.volume`), `~` → `/Workspace/Users/<userName>`, and `/dbfs/...`.
- `tryGetWorkspaceClient` / `getWorkspaceClient` / `getCurrentUserName` for client
  and home-path resolution.
- Cloud provider/region detection by resolving workspace hosts against public
  AWS, Azure, and GCP IP feeds.
- In-process and on-disk caching for cloud IP range feeds.
- DNS A/AAAA lookup helpers for Databricks and adjacent service hosts.
- Memoized outbound public-IP discovery for setup and diagnostics.

## Detect The Runtime

```ts
import { databricksCliAvailable, isDatabricksApp } from "@dbx-tools/databricks";

const inApp = isDatabricksApp();
const hasDatabricksAuth = databricksCliAvailable();
```

`isDatabricksApp()` honors `DBX_TOOLS_DATABRICKS_APP_ENV`, then requires a
valid `DATABRICKS_APP_NAME`, HTTP(S) `DATABRICKS_HOST`, and
`DATABRICKS_APP_PORT`. `databricksCliAvailable()` caches whether
`databricks auth --help` succeeds for the process. The generated bindings and
the package's direct TypeScript modules share this package root.

## Relationship To Native AppKit

Use native AppKit for its standard workspace client and plugin integrations.
Use this package when code also needs App detection shared with Rust,
Databricks filesystem root normalization, cloud region discovery, network
helpers, or workspace identity fallbacks outside an AppKit request.

## Databricks filesystem

```ts
import { DatabricksFileSystem } from "@dbx-tools/databricks";

// Unity Catalog volume via three-part id
const volume = new DatabricksFileSystem({ root: "main.default.assets" });
await volume.writeFile("notes/hello.txt", "hi");

// Workspace home (resolves ~ via currentUser.me / AppKit userName)
const home = await DatabricksFileSystem.create({ root: "~" });
const entries = await home.readdir(".");
```

Roots are normalized before use:

| Input                                                       | Normalized root                   | API       |
| ----------------------------------------------------------- | --------------------------------- | --------- |
| `catalog.schema.volume`                                     | `/Volumes/catalog/schema/volume`  | UC Files  |
| `/Volume/...`                                               | `/Volumes/...`                    | UC Files  |
| `~` / `~/...`                                               | `/Workspace/Users/<userName>/...` | Workspace |
| `/Workspace/...`, `/Users/...`, `/Repos/...`, `/Shared/...` | unchanged (POSIX)                 | Workspace |
| `/dbfs/...`                                                 | unchanged (POSIX)                 | DBFS      |

`~` expansion uses `getCurrentUserName()` (AppKit context `userName`, else
`currentUser.me()` via `tryGetWorkspaceClient` / `getWorkspaceClient`). Prefer
`DatabricksFileSystem.create({ root: "~" })` when the username is not known up
front.

Built on `@dbx-tools/shared-fs` `BaseFileSystem`, so portable behavior (parents,
recursion, encoding, error mapping) is shared with `LocalFileSystem` /
`MemoryFileSystem`.

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

- `databricks-fs` / `databricks-path` - rooted `FileSystem` over workspace / volumes / DBFS.
- `workspace` - workspace URL/id, `tryGetWorkspaceClient` / `getWorkspaceClient`, and current username.
- `cloud` - provider/region detection from public cloud IP ranges.
- `net` - DNS A/AAAA resolution and outbound public-IP discovery.
- package root - Rust-backed `isDatabricksApp` and
  `databricksCliAvailable`.

Zerobus endpoint construction builds on these helpers in
[`@dbx-tools/databricks-zerobus`](../databricks-zerobus).
