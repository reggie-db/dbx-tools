# @dbx-tools/fs

Node local-disk `FileSystem` implementation of the `@dbx-tools/shared-fs`
contract. Built on `BaseFileSystem`, so this package only owns host separator
conversion (`toBackendPath`), Node I/O, symlink containment (`preparePath`), and
errno mapping.

Key features:

- Contained-by-default path resolution under a configured root
- `~` / `~/...` roots expand via `os.homedir()` (before `HOME`), then
  Databricks App `/home/app`, then a created `./.home` (create failures skip)
- Temp dirs via `os.tmpdir()` then `TMPDIR` / `TMP` / `TEMP`, else
  `<home>/.tmp` (each candidate must pass a write/delete probe)
- Read/write/append/copy/move plus mkdir/rmdir/readdir/stat/exists
- Optional read-only mode
- Native append / copy / rename via Node when available
- Cross-process serialization for concurrent rebuilds of the same stable temp tree

## Why Use This Over Native Node fs

Use this when callers should speak the portable `FileSystem` interface (the same
surface FTP, object storage, or Databricks mounts can implement) rather than
Node APIs directly. Reach for `node:fs` when you only need one-off local I/O.

## Quick Start

```ts
import { LocalFileSystem, localFS } from "@dbx-tools/fs";

const local = new LocalFileSystem({ root: "./data" });
await local.init();
await local.writeFile("hello.txt", "hi");

const home = localFS.homeFS("projects/data");
const scratch = localFS.tmpFS("job-42");

// A throwaway working directory no other run can collide with.
const work = localFS.scratchFS("import-job");
await work.init(); // only needed when handing the root to `node:fs` or a subprocess

// Regenerate on every boot, but into ONE stable directory: the callback writes
// into a scratch root that replaces the stable one only on success, so restarts
// don't pile up directories, a failed rebuild keeps the last good tree, and
// concurrent rebuilds of the same key are serialized across processes.
const skills = await localFS.rebuildFS("agent-skills", (scratch) => downloadInto(scratch.root));
```

## Modules

| Export                             | Role                                                   |
| ---------------------------------- | ------------------------------------------------------ |
| `LocalFileSystem`                  | Local-disk `FileSystem<"local">`                       |
| `LocalFileSystemOptions`           | Constructor options                                    |
| `localFS.homeFS` / `localFS.tmpFS` | `LocalFileSystem` under resolved home / temp           |
| `localFS.scratchFS`                | `tmpFS` on a `<prefix>-<id>` root unique per call      |
| `localFS.rebuildFS`                | Serialized stable temp rebuild via atomic scratch swap |
| `osPath.resolveLocalHome`          | Home: `homedir` → `HOME` → `/home/app` → `./.home`     |
| `osPath.resolveLocalTemp`          | Temp: `tmpdir` → `TMPDIR`/`TMP`/`TEMP` → `<home>/.tmp` |
| `localPath.expandLocalHomePath`    | Expand `~` against a home dir                          |

Adjacent: `@dbx-tools/shared-fs` (`FileSystem` contract + `BaseFileSystem`).
