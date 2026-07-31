/**
 * Mastra workspace filesystem adapters.
 *
 * {@link filesystems} wraps any portable `@dbx-tools/shared-fs` {@link FileSystem}
 * (local disk, Databricks, memory, …) as a Mastra {@link MastraFilesystem}.
 * {@link scratchFilesystem} always returns a fresh {@link localFS.tmpFS} mount
 * (random id root) when Mastra needs a filesystem and no other mount resolved.
 *
 * @module
 */

import { hash } from "@dbx-tools/shared-core";
import { localFS } from "@dbx-tools/fs";
import { FileSystemError } from "@dbx-tools/shared-fs";
import type {
  FileContent as SharedFileContent,
  FileEntry as SharedFileEntry,
  FileStat as SharedFileStat,
  FileSystem,
} from "@dbx-tools/shared-fs";
import {
  DirectoryNotEmptyError,
  DirectoryNotFoundError,
  FileExistsError,
  FileNotFoundError,
  IsDirectoryError,
  MastraFilesystem,
  NotDirectoryError,
  PermissionError,
  WorkspaceReadOnlyError,
} from "@mastra/core/workspace";
import type {
  CopyOptions,
  FileContent,
  FileEntry,
  FileStat,
  FilesystemInfo,
  ListOptions,
  MastraFilesystemOptions,
  ProviderStatus,
  ReadOptions,
  RemoveOptions,
  WriteOptions,
} from "@mastra/core/workspace";

/** Options for {@link filesystems} / {@link MastraFileSystemAdapter}. */
export interface MastraFileSystemAdapterOptions extends MastraFilesystemOptions {
  /** Override the Mastra filesystem id. Defaults to the source {@link FileSystem.id}. */
  id?: string;

  /** Override the Mastra display name. Defaults to `MastraFileSystemAdapter`. */
  name?: string;

  /**
   * Override the Mastra provider id. Defaults to the source
   * {@link FileSystem.backend}.
   */
  provider?: string;

  /**
   * Force read-only mounts even when the source filesystem allows writes.
   * The source {@link FileSystem.readOnly} flag still applies either way.
   */
  readOnly?: boolean;
}

/**
 * Wrap a portable {@link FileSystem} as a Mastra {@link MastraFilesystem}.
 *
 * @example
 * ```ts
 * import { filesystems } from "@dbx-tools/appkit-mastra";
 * import { DatabricksFileSystem } from "@dbx-tools/databricks";
 * import { localFS } from "@dbx-tools/fs";
 *
 * const volume = filesystems.filesystems(
 *   new DatabricksFileSystem({ root: "/Volumes/main/default/assets" }),
 * );
 * const scratch = filesystems.filesystems(localFS.tmpFS("agent-job"));
 * ```
 */
export function filesystems(
  fs: FileSystem,
  options: MastraFileSystemAdapterOptions = {},
): MastraFileSystemAdapter {
  return new MastraFileSystemAdapter(fs, options);
}

/**
 * Thin Mastra {@link MastraFilesystem} adapter over a `@dbx-tools/shared-fs`
 * {@link FileSystem}. Identity fields are getters that read the source on
 * access; construction does not snapshot them.
 */
export class MastraFileSystemAdapter extends MastraFilesystem {
  status: ProviderStatus = "pending";

  private readonly fs: FileSystem;
  private readonly options: MastraFileSystemAdapterOptions;

  constructor(fs: FileSystem, options: MastraFileSystemAdapterOptions = {}) {
    super({
      name: options.name ?? "MastraFileSystemAdapter",
      onInit: options.onInit,
      onDestroy: options.onDestroy,
    });
    this.fs = fs;
    this.options = options;
  }

  get id(): string {
    return this.options.id ?? this.fs.id;
  }

  get name(): string {
    return this.options.name ?? "MastraFileSystemAdapter";
  }

  get provider(): string {
    return this.options.provider ?? this.fs.backend;
  }

  get readOnly(): boolean {
    return this.options.readOnly === true || this.fs.readOnly;
  }

  get basePath(): string {
    return this.fs.root;
  }

  override async init(): Promise<void> {
    await this.fs.init();
  }

  override async destroy(): Promise<void> {
    await this.fs.close();
  }

