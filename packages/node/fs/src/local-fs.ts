/**
 * Host-local {@link FileSystem} backed by Node's `node:fs/promises`.
 *
 * Extends {@link BaseFileSystem} so this module only owns Node I/O, host path
 * conversion, and symlink containment. Portable behavior (encoding, recursion,
 * parent creation, fallbacks, POSIX namespace paths) lives in `@dbx-tools/shared-fs`.
 *
 * @module
 */

import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { hash } from "@dbx-tools/shared-core";
import {
  BaseFileSystem,
  baseFS,
  FileSystemError,
  posixPath,
  type CopyOptions,
  type FileEntry,
  type FileEntryType,
  type FileStat,
  type FileSystemErrorCode,
  type WriteFileOptions,
} from "@dbx-tools/shared-fs";
import { resolveLocalRoot } from "./local-path.ts";
import { resolveLocalHome, resolveLocalTemp, type ResolveOsPathsOptions } from "./os-path.ts";

/** Options for {@link LocalFileSystem}. */
export interface LocalFileSystemOptions {
  /** Unique identifier. Defaults to a stable hash of the absolute root. */
  id?: string;

  /**
   * Root directory on disk. Relative paths resolve against `process.cwd()`.
   * `~` / `~/...` expand via `os.homedir()` (before `HOME`), App `/home/app`,
   * or a created `./.home` (create failures skip).
   * Stored on {@link LocalFileSystem.root} in POSIX form.
   */
  root: string;

  /** Block all write operations. Defaults to false. */
  readOnly?: boolean;

  /**
   * Keep every resolved path under {@link root}. Defaults to true.
   * When false, absolute input paths are accepted as-is (no sandbox).
   */
  contained?: boolean;

  /**
   * Create {@link root} (and parents) during init. Defaults to true.
   */
  createRoot?: boolean;

  /**
   * Injectables forwarded to {@link resolveLocalRoot} for `~` expansion (home /
   * temp / cwd overrides). Mainly for tests: bun's `os.homedir()` ignores a
   * process-set `HOME`, so overriding home via `{ os: { homeDir } }` is the
   * runtime-agnostic way to point a `~` root at a chosen directory.
   */
  os?: ResolveOsPathsOptions;
}

/**
 * Options for the factories that take their root FROM the OS
 * ({@link homeFS} / {@link tmpFS} / {@link scratchFS}) rather than from the
 * caller: {@link LocalFileSystemOptions} without `root`, plus the
 * {@link resolveOsPaths} injectables.
 */
export type OsFileSystemOptions = Omit<LocalFileSystemOptions, "root">;

/**
 * {@link FileSystem} implementation that stores files in a folder on the local
 * machine.
 *
 * @example
 * ```ts
 * const fs = new LocalFileSystem({ root: "./data" });
 * await fs.init();
 * await fs.writeFile("hello.txt", "hi");
 *
 * const home = new LocalFileSystem({ root: "~/projects/data" });
 * const scratch = tmpFS("my-job");
 * const cache = homeFS(".cache/app");
 * ```
 */
export class LocalFileSystem extends BaseFileSystem<"local"> {
  private readonly contained: boolean;
  /** Symlink-resolved host root, refreshed in {@link onInit}. */
  private realRoot: string;

  constructor(options: LocalFileSystemOptions) {
    const hostRoot = resolveLocalRoot(options.root, options.os);
    const root = posixPath.normalizeRoot(posixPath.toPosix(hostRoot));
    super({
      id: options.id ?? `local-${hash.fnvHash(root)}`,
      backend: "local",
      root,
      readOnly: options.readOnly,
      createRoot: options.createRoot ?? true,
    });
    this.realRoot = this.toBackendPath(root);
    this.contained = options.contained ?? true;
  }

  protected override toBackendPath(posixBackendPath: string): string {
    return posixPath.toHost(posixBackendPath, path.sep);
  }

  protected override async createRootDirectory(): Promise<void> {
    await mkdir(this.toBackendPath(this.root), { recursive: true });
  }

  protected override async onInit(): Promise<void> {
    const hostRoot = this.toBackendPath(this.root);
    if (!this.createRoot) {
      const info = await lstat(hostRoot);
      if (!info.isDirectory()) {
        throw new FileSystemError(
          "NOT_DIRECTORY",
          `Local filesystem root is not a directory: ${this.root}`,
          this.root,
        );
      }
    }
    // Canonicalize so containment checks survive OS root symlinks (e.g. /var -> /private/var).
    this.realRoot = await realpath(hostRoot);
  }

  override resolvePath(inputPath: string): string {
    if (!this.contained) {
      const resolved = path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(this.toBackendPath(this.root), inputPath);
      return this.toBackendPath(posixPath.toPosix(resolved));
    }
    return super.resolvePath(inputPath);
  }

