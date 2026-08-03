/**
 * Databricks {@link FileSystem} backed by {@link WorkspaceClient}.
 *
 * Extends {@link BaseFileSystem}. Routes I/O by absolute path:
 * - `/Workspace`, `/Users`, `/Repos`, `/Shared` → workspace objects API
 * - `/Volumes/...` (or `catalog.schema.volume` roots) → Unity Catalog Files API
 * - `/dbfs/...` → DBFS API
 *
 * Every primitive picks its API through {@link DatabricksFileSystem.dispatch}
 * rather than re-branching by hand, and error normalization is inherited from
 * {@link BaseFileSystem}, so a primitive here is just the SDK call.
 *
 * @module
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { hash, object } from "@dbx-tools/shared-core";
import {
  BaseFileSystem,
  baseFS,
  FileSystemError,
  posixPath,
  type CopyOptions,
  type FileEntry,
  type FileStat,
  type WriteFileOptions,
} from "@dbx-tools/shared-fs";
import {
  isHomeRelativePath,
  normalizeDatabricksRoot,
  resolveDatabricksFilesBackend,
  resolveDatabricksRoot,
  type DatabricksFilesBackend,
} from "./databricks-path.ts";
import { getWorkspaceClient } from "./workspace.ts";

const DBFS_READ_CHUNK_BYTES = 1024 * 1024;
const DBFS_PUT_MAX_BYTES = 1024 * 1024;

/** Segments in `/Volumes/<catalog>/<schema>/<volume>`, provisioned out of band. */
const VOLUME_ROOT_DEPTH = 4;

/**
 * One handler per Databricks API, keyed by {@link DatabricksFilesBackend} so
 * adding a backend is a compile error until every call site handles it.
 */
type BackendHandlers<T> = Record<DatabricksFilesBackend, (client: WorkspaceClient) => Promise<T>>;

/** Options for {@link DatabricksFileSystem}. */
export interface DatabricksFileSystemOptions {
  /** Unique identifier. Defaults to a stable hash of the normalized root. */
  id?: string;

  /**
   * Filesystem root. Accepts:
   * - `/Volumes/catalog/schema/volume` (also `/Volume/...`)
   * - `catalog.schema.volume`
   * - `~` / `~/...` → `/Workspace/Users/<userName>/...` (needs {@link userName},
   *   or use {@link DatabricksFileSystem.create})
   * - `/Workspace/...`, `/Users/...`, `/Repos/...`, `/Shared/...`
   * - `/dbfs/...`
   */
  root: string;

  /**
   * Username for expanding `~`. When omitted and {@link root} is home-relative,
   * prefer {@link DatabricksFileSystem.create} which resolves it via
   * `getCurrentUserName`.
   */
  userName?: string;

  /**
   * Databricks workspace client. Defaults to `tryGetWorkspaceClient()`, otherwise
   * a default {@link WorkspaceClient} from env / profile auth.
   */
  client?: WorkspaceClient;

  /** Block all write operations. Defaults to false. */
  readOnly?: boolean;

  /**
   * Create {@link root} (and parents) during init. Defaults to false (volume
   * and workspace roots are usually provisioned out of band).
   */
  createRoot?: boolean;
}

/**
 * {@link FileSystem} implementation over Databricks workspace files, UC
 * volumes, and DBFS.
 *
 * @example
 * ```ts
 * const fs = new DatabricksFileSystem({ root: "main.default.assets" });
 * await fs.writeFile("notes/hello.txt", "hi");
 *
 * const home = await DatabricksFileSystem.create({ root: "~" });
 * const listing = await home.readdir(".");
 * ```
 */
export class DatabricksFileSystem extends BaseFileSystem<"databricks"> {
  private client: WorkspaceClient | undefined;
  private readonly clientOption: WorkspaceClient | undefined;

  constructor(options: DatabricksFileSystemOptions) {
    const root = normalizeDatabricksRoot(options.root, { userName: options.userName });
    super({
      id: options.id ?? `databricks-${hash.fnvHash(root)}`,
      backend: "databricks",
      root,
      readOnly: options.readOnly,
      createRoot: options.createRoot ?? false,
    });
    this.clientOption = options.client;
    this.client = options.client;
  }

  /**
   * Construct a {@link DatabricksFileSystem}, resolving `~` roots via the
   * workspace current user when needed.
   */
  static async create(options: DatabricksFileSystemOptions): Promise<DatabricksFileSystem> {
    if (!isHomeRelativePath(options.root) || options.userName?.trim()) {
      return new DatabricksFileSystem(options);
    }
    const client = options.client ?? (await getWorkspaceClient());
    const root = await resolveDatabricksRoot(options.root, { client });
    return new DatabricksFileSystem({ ...options, root, client });
  }

  protected override async onInit(): Promise<void> {
    this.client = this.clientOption ?? (await getWorkspaceClient());
  }

