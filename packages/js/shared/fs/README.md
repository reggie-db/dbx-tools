# @dbx-tools/shared-fs

Use one filesystem contract across memory, local disk, Unity Catalog volumes,
and other rooted storage backends. This browser-safe package provides the
portable `FileSystem` interface, `BaseFileSystem`, normalized errors, path
helpers, caching, and an in-memory adapter.

## Quick start

```ts
import { MemoryFileSystem } from "@dbx-tools/shared-fs";

const files = new MemoryFileSystem();
await files.writeFile("note.txt", "ready");
```

The filesystem contract covers:

- Portable `FileSystem` interface for read, write, append, copy, move, directory,
  stat, and existence operations.
- `BaseFileSystem` roots accept one or many segments. Objects are FNV-hashed,
  and `true` and `1` are stringified. Strings are split on `/`, and only a
  component that _cannot_ be a path component (separator, NUL / control
  character, or `..`) is FNV-hashed, so real names like
  `/Workspace/Users/me@corp.com/My Notes` survive intact.
- `BaseFileSystem` lets a new backend implement mostly `*At` primitives. It
  provides memoized `_init`, optional `createRoot`, `toBackendPath`, parent
  creation before mutations, POSIX-only paths, encoding, recursive directory
  operations, and append, copy, and move fallbacks.
- Every primitive is invoked through a guard that routes failures to a
  `mapError` hook, so an adapter writes no try/catch of its own and cannot
  return an unnormalized error.
- `MemoryFileSystem` in-process adapter for tests and reference implementations.
- `baseFS.mapFileSystemError` / `baseFS.inferFileSystemErrorCode` on
  `@dbx-tools/shared-core` error helpers.
- `posixPath` helpers that convert roots/joins to `/`-separated form
  (`posixPath.toPosix` and `posixPath.join`).
- Typed `FileSystemError` codes for portable failure handling.
- Lazy debug logs for every public filesystem operation. Set
  `LOG_LEVEL=debug`. Operation metadata is not constructed at normal log levels.
- `cache()` read-through decorator with automatic mutation invalidation.
  `exists`, `readdir`, and `stat` are cached by default. Other methods delegate
  directly unless selected explicitly. Cache owners expose `keys()` so
  directory move/delete operations can invalidate related ancestor and
  descendant entries. `read`, `invalidate`, and `keys` may be synchronous or
  asynchronous. Keys use `<stable-hash>_<canonical-rooted-backend-path>`.

## Choose a runtime

Use this package when several backends must implement the same API. Browser
code can use the contracts, path helpers, cache decorator, and
`MemoryFileSystem`. Node hosts provide concrete adapters such as
[@dbx-tools/fs](../../node/fs), including `LocalFileSystem`.

## Use cache and backend helpers

```ts
import type { FileSystem, FileSystemCache } from "@dbx-tools/shared-fs";
import {
  BaseFileSystem,
  FileSystemError,
  fs,
  MemoryFileSystem,
  posixPath,
} from "@dbx-tools/shared-fs";

const mem = new MemoryFileSystem();
await mem.writeFile("note.txt", "hi");
const cached = fs.cache(mem, myCache satisfies FileSystemCache);
await cached.stat("note.txt");

const selected = fs.cache(mem, myCache, {
  operations: ["readFile", "readdir"],
  filter: (operation, path) => operation === "readdir" || path.startsWith("/skills/"),
});
```

The default caches `exists`, `readdir`, and `stat`. `filter` receives the
operation and normalized absolute path, so an owning package can compile its
own glob or authorization policy without adding a path-matcher dependency here.

## Package exports

| Export                                   | Role                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `FileSystem`                             | Portable filesystem contract                               |
| `BaseFileSystem`                         | Abstract base over `*At` primitives with memoized `_init`  |
| `baseFS.normalizeFileSystemRoot`         | Join root segments (stringify / FNV-hash)                  |
| `FileSystemRootInput`                    | `root` option: one or many non-null segments               |
| `MemoryFileSystem`                       | In-memory adapter (tests / reference)                      |
| `memoryFS`                               | The module behind it, if a subclass needs its internals    |
| `baseFS.mapFileSystemError`              | Wrap backend failures into `FileSystemError`               |
| `baseFS.inferFileSystemErrorCode`        | Infer a code from HTTP status / message tokens             |
| `posixPath`                              | POSIX root/join/normalize helpers for namespace paths      |
| `posixPath.isHomeRelativePath`           | `~` / `~/...` detection, shared by every adapter           |
| `posixPath.expandHome`                   | Expand `~` against a home, with a pluggable join           |
| `posixPath.toRelativeSegment`            | Strip leading `~` / separators so input joins under a base |
| `FileSystemError`                        | Typed filesystem failure                                   |
| `FileEntry` / `FileStat` / options types | Shared data types                                          |