  /**
   * When contained, resolve symlinks and ensure the real path still sits under
   * {@link root}. Missing leaf paths are allowed when `allowMissing` is set so
   * writes can create new files.
   */
  protected override async preparePath(
    resolvedPath: string,
    options?: { allowMissing?: boolean },
  ): Promise<string> {
    if (!this.contained) return resolvedPath;
    try {
      const real = await realpath(resolvedPath);
      if (!isWithinHostRoot(this.realRoot, real)) {
        throw new FileSystemError(
          "PERMISSION_DENIED",
          "Path escapes the filesystem root",
          resolvedPath,
        );
      }
      return resolvedPath;
    } catch (err) {
      if (err instanceof FileSystemError) throw err;
      if (options?.allowMissing && isErrno(err, "ENOENT")) {
        let cursor = path.dirname(resolvedPath);
        while (cursor !== path.dirname(cursor)) {
          try {
            const real = await realpath(cursor);
            if (!isWithinHostRoot(this.realRoot, real)) {
              throw new FileSystemError(
                "PERMISSION_DENIED",
                "Path escapes the filesystem root",
                resolvedPath,
              );
            }
            return resolvedPath;
          } catch (inner) {
            if (inner instanceof FileSystemError) throw inner;
            if (!isErrno(inner, "ENOENT")) throw this.mapError(inner, resolvedPath);
            cursor = path.dirname(cursor);
          }
        }
        return resolvedPath;
      }
      throw this.mapError(err, resolvedPath);
    }
  }

  /** Classify Node errno codes; {@link BaseFileSystem} wraps every primitive. */
  protected override mapError(err: unknown, filePath: string): FileSystemError {
    return baseFS.mapFileSystemError(err, filePath, nodeErrorCode);
  }