  /** Run the handler for `absolutePath`'s Databricks API with the live client. */
  private dispatch<T>(absolutePath: string, handlers: BackendHandlers<T>): Promise<T> {
    if (!this.client) {
      throw new FileSystemError(
        "IO_ERROR",
        "Databricks filesystem is not initialized (no WorkspaceClient)",
        absolutePath,
      );
    }
    return handlers[resolveDatabricksFilesBackend(absolutePath)](this.client);
  }

  /* ------------------------------------------------------------------ */
  /* Primitives                                                         */
  /* ------------------------------------------------------------------ */

  protected override async createRootDirectory(): Promise<void> {
    await this.createDirectoryAt(this.root);
  }

  protected override async readBytesAt(resolvedPath: string): Promise<Uint8Array> {
    const buffer = await this.dispatch<Buffer>(resolvedPath, {
      dbfs: (client) => this.readDbfsFile(client, resolvedPath),
      workspace: async (client) => {
        const response = await client.workspace.export({ path: resolvedPath, format: "AUTO" });
        return decodeBase64(response.content);
      },
      volumes: async (client) => {
        const response = await client.files.download({ file_path: resolvedPath });
        return readResponseBody(
          response.contents as globalThis.ReadableStream<Uint8Array> | undefined,
        );
      },
    });
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  protected override async writeBytesAt(
    resolvedPath: string,
    content: Uint8Array,
    options: Required<WriteFileOptions>,
  ): Promise<void> {
    const buffer = Buffer.from(content);
    const overwrite = options.overwrite;
    await this.dispatch<unknown>(resolvedPath, {
      dbfs: (client) => this.writeDbfsFile(client, resolvedPath, buffer, overwrite),
      workspace: (client) =>
        client.workspace.import({
          path: resolvedPath,
          format: "AUTO",
          content: buffer.toString("base64"),
          overwrite,
        }),
      volumes: (client) =>
        client.files.upload({
          file_path: resolvedPath,
          contents: bufferToReadableStream(buffer) as never,
          overwrite,
        }),
    });
  }

  protected override async deleteFileAt(resolvedPath: string): Promise<void> {
    await this.dispatch<unknown>(resolvedPath, {
      dbfs: (client) => client.dbfs.delete({ path: resolvedPath, recursive: false }),
      workspace: (client) => client.workspace.delete({ path: resolvedPath, recursive: false }),
      volumes: (client) => client.files.delete({ file_path: resolvedPath }),
    });
  }

  protected override async createDirectoryAt(resolvedPath: string): Promise<void> {
    await this.dispatch<unknown>(resolvedPath, {
      dbfs: (client) => client.dbfs.mkdirs({ path: resolvedPath }),
      workspace: (client) => client.workspace.mkdirs({ path: resolvedPath }),
      volumes: (client) => this.createVolumeDirectories(client, resolvedPath),
    });
  }

  protected override async removeDirectoryAt(resolvedPath: string): Promise<void> {
    await this.dispatch<unknown>(resolvedPath, {
      dbfs: (client) => client.dbfs.delete({ path: resolvedPath, recursive: false }),
      workspace: (client) => client.workspace.delete({ path: resolvedPath, recursive: false }),
      volumes: (client) => client.files.deleteDirectory({ directory_path: resolvedPath }),
    });
  }

  protected override async listDirectoryAt(resolvedPath: string): Promise<FileEntry[]> {
    return this.dispatch<FileEntry[]>(resolvedPath, {
      dbfs: (client) =>
        collect(client.dbfs.list({ path: resolvedPath }), (info) => ({
          name: posixPath.basename(info.path ?? ""),
          type: info.is_dir ? "directory" : "file",
          size: info.file_size,
        })),
      workspace: (client) =>
        collect(client.workspace.list({ path: resolvedPath }), (info) => ({
          name: posixPath.basename(info.path ?? ""),
          type: info.object_type === "DIRECTORY" ? "directory" : "file",
        })),
      volumes: (client) =>
        collect(client.files.listDirectoryContents({ directory_path: resolvedPath }), (entry) => ({
          name: entry.name ?? posixPath.basename(entry.path ?? ""),
          type: entry.is_directory ? "directory" : "file",
          size: entry.file_size,
        })),
    });
  }

  protected override async statAt(resolvedPath: string): Promise<Omit<FileStat, "path">> {
    const fallbackName = posixPath.basename(resolvedPath) || posixPath.basename(this.root);
    return this.dispatch<Omit<FileStat, "path">>(resolvedPath, {
      dbfs: async (client) => {
        const info = await client.dbfs.getStatus({ path: resolvedPath });
        const modified = object.toDate(info.modification_time);
        return {
          name: posixPath.basename(info.path ?? resolvedPath) || fallbackName,
          type: info.is_dir ? "directory" : "file",
          size: info.file_size,
          createdAt: modified,
          modifiedAt: modified,
        };
      },
      workspace: async (client) => {
        const info = await client.workspace.getStatus({ path: resolvedPath });
        return {
          name: posixPath.basename(info.path ?? resolvedPath) || fallbackName,
          type: info.object_type === "DIRECTORY" ? "directory" : "file",
          createdAt: object.toDate(info.created_at),
          modifiedAt: object.toDate(info.modified_at),
        };
      },
      volumes: (client) => this.statVolumePath(client, resolvedPath, fallbackName),
    });
  }

  protected override async tryMoveFileAt(
    sourcePath: string,
    destinationPath: string,
    _options: Required<CopyOptions>,
  ): Promise<boolean> {
    // Only DBFS exposes a server-side move; everything else falls back to the
    // portable copy + delete in BaseFileSystem.
    if (
      resolveDatabricksFilesBackend(sourcePath) !== "dbfs" ||
      resolveDatabricksFilesBackend(destinationPath) !== "dbfs"
    ) {
      return false;
    }
    await this.dispatch<unknown>(sourcePath, {
      dbfs: (client) =>
        client.dbfs.move({ source_path: sourcePath, destination_path: destinationPath }),
      workspace: unreachableBackend,
      volumes: unreachableBackend,
    });
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Backend-specific I/O                                               */
  /* ------------------------------------------------------------------ */

  /**
   * UC `createDirectory` is single-level, so walk the path creating each level
   * below the volume itself. A level that already exists is not an error.
   */
  private async createVolumeDirectories(
    client: WorkspaceClient,
    absolutePath: string,
  ): Promise<void> {
    const parts = absolutePath.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length; i++) {
      current = `${current}/${parts[i]}`;
      if (i < VOLUME_ROOT_DEPTH) continue;
      try {
        await client.files.createDirectory({ directory_path: current });
      } catch (err) {
        // Already present is fine; anything else is a real failure.
        try {
          await client.files.getDirectoryMetadata({ directory_path: current });
        } catch {
          throw err;
        }
      }
    }
  }

  /** Stat a UC path: file metadata first, then a directory probe. */
  private async statVolumePath(
    client: WorkspaceClient,
    absolutePath: string,
    fallbackName: string,
  ): Promise<Omit<FileStat, "path">> {
    try {
      const metadata = await client.files.getMetadata({ file_path: absolutePath });
      const modified = object.toDate(metadata["last-modified"]);
      return {
        name: fallbackName,
        type: "file",
        size: Number(metadata["content-length"] ?? 0),
        createdAt: modified,
        modifiedAt: modified,
        mimeType: metadata["content-type"],
      };
    } catch (fileErr) {
      // A directory has no file metadata, and an unreadable one reports as
      // missing / denied - both are worth a directory probe before failing.
      const code = baseFS.mapFileSystemError(fileErr, absolutePath).code;
      if (code !== "NOT_FOUND" && code !== "PERMISSION_DENIED") throw fileErr;
      await client.files.getDirectoryMetadata({ directory_path: absolutePath });
      return { name: fallbackName, type: "directory" };
    }
  }

  private async readDbfsFile(client: WorkspaceClient, absolutePath: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (true) {
      const response = await client.dbfs.read({
        path: absolutePath,
        offset,
        length: DBFS_READ_CHUNK_BYTES,
      });
      const chunk = decodeBase64(response.data);
      if (chunk.length === 0) break;
      chunks.push(chunk);
      offset += chunk.length;
      if (chunk.length < DBFS_READ_CHUNK_BYTES) break;
    }
    return Buffer.concat(chunks);
  }

  private async writeDbfsFile(
    client: WorkspaceClient,
    absolutePath: string,
    buffer: Buffer,
    overwrite: boolean,
  ): Promise<void> {
    if (buffer.length <= DBFS_PUT_MAX_BYTES) {
      await client.dbfs.put({
        path: absolutePath,
        contents: buffer.toString("base64"),
        overwrite,
      });
      return;
    }
    const created = await client.dbfs.create({ path: absolutePath, overwrite });
    const handle = created.handle;
    if (handle === undefined) {
      throw new FileSystemError("IO_ERROR", "DBFS upload handle missing", absolutePath);
    }
    try {
      for (let offset = 0; offset < buffer.length; offset += DBFS_PUT_MAX_BYTES) {
        const slice = buffer.subarray(offset, offset + DBFS_PUT_MAX_BYTES);
        await client.dbfs.addBlock({ handle, data: slice.toString("base64") });
      }
    } catch (err) {
      await client.dbfs.close({ handle }).catch(() => undefined);
      throw err;
    }
    await client.dbfs.close({ handle });
  }
}

/* ------------------------------ helpers ------------------------------ */

/** Drain an SDK async iterable into a mapped array. */
async function collect<S, T>(source: AsyncIterable<S>, map: (item: S) => T): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(map(item));
  return items;
}

/** Handler for a backend a call site has already ruled out. */
function unreachableBackend(): Promise<never> {
  throw new FileSystemError("NOT_SUPPORTED", "Unsupported Databricks backend for this operation");
}

function decodeBase64(data: string | undefined): Buffer {
  if (!data) return Buffer.alloc(0);
  return Buffer.from(data, "base64");
}

async function readResponseBody(
  contents: globalThis.ReadableStream<Uint8Array> | undefined,
): Promise<Buffer> {
  if (!contents) return Buffer.alloc(0);
  const reader = contents.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function bufferToReadableStream(buffer: Buffer): globalThis.ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}