  getInfo(): FilesystemInfo<{ root: string; backend: string }> {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      readOnly: this.readOnly,
      metadata: { root: this.fs.root, backend: this.fs.backend },
    };
  }

  getInstructions(): string {
    return [
      `Files are served by a ${this.fs.backend} filesystem rooted at ${this.fs.root}.`,
      "Workspace paths are absolute within this mount (for example `/notes/report.md`).",
    ].join(" ");
  }

  async readFile(inputPath: string, options?: ReadOptions): Promise<string | Buffer> {
    return this.delegate(inputPath, async () => {
      if (options?.encoding) {
        return this.fs.readFile(inputPath, { encoding: options.encoding });
      }
      return Buffer.from(await this.fs.readFile(inputPath));
    });
  }

  async writeFile(inputPath: string, content: FileContent, options?: WriteOptions): Promise<void> {
    return this.delegateWrite("writeFile", inputPath, async () => {
      if (options?.recursive === false) {
        await this.assertParentExists(inputPath);
      }
      await this.fs.writeFile(inputPath, toSharedContent(content), {
        overwrite: options?.overwrite ?? true,
      });
    });
  }

  async appendFile(inputPath: string, content: FileContent): Promise<void> {
    return this.delegateWrite("appendFile", inputPath, () =>
      this.fs.appendFile(inputPath, toSharedContent(content)),
    );
  }

  async deleteFile(inputPath: string, options?: RemoveOptions): Promise<void> {
    return this.delegateWrite("deleteFile", inputPath, () =>
      this.fs.deleteFile(inputPath, {
        force: options?.force,
        recursive: options?.recursive,
      }),
    );
  }

  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    return this.delegateWrite("copyFile", dest, () =>
      this.fs.copyFile(src, dest, { overwrite: options?.overwrite ?? true }),
    );
  }

  async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    return this.delegateWrite("moveFile", dest, () =>
      this.fs.moveFile(src, dest, { overwrite: options?.overwrite ?? true }),
    );
  }

  async mkdir(inputPath: string, options?: { recursive?: boolean }): Promise<void> {
    return this.delegateWrite("mkdir", inputPath, () =>
      this.fs.mkdir(inputPath, { recursive: options?.recursive }),
    );
  }

  async rmdir(inputPath: string, options?: RemoveOptions): Promise<void> {
    return this.delegateWrite(
      "rmdir",
      inputPath,
      () =>
        this.fs.rmdir(inputPath, {
          force: options?.force,
          recursive: options?.recursive,
        }),
      { preferDirectory: true },
    );
  }

  async readdir(inputPath: string, options?: ListOptions): Promise<FileEntry[]> {
    return this.delegate(
      inputPath,
      async () =>
        (
          await this.fs.readdir(inputPath, {
            recursive: options?.recursive,
            maxDepth: options?.maxDepth,
            extension: options?.extension,
          })
        ).map(toMastraEntry),
      { preferDirectory: true },
    );
  }

  async exists(inputPath: string): Promise<boolean> {
    await this.ensureReady();
    return this.fs.exists(inputPath);
  }

  async stat(inputPath: string): Promise<FileStat> {
    return this.delegate(inputPath, async () =>
      toMastraStat(await this.fs.stat(inputPath), inputPath),
    );
  }

  private async delegate<T>(
    path: string,
    op: () => Promise<T>,
    options?: { preferDirectory?: boolean },
  ): Promise<T> {
    await this.ensureReady();
    try {
      return await op();
    } catch (err) {
      this.rethrow(err, path, options);
    }
  }

  private async delegateWrite(
    operation: string,
    path: string,
    op: () => Promise<void>,
    options?: { preferDirectory?: boolean },
  ): Promise<void> {
    await this.ensureReady();
    if (this.readOnly) {
      throw new WorkspaceReadOnlyError(operation);
    }
    try {
      await op();
    } catch (err) {
      this.rethrow(err, path, options);
    }
  }

  /** When Mastra asks for non-recursive writes, require the parent directory. */
  private async assertParentExists(inputPath: string): Promise<void> {
    const normalized = normalizeWorkspacePath(inputPath);
    if (normalized === "/") return;
    const parent = parentWorkspacePath(normalized);
    if (parent === "/" || (await this.fs.exists(parent))) return;
    throw new DirectoryNotFoundError(parent);
  }

  private rethrow(err: unknown, inputPath: string, options?: { preferDirectory?: boolean }): never {
    if (
      err instanceof FileNotFoundError ||
      err instanceof DirectoryNotFoundError ||
      err instanceof FileExistsError ||
      err instanceof IsDirectoryError ||
      err instanceof NotDirectoryError ||
      err instanceof DirectoryNotEmptyError ||
      err instanceof PermissionError ||
      err instanceof WorkspaceReadOnlyError
    ) {
      throw err;
    }

    if (err instanceof FileSystemError) {
      throw mapSharedError(err, inputPath, options?.preferDirectory === true);
    }

    throw err;
  }
}

/** Fresh writable local temp mount (unique {@link hash.id} root under tmp). */
export function scratchFilesystem(): MastraFileSystemAdapter {
  return filesystems(localFS.tmpFS(`mastra-${hash.id()}`));
}

/** Map a shared-fs error code onto the matching Mastra filesystem error. */
function mapSharedError(err: FileSystemError, inputPath: string, preferDirectory: boolean): Error {
  const path = err.path ?? inputPath;
  switch (err.code) {
    case "NOT_FOUND":
      return preferDirectory ? new DirectoryNotFoundError(path) : new FileNotFoundError(path);
    case "ALREADY_EXISTS":
      return new FileExistsError(path);
    case "NOT_DIRECTORY":
      return new NotDirectoryError(path);
    case "IS_DIRECTORY":
      return new IsDirectoryError(path);
    case "DIRECTORY_NOT_EMPTY":
      return new DirectoryNotEmptyError(path);
    case "PERMISSION_DENIED":
      return new PermissionError(path, err.message);
    case "READ_ONLY":
      return new WorkspaceReadOnlyError(err.message);
    default:
      return err;
  }
}

function toSharedContent(content: FileContent): SharedFileContent {
  if (typeof content === "string") return content;
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function toMastraEntry(entry: SharedFileEntry): FileEntry {
  return {
    name: entry.name,
    type: entry.type === "directory" ? "directory" : "file",
    size: entry.size,
    isSymlink: entry.type === "symbolic-link",
  };
}

function toMastraStat(stat: SharedFileStat, inputPath: string): FileStat {
  const epoch = new Date(0);
  return {
    name: stat.name,
    path: normalizeWorkspacePath(stat.path || inputPath),
    type: stat.type === "directory" ? "directory" : "file",
    size: stat.size ?? 0,
    createdAt: stat.createdAt ?? epoch,
    modifiedAt: stat.modifiedAt ?? epoch,
    mimeType: stat.mimeType,
  };
}

function normalizeWorkspacePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed || trimmed === ".") return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts = withSlash.split("/").filter((part) => part.length > 0 && part !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.length === 0 ? "/" : `/${resolved.join("/")}`;
}

function parentWorkspacePath(absolutePath: string): string {
  if (absolutePath === "/") return "/";
  const idx = absolutePath.lastIndexOf("/");
  return idx <= 0 ? "/" : absolutePath.slice(0, idx);
}