  protected override async readBytesAt(resolvedPath: string): Promise<Uint8Array> {
    const buffer = await readFile(resolvedPath);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  protected override async writeBytesAt(
    resolvedPath: string,
    content: Uint8Array,
    options: Required<WriteFileOptions>,
  ): Promise<void> {
    await writeFile(resolvedPath, content, options.overwrite ? undefined : { flag: "wx" });
  }

  protected override async deleteFileAt(resolvedPath: string): Promise<void> {
    await rm(resolvedPath, { force: false });
  }

  protected override async createDirectoryAt(resolvedPath: string): Promise<void> {
    await mkdir(resolvedPath);
  }

  protected override async removeDirectoryAt(resolvedPath: string): Promise<void> {
    await rmdir(resolvedPath);
  }

  protected override async listDirectoryAt(resolvedPath: string): Promise<FileEntry[]> {
    const dirents = await readdir(resolvedPath, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const dirent of dirents) {
      const type = entryType(dirent);
      let size: number | undefined;
      if (type === "file" || type === "symbolic-link") {
        try {
          size = (await lstat(path.join(resolvedPath, dirent.name))).size;
        } catch {
          // Race with concurrent deletes; omit size.
        }
      }
      entries.push(
        size === undefined ? { name: dirent.name, type } : { name: dirent.name, type, size },
      );
    }
    return entries;
  }

  protected override async statAt(resolvedPath: string): Promise<Omit<FileStat, "path">> {
    const info = await lstat(resolvedPath);
    return {
      name: path.basename(resolvedPath) || path.basename(this.toBackendPath(this.root)),
      type: entryType(info),
      size: info.size,
      createdAt: info.birthtime,
      modifiedAt: info.mtime,
      accessedAt: info.atime,
    };
  }

  protected override isNotFoundError(error: unknown): boolean {
    return (
      (error instanceof FileSystemError && error.code === "NOT_FOUND") || isErrno(error, "ENOENT")
    );
  }

  protected override async tryAppendFileAt(
    resolvedPath: string,
    content: Uint8Array,
  ): Promise<boolean> {
    await appendFile(resolvedPath, content);
    return true;
  }

  protected override async tryCopyFileAt(
    sourcePath: string,
    destinationPath: string,
    options: Required<CopyOptions>,
  ): Promise<boolean> {
    await cp(sourcePath, destinationPath, {
      recursive: true,
      force: options.overwrite,
      errorOnExist: !options.overwrite,
    });
    return true;
  }

  protected override async tryMoveFileAt(
    sourcePath: string,
    destinationPath: string,
    options: Required<CopyOptions>,
  ): Promise<boolean> {
    try {
      await rename(sourcePath, destinationPath);
    } catch (err) {
      // Across devices `rename` cannot work; fall back to copy + remove. Any
      // other failure propagates for the base class to map.
      if (!isErrno(err, "EXDEV")) throw err;
      await cp(sourcePath, destinationPath, { recursive: true, force: options.overwrite });
      await rm(sourcePath, { recursive: true, force: true });
    }
    return true;
  }
}

/* ------------------------------ helpers ------------------------------ */

function isWithinHostRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function entryType(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FileEntryType {
  if (entry.isSymbolicLink()) return "symbolic-link";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

/** Node errno -> portable {@link FileSystemErrorCode}. */
const NODE_ERROR_CODES: Readonly<Record<string, FileSystemErrorCode>> = {
  ENOENT: "NOT_FOUND",
  EEXIST: "ALREADY_EXISTS",
  ENOTDIR: "NOT_DIRECTORY",
  EISDIR: "IS_DIRECTORY",
  ENOTEMPTY: "DIRECTORY_NOT_EMPTY",
  EACCES: "PERMISSION_DENIED",
  EPERM: "PERMISSION_DENIED",
};

function nodeErrorCode(err: unknown): FileSystemErrorCode | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code ? NODE_ERROR_CODES[code] : undefined;
}

/**
 * {@link LocalFileSystem} rooted under {@link resolveLocalHome}, with
 * {@link relativeRoot} joined as a relative path (leading `/` / `~` stripped
 * so the result stays under home).
 *
 * @example
 * ```ts
 * const cache = homeFS(".cache/my-app");
 * await cache.writeFile("state.json", "{}");
 * ```
 */
export function homeFS(
  relativeRoot: string = ".",
  options: OsFileSystemOptions = {},
): LocalFileSystem {
  const { os, ...fsOptions } = options;
  return new LocalFileSystem({
    ...fsOptions,
    root: joinUnderBase(resolveLocalHome(os), relativeRoot),
  });
}

/**
 * {@link LocalFileSystem} rooted under {@link resolveLocalTemp}, with
 * {@link relativeRoot} joined as a relative path (leading `/` / `~` stripped
 * so the result stays under temp).
 *
 * @example
 * ```ts
 * const scratch = tmpFS("job-42");
 * await scratch.writeFile("out.bin", bytes);
 * ```
 */
export function tmpFS(
  relativeRoot: string = ".",
  options: OsFileSystemOptions = {},
): LocalFileSystem {
  const { os, ...fsOptions } = options;
  return new LocalFileSystem({
    ...fsOptions,
    root: joinUnderBase(resolveLocalTemp(os), relativeRoot),
  });
}

/**
 * {@link tmpFS} under a root that is unique per call (`<prefix>-<id>`), for a
 * scratch area no other process or run can collide with.
 *
 * Prefer this over minting the id at the call site - it is the one place that
 * decides what a throwaway working directory looks like.
 *
 * @example
 * ```ts
 * const scratch = scratchFS("remote-skills");
 * await scratch.writeFile("SKILL.md", body);
 * ```
 */
export function scratchFS(prefix: string, options: OsFileSystemOptions = {}): LocalFileSystem {
  return tmpFS(`${prefix}-${hash.id()}`, options);
}

/**
 * Rebuild the STABLE temp tree named by {@link key}, every call.
 *
 * {@link materialize} writes into a throwaway {@link scratchFS} root; only on
 * success does that root REPLACE the stable one. Two properties fall out of
 * that ordering, and both are the reason to prefer this over writing into the
 * stable path directly:
 *
 * - repeated runs reuse ONE directory instead of leaving a new scratch behind
 *   on every boot, and
 * - a reader never observes a half-written tree, and a failed rebuild leaves
 *   the previous one intact.
 *
 * The swap is a `rename` within the same temp root, so it is atomic.
 *
 * @param key - Stable temp-relative path. May be nested (`"skills/abc123"`)
 *   to give each input its own directory.
 *
 * @example
 * ```ts
 * const skills = await rebuildFS("agent-skills", (scratch) =>
 *   downloadInto(scratch.root),
 * );
 * ```
 */
export async function rebuildFS(
  key: string,
  materialize: (scratch: LocalFileSystem) => Promise<void>,
  options: OsFileSystemOptions = {},
): Promise<LocalFileSystem> {
  const scratch = scratchFS(key, options);
  await scratch.init();

  try {
    await materialize(scratch);
  } catch (err) {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  const stable = tmpFS(key, options);
  const stableHost = path.resolve(stable.root);
  await rm(stableHost, { recursive: true, force: true });
  await mkdir(path.dirname(stableHost), { recursive: true });
  await rename(path.resolve(scratch.root), stableHost);
  return stable;
}

/**
 * Join {@link relativeRoot} under {@link base}. Empty / `.` keeps {@link base};
 * leading `~` or `/` is stripped so an absolute-looking input cannot escape.
 */
function joinUnderBase(base: string, relativeRoot: string): string {
  const rest = posixPath.toRelativeSegment(relativeRoot);
  return rest ? path.resolve(base, rest) : base;
}
