/**
 * Browser-safe filesystem contracts shared by every dbx-tools storage backend.
 *
 * This module owns portable content, entry, error, option, and lifecycle shapes.
 * Implement new backends against `FileSystem` or `BaseFileSystem`
 * instead of publishing a parallel filesystem interface in another package.
 *
 * @module
 */

import { hash } from "@dbx-tools/shared-core";
import * as posixPath from "./posix-path.ts";

/** Text or binary data accepted by filesystem write operations. */
export type FileContent = string | Uint8Array;

/** Portable kind assigned to a filesystem directory entry. */
export type FileEntryType = "file" | "directory" | "symbolic-link" | "other";

/** Name, kind, size, and optional backend metadata for one directory entry. */
export interface FileEntry {
  name: string;
  type: FileEntryType;
  size?: number;

  /**
   * Provider-specific information that is not part of the
   * portable filesystem contract.
   */
  metadata?: Readonly<Record<string, unknown>>;
}

/** Directory entry enriched with its relative path and available timestamps. */
export interface FileStat extends FileEntry {
  /** Path relative to the filesystem root. */
  path: string;

  createdAt?: Date;
  modifiedAt?: Date;
  accessedAt?: Date;

  mimeType?: string;
}

/** Text decoding options for a filesystem read. */
export interface ReadFileOptions {
  /**
   * Return decoded text using this encoding.
   * Without an encoding, readFile returns Uint8Array.
   */
  encoding?: string;
}

/** Existing-file behavior for a filesystem write. */
export interface WriteFileOptions {
  /** Replace an existing file. Defaults to true. */
  overwrite?: boolean;
}

/** Missing-target and recursive behavior for file or directory removal. */
export interface RemoveOptions {
  /** Do not fail if the target does not exist. */
  force?: boolean;

  /** Recursively remove directory contents. */
  recursive?: boolean;
}

/** Existing-destination behavior for copy and move operations. */
export interface CopyOptions {
  /** Replace an existing destination. Defaults to true. */
  overwrite?: boolean;
}

/** Parent-directory creation behavior for directory creation. */
export interface MakeDirectoryOptions {
  /** Create missing parent directories. */
  recursive?: boolean;
}

/** Recursion, depth, and extension filters for directory listing. */
export interface ListOptions {
  /** Recursively list descendant entries. */
  recursive?: boolean;

  /** Maximum recursion depth. */
  maxDepth?: number;

  /** Only include files with the given extension or extensions. */
  extension?: string | string[];
}

/**
 * A filesystem rooted at a local, remote, or virtual location.
 *
 * Possible implementations include:
 * - Local disk
 * - FTP or SFTP
 * - Object storage
 * - In-memory storage
 * - Databricks
 * - Database-backed storage
 */
export interface FileSystem<TBackend extends string = string> {
  /** Unique identifier for this filesystem instance. */
  readonly id: string;

  /**
   * Identifier for the underlying implementation.
   *
   * Examples: "disk", "ftp", "sftp", "memory", "s3", or "dbfs".
   */
  readonly backend: TBackend;

  /**
   * Root location exposed by this filesystem.
   *
   * Examples:
   * - /var/data
   * - ftp://example.com/files
   * - s3://bucket/prefix
   * - /Volumes/catalog/schema/volume
   */
  readonly root: string;

  readonly readOnly: boolean;

  /** Prepare, connect to, or validate the filesystem. */
  init(): Promise<void>;

  /** Release connections or other resources. */
  close(): Promise<void>;

  /**
   * Resolve a filesystem-relative path into the path understood
   * by the underlying backend.
   */
  resolvePath(inputPath: string): string;

  /** Read a file as binary data. */
  readFile(inputPath: string): Promise<Uint8Array>;

  /** Read and decode a file as text. */
  readFile(inputPath: string, options: ReadFileOptions & { encoding: string }): Promise<string>;

  writeFile(inputPath: string, content: FileContent, options?: WriteFileOptions): Promise<void>;

  appendFile(inputPath: string, content: FileContent): Promise<void>;

  deleteFile(inputPath: string, options?: RemoveOptions): Promise<void>;

  copyFile(sourcePath: string, destinationPath: string, options?: CopyOptions): Promise<void>;

  moveFile(sourcePath: string, destinationPath: string, options?: CopyOptions): Promise<void>;

  mkdir(inputPath: string, options?: MakeDirectoryOptions): Promise<void>;

  rmdir(inputPath: string, options?: RemoveOptions): Promise<void>;

  readdir(inputPath: string, options?: ListOptions): Promise<FileEntry[]>;

  exists(inputPath: string): Promise<boolean>;

  stat(inputPath: string): Promise<FileStat>;
}

/**
 * Resolve one filesystem namespace path to its canonical rooted backend path.
 *
 * Backends retain ownership of lexical resolution through
 * {@link FileSystem.resolvePath}; this helper only normalizes separators and
 * trailing slashes for stable comparison and cache keys.
 */
export function resolveFileSystemPath(filesystem: FileSystem, inputPath: string): string {
  return posixPath.normalizeRoot(posixPath.toPosix(filesystem.resolvePath(inputPath)));
}

/** Values returned by filesystem operations that may be cached. */
export type CacheValue = boolean | string | Uint8Array | FileEntry[] | FileStat;

/** Cache owner used by {@link cache}; implementations may be in-memory or persistent. */
export interface FileSystemCache {
  read<T extends CacheValue>(key: string, load: () => T | Promise<T>): T | Promise<T>;
  invalidate(key: string): void | Promise<void>;
  keys():
    Iterable<string> | AsyncIterable<string> | Promise<Iterable<string> | AsyncIterable<string>>;
}

