/**
 * In-memory {@link FileSystem} backed by Maps.
 *
 * Implements only the `*At` primitives; {@link BaseFileSystem} supplies parents,
 * recursion, encoding, and append/copy/move fallbacks. Useful for tests and as
 * a reference for new adapters.
 *
 * @module
 */

import { hash } from "@dbx-tools/shared-core";
import {
  BaseFileSystem,
  FileSystemError,
  normalizeFileSystemRoot,
  type FileSystemRootInput,
} from "./base-fs.ts";
import type { FileEntry, FileStat, WriteFileOptions } from "./fs.ts";
import * as posixPath from "./posix-path.ts";

/** Options for {@link MemoryFileSystem}. */
export interface MemoryFileSystemOptions {
  /** Unique identifier. Defaults to a stable hash of the root. */
  id?: string;

  /**
   * Virtual root. Defaults to `/memory`. See {@link FileSystemRootInput}.
   */
  root?: FileSystemRootInput;

  /** Block all write operations. Defaults to false. */
  readOnly?: boolean;
}

/**
 * {@link FileSystem} that stores files and directories in process memory.
 *
 * @example
 * ```ts
 * const fs = new MemoryFileSystem();
 * await fs.writeFile("note.txt", "hi");
 * const text = await fs.readFile("note.txt", { encoding: "utf8" });
 * ```
 */
export class MemoryFileSystem extends BaseFileSystem<"memory"> {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();

  constructor(options: MemoryFileSystemOptions = {}) {
    const root = options.root ?? "/memory";
    super({
      id: options.id ?? `memory-${hash.fnvHash(normalizeFileSystemRoot(root))}`,
      backend: "memory",
      root,
      readOnly: options.readOnly,
    });
    this.dirs.add(this.root);
  }

  /** Drop every file and directory except the root. */
  clear(): void {
    this.files.clear();
    this.dirs.clear();
    this.dirs.add(this.root);
  }

  protected override async readBytesAt(resolvedPath: string): Promise<Uint8Array> {
    const bytes = this.files.get(resolvedPath);
    if (!bytes) {
      throw new FileSystemError("NOT_FOUND", `Not found: ${resolvedPath}`, resolvedPath);
    }
    return new Uint8Array(bytes);
  }

  protected override async writeBytesAt(
    resolvedPath: string,
    content: Uint8Array,
    options: Required<WriteFileOptions>,
  ): Promise<void> {
    if (!options.overwrite && this.files.has(resolvedPath)) {
      throw new FileSystemError("ALREADY_EXISTS", `Exists: ${resolvedPath}`, resolvedPath);
    }
    if (this.dirs.has(resolvedPath)) {
      throw new FileSystemError("IS_DIRECTORY", `Is directory: ${resolvedPath}`, resolvedPath);
    }
    this.files.set(resolvedPath, new Uint8Array(content));
  }

  protected override async deleteFileAt(resolvedPath: string): Promise<void> {
    if (!this.files.delete(resolvedPath)) {
      throw new FileSystemError("NOT_FOUND", `Not found: ${resolvedPath}`, resolvedPath);
    }
  }

  protected override async createDirectoryAt(resolvedPath: string): Promise<void> {
    if (this.files.has(resolvedPath) || this.dirs.has(resolvedPath)) {
      throw new FileSystemError("ALREADY_EXISTS", `Exists: ${resolvedPath}`, resolvedPath);
    }
    this.dirs.add(resolvedPath);
  }

  protected override async removeDirectoryAt(resolvedPath: string): Promise<void> {
    if (!this.dirs.has(resolvedPath)) {
      throw new FileSystemError("NOT_FOUND", `Not found: ${resolvedPath}`, resolvedPath);
    }
    if (resolvedPath === this.root) {
      throw new FileSystemError(
        "PERMISSION_DENIED",
        `Cannot remove filesystem root: ${resolvedPath}`,
        resolvedPath,
      );
    }
    const prefix = `${resolvedPath}/`;
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        throw new FileSystemError(
          "DIRECTORY_NOT_EMPTY",
          `Not empty: ${resolvedPath}`,
          resolvedPath,
        );
      }
    }
    for (const dir of this.dirs) {
      if (dir !== resolvedPath && dir.startsWith(prefix)) {
        throw new FileSystemError(
          "DIRECTORY_NOT_EMPTY",
          `Not empty: ${resolvedPath}`,
          resolvedPath,
        );
      }
    }
    this.dirs.delete(resolvedPath);
  }

  protected override async listDirectoryAt(resolvedPath: string): Promise<FileEntry[]> {
    if (!this.dirs.has(resolvedPath)) {
      throw new FileSystemError("NOT_FOUND", `Not found: ${resolvedPath}`, resolvedPath);
    }
    const prefix = `${resolvedPath}/`;
    const names = new Map<string, FileEntry>();

    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      names.set(rest, { name: rest, type: "directory" });
    }
    for (const [file, bytes] of this.files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      names.set(rest, { name: rest, type: "file", size: bytes.byteLength });
    }
    return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  protected override async statAt(resolvedPath: string): Promise<Omit<FileStat, "path">> {
    if (this.dirs.has(resolvedPath)) {
      return {
        name: posixPath.basename(resolvedPath) || posixPath.basename(this.root),
        type: "directory",
      };
    }
    const bytes = this.files.get(resolvedPath);
    if (!bytes) {
      throw new FileSystemError("NOT_FOUND", `Not found: ${resolvedPath}`, resolvedPath);
    }
    return {
      name: posixPath.basename(resolvedPath),
      type: "file",
      size: bytes.byteLength,
    };
  }
}
