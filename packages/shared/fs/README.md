# `@dbx-tools/shared-fs`

Browser-safe filesystem contract and abstract base for rooted storage backends.

Key features:

- Portable `FileSystem` interface (read/write/append/copy/move, mkdir/rmdir/readdir/stat/exists)
- `BaseFileSystem` root accepts one or many segments (`"/path"`, objects →
  FNV hash, `true`/`1` stringified); strings are split on `/` and only a
  component that _cannot_ be a path component (separator, NUL / control
  character, or `..`) is FNV-hashed, so real names like
  `/Workspace/Users/me@corp.com/My Notes` survive intact
- `BaseFileSystem` so a new backend mostly implements `*At` primitives: memoized `_init`, optional `createRoot`, `toBackendPath`, parent creation before write/append/copy/move, POSIX-only paths, encoding, recursive mkdir/rmdir/readdir, and append/copy/move fallbacks
- Every primitive is invoked through a guard that routes failures to a
  `mapError` hook, so an adapter writes no try/catch of its own and cannot
  return an unnormalized error
- `MemoryFileSystem` in-process adapter for tests and as a reference implementation
- `baseFS.mapFileSystemError` / `baseFS.inferFileSystemErrorCode` on
  `@dbx-tools/shared-core` `error` helpers
- `posixPath` helpers that convert roots/joins to `/`-separated form
  (`posixPath.toPosix`, `posixPath.join`, …)
- Typed `FileSystemError` codes for portable failure handling

## Why use this

Use this when multiple backends (local disk, object storage, Databricks volumes, in-memory) should share one API. Node hosts implement concrete adapters such as `@dbx-tools/fs` (`LocalFileSystem`).

## Quick start

```ts
import type { FileSystem } from "@dbx-tools/shared-fs";
import { BaseFileSystem, FileSystemError, MemoryFileSystem, posixPath } from "@dbx-tools/shared-fs";

const mem = new MemoryFileSystem();
await mem.writeFile("note.txt", "hi");
```

## Module map

| Export                                   | Role                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `FileSystem`                             | Portable filesystem contract                               |
| `BaseFileSystem`                         | Abstract base over `*At` primitives; memoized `_init`      |
| `baseFS.normalizeFileSystemRoot`         | Join root segments (stringify / FNV-hash)                  |
| `FileSystemRootInput`                    | `root` option: one or many non-null segments               |
| `MemoryFileSystem`                       | In-memory adapter (tests / reference)                      |
| `baseFS.mapFileSystemError`              | Wrap backend failures into `FileSystemError`               |
| `baseFS.inferFileSystemErrorCode`        | Infer a code from HTTP status / message tokens             |
| `posixPath`                              | POSIX root/join/normalize helpers for namespace paths      |
| `posixPath.isHomeRelativePath`           | `~` / `~/...` detection, shared by every adapter           |
| `posixPath.expandHome`                   | Expand `~` against a home, with a pluggable join           |
| `posixPath.toRelativeSegment`            | Strip leading `~` / separators so input joins UNDER a base |
| `FileSystemError`                        | Typed filesystem failure                                   |
| `FileEntry` / `FileStat` / options types | Shared wire shapes                                         |

Adjacent: `@dbx-tools/fs` (local disk adapter).