/** Read operations supported by the filesystem cache decorator. */
export type CacheableFileSystemOperation = "exists" | "readFile" | "readdir" | "stat";

/** Options for {@link cache}. */
export interface FileSystemCacheOptions {
  /**
   * Read operations routed through the cache. Defaults to `exists`, `readdir`,
   * and `stat`.
   */
  operations?: readonly CacheableFileSystemOperation[];
  /**
   * Filesystem-relative roots whose `readFile` results are cached in addition
   * to the default metadata operations. Reads outside these roots always
   * delegate to the source filesystem.
   */
  readFilePaths?: readonly string[];
  /** Additional namespace included in every generated cache key. */
  namespace?: string;
}

const DEFAULT_CACHE_OPERATIONS: readonly CacheableFileSystemOperation[] = [
  "exists",
  "readdir",
  "stat",
];
const MUTATING_FILESYSTEM_OPERATIONS = {
  appendFile: [0],
  copyFile: [1],
  deleteFile: [0],
  mkdir: [0],
  moveFile: [0, 1],
  rmdir: [0],
  writeFile: [0],
} as const;

/**
 * Decorate a filesystem with read-through caching while preserving its exact
 * concrete type and automatically delegating every uncached member.
 *
 * Keys use `<stable-hash>_<normalized-path>`. Mutations enumerate the cache and
 * invalidate every same-filesystem key whose path is an ancestor or descendant
 * of a changed path, covering parent listings plus moved or deleted trees.
 */
export function cache<TFileSystem extends FileSystem>(
  filesystem: TFileSystem,
  storage: FileSystemCache,
  options: FileSystemCacheOptions = {},
): TFileSystem {
  const operations = new Set(options.operations ?? DEFAULT_CACHE_OPERATIONS);
  const cacheAllReadFiles = options.operations?.includes("readFile") ?? false;
  const readFilePaths = (options.readFilePaths ?? []).map((path) =>
    resolveFileSystemPath(filesystem, path),
  );
  if (readFilePaths.length > 0) operations.add("readFile");
  const namespace = options.namespace ?? "filesystem";
  const filesystemHash = hash.fnvHashWithOptions(
    { length: 10 },
    namespace,
    filesystem.backend,
    filesystem.id,
    filesystem.root,
  );
  const boundMethods = new Map<PropertyKey, unknown>();

  const cacheKey = (
    operation: CacheableFileSystemOperation,
    path: string,
    args: readonly unknown[],
  ): string =>
    `${filesystemHash}${hash.fnvHashWithOptions({ length: 8 }, operation, args)}_${path}`;

  const invalidatePaths = async (paths: readonly string[]): Promise<void> => {
    const normalized = paths.flatMap((path) => {
      try {
        return [resolveFileSystemPath(filesystem, path)];
      } catch {
        return [];
      }
    });
    if (normalized.length === 0) return;
    for await (const key of await storage.keys()) {
      const path = cachePath(key, filesystemHash);
      if (
        path !== undefined &&
        normalized.some(
          (changed) =>
            posixPath.isWithinRoot(changed, path) || posixPath.isWithinRoot(path, changed),
        )
      ) {
        await storage.invalidate(key);
      }
    }
  };

  return new Proxy(filesystem, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (boundMethods.has(property)) return boundMethods.get(property);

      const delegated = value.bind(target) as (...args: unknown[]) => unknown;
      let method: (...args: unknown[]) => unknown = delegated;
      if (
        typeof property === "string" &&
        operations.has(property as CacheableFileSystemOperation)
      ) {
        method = async (...args: unknown[]): Promise<CacheValue> => {
          const normalized = cacheOperationPath(filesystem, args);
          if (
            normalized === undefined ||
            (property === "readFile" &&
              !cacheAllReadFiles &&
              !readFilePaths.some((root) => posixPath.isWithinRoot(root, normalized)))
          ) {
            return Promise.resolve(
              (delegated as (...input: unknown[]) => CacheValue | Promise<CacheValue>)(...args),
            );
          }
          const key = cacheKey(property as CacheableFileSystemOperation, normalized, args.slice(1));
          return storage.read(key, () =>
            Promise.resolve(
              (delegated as (...input: unknown[]) => CacheValue | Promise<CacheValue>)(...args),
            ),
          );
        };
      } else if (typeof property === "string" && property in MUTATING_FILESYSTEM_OPERATIONS) {
        method = async (...args: unknown[]): Promise<unknown> => {
          const indices =
            MUTATING_FILESYSTEM_OPERATIONS[property as keyof typeof MUTATING_FILESYSTEM_OPERATIONS];
          const paths = indices.flatMap((index) =>
            typeof args[index] === "string" ? [args[index]] : [],
          );
          try {
            return await delegated(...args);
          } finally {
            await invalidatePaths(paths);
          }
        };
      }
      boundMethods.set(property, method);
      return method;
    },
  });
}

function cacheOperationPath(filesystem: FileSystem, args: readonly unknown[]): string | undefined {
  const path = args[0];
  if (typeof path !== "string") return undefined;
  try {
    return resolveFileSystemPath(filesystem, path);
  } catch {
    return undefined;
  }
}

function cachePath(key: string, filesystemHash: string): string | undefined {
  if (!key.startsWith(filesystemHash)) return undefined;
  const separator = key.indexOf("_", filesystemHash.length);
  if (separator < 0) return undefined;
  try {
    return posixPath.normalizeRoot(key.slice(separator + 1));
  } catch {
    return undefined;
  }
}
