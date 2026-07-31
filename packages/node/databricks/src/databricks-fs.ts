/**
 * Databricks {@link FileSystem} backed by {@link WorkspaceClient}.
 *
 * Extends {@link BaseFileSystem}. Routes I/O by absolute path:
 * - `/Workspace`, `/Users`, `/Repos`, `/Shared` → workspace objects API
 * - `/Volumes/...` (or `catalog.schema.volume` roots) → Unity Catalog Files API
 * - `/dbfs/...` → DBFS API
 *
 * @module
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { hash } from "@dbx-tools/shared-core";
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

  protected override async createRootDirectory(): Promise<void> {
    await this.mkdirAbsolute(this.root);
  }

  private workspace(): WorkspaceClient {
    if (!this.client) {
      throw new FileSystemError(
        "IO_ERROR",
        "Databricks filesystem is not initialized (no WorkspaceClient)",
      );
    }
    return this.client;
  }

  private backendFor(absolutePath: string): DatabricksFilesBackend {
    return resolveDatabricksFilesBackend(absolutePath);
  }

  private mapError(err: unknown, filePath: string): FileSystemError {
    return baseFS.mapFileSystemError(err, filePath);
  }

  protected override isNotFoundError(err: unknown): boolean {
    if (super.isNotFoundError(err)) return true;
    return baseFS.inferFileSystemErrorCode(err) === "NOT_FOUND";
  }

  /* ------------------------------------------------------------------ */
  /* Primitives                                                         */
  /* ------------------------------------------------------------------ */

  protected override async readBytesAt(resolvedPath: string): Promise<Uint8Array> {
    try {
      const buffer = await this.readAbsolute(resolvedPath);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (err) {
      throw this.mapError(err, resolvedPath);
    }
  }

  protected override async writeBytesAt(
    resolvedPath: string,
    content: Uint8Array,
    options: Required<WriteFileOptions>,
  ): Promise<void> {
    try {
      await this.writeAbsolute(resolvedPath, Buffer.from(content), options.overwrite);
    } catch (err) {
      throw this.mapError(err, resolvedPath);
    }
  }

  protected override async deleteFileAt(resolvedPath: string): Promise<void> {
    try {
      await this.deleteAbsoluteFile(resolvedPath);
    } catch (err) {
      throw this.mapError(err, resolvedPath);
    }
  }

  protected override async createDirectoryAt(resolvedPath: string): Promise<void> {
    try {
      const backend = this.backendFor(resolvedPath);
      const client = this.workspace();
      if (backend === "dbfs") {
        await client.dbfs.mkdirs({ path: resolvedPath });
        return;
      }
      if (backend === "workspace") {
        await client.workspace.mkdirs({ path: resolvedPath });
        return;
      }
      await client.files.createDirectory({ directory_path: resolvedPath });
    } catch (err) {
      throw this.mapError(err, resolvedPath);
    }
  }

  protected override async removeDirectoryAt(resolvedPath: string): Promise<void> {
    try {
      const backend = this.backendFor(resolvedPath);
      const client = this.workspace();
      if (backend === "dbfs") {
        await client.dbfs.delete({ path: resolvedPath, recursive: false });
        return;
      }
      if (backend === "workspace") {
        await client.workspace.delete({ path: resolvedPath, recursive: false });
        return;
      }
      await client.files.deleteDirectory({ directory_path: resolvedPath });
    } catch (err) {
      throw this.mapError(err, resolvedPath);
    }
  }

  protected override async listDirectoryAt(resolvedPath: string): Promise<FileEntry[]> {
    try {
      return await this.listAbsoluteDirectory(resolvedPath);
    } catch (err) {
      throw this.mapError(err, resolvedPath);
    }
  }

  protected override async statAt(resolvedPath: string): Promise<Omit<FileStat, "path">> {
    try {
      return await this.statAbsolute(resolvedPath);
    } catch (err) {
      throw this.mapError(err, resolvedPath);
    }
  }

  protected override async tryMoveFileAt(
    sourcePath: string,
    destinationPath: string,
    _options: Required<CopyOptions>,
  ): Promise<boolean> {
    if (this.backendFor(sourcePath) !== "dbfs" || this.backendFor(destinationPath) !== "dbfs") {
      return false;
    }
    try {
      await this.workspace().dbfs.move({
        source_path: sourcePath,
        destination_path: destinationPath,
      });
      return true;
    } catch (err) {
      throw this.mapError(err, destinationPath);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Backend I/O                                                        */
  /* ------------------------------------------------------------------ */

  private async mkdirAbsolute(absolutePath: string): Promise<void> {
    const backend = this.backendFor(absolutePath);
    const client = this.workspace();
    if (backend === "dbfs") {
      await client.dbfs.mkdirs({ path: absolutePath });
      return;
    }
    if (backend === "workspace") {
      await client.workspace.mkdirs({ path: absolutePath });
      return;
    }
    // UC createDirectory is single-level; the volume root
    // (`/Volumes/catalog/schema/volume`) is provisioned out of band.
    const parts = absolutePath.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length; i++) {
      current = `${current}/${parts[i]}`;
      if (i < 4) continue; // `/Volumes` .. volume name
      try {
        await client.files.createDirectory({ directory_path: current });
      } catch (err) {
        try {
          await client.files.getDirectoryMetadata({ directory_path: current });
        } catch {
          throw this.mapError(err, current);
        }
      }
    }
  }

  private async readAbsolute(absolutePath: string): Promise<Buffer> {
    const backend = this.backendFor(absolutePath);
    const client = this.workspace();
    if (backend === "dbfs") return this.readDbfsFile(absolutePath);
    if (backend === "workspace") {
      const response = await client.workspace.export({ path: absolutePath, format: "AUTO" });
      return decodeBase64(response.content);
    }
    const response = await client.files.download({ file_path: absolutePath });
    return readResponseBody(response.contents as globalThis.ReadableStream<Uint8Array> | undefined);
  }

  private async writeAbsolute(
    absolutePath: string,
    buffer: Buffer,
    overwrite: boolean,
  ): Promise<void> {
    const backend = this.backendFor(absolutePath);
    const client = this.workspace();
    if (backend === "dbfs") {
      await this.writeDbfsFile(absolutePath, buffer, overwrite);
      return;
    }
    if (backend === "workspace") {
      await client.workspace.import({
        path: absolutePath,
        format: "AUTO",
        content: buffer.toString("base64"),
        overwrite,
      });
      return;
    }
    await client.files.upload({
      file_path: absolutePath,
      contents: bufferToReadableStream(buffer) as never,
      overwrite,
    });
  }

  private async deleteAbsoluteFile(absolutePath: string): Promise<void> {
    const backend = this.backendFor(absolutePath);
    const client = this.workspace();
    if (backend === "dbfs") {
      await client.dbfs.delete({ path: absolutePath, recursive: false });
      return;
    }
    if (backend === "workspace") {
      await client.workspace.delete({ path: absolutePath, recursive: false });
      return;
    }
    await client.files.delete({ file_path: absolutePath });
  }

  private async listAbsoluteDirectory(absolutePath: string): Promise<FileEntry[]> {
    const backend = this.backendFor(absolutePath);
    const client = this.workspace();
    const entries: FileEntry[] = [];

    if (backend === "dbfs") {
      for await (const info of client.dbfs.list({ path: absolutePath })) {
        entries.push({
          name: posixPath.basename(info.path ?? ""),
          type: info.is_dir ? "directory" : "file",
          size: info.file_size,
        });
      }
      return entries;
    }

    if (backend === "workspace") {
      for await (const info of client.workspace.list({ path: absolutePath })) {
        entries.push({
          name: posixPath.basename(info.path ?? ""),
          type: info.object_type === "DIRECTORY" ? "directory" : "file",
        });
      }
      return entries;
    }

    for await (const entry of client.files.listDirectoryContents({
      directory_path: absolutePath,
    })) {
      entries.push({
        name: entry.name ?? posixPath.basename(entry.path ?? ""),
        type: entry.is_directory ? "directory" : "file",
        size: entry.file_size,
      });
    }
    return entries;
  }

  private async statAbsolute(absolutePath: string): Promise<Omit<FileStat, "path">> {
    const backend = this.backendFor(absolutePath);
    const client = this.workspace();
    const name = posixPath.basename(absolutePath) || posixPath.basename(this.root);

    if (backend === "dbfs") {
      const info = await client.dbfs.getStatus({ path: absolutePath });
      return {
        name: posixPath.basename(info.path ?? absolutePath) || name,
        type: info.is_dir ? "directory" : "file",
        size: info.file_size,
        createdAt:
          info.modification_time !== undefined ? new Date(info.modification_time) : undefined,
        modifiedAt:
          info.modification_time !== undefined ? new Date(info.modification_time) : undefined,
      };
    }

    if (backend === "workspace") {
      const info = await client.workspace.getStatus({ path: absolutePath });
      return {
        name: posixPath.basename(info.path ?? absolutePath) || name,
        type: info.object_type === "DIRECTORY" ? "directory" : "file",
        createdAt: info.created_at !== undefined ? new Date(info.created_at) : undefined,
        modifiedAt: info.modified_at !== undefined ? new Date(info.modified_at) : undefined,
      };
    }

    try {
      const metadata = await client.files.getMetadata({ file_path: absolutePath });
      return {
        name,
        type: "file",
        size: Number(metadata["content-length"] ?? 0),
        createdAt: parseHttpDate(metadata["last-modified"]),
        modifiedAt: parseHttpDate(metadata["last-modified"]),
        mimeType: metadata["content-type"],
      };
    } catch (fileErr) {
      if (baseFS.inferFileSystemErrorCode(fileErr) !== "NOT_FOUND") {
        // Also treat opaque "not accessible" as a directory probe candidate.
        const code = baseFS.mapFileSystemError(fileErr, absolutePath).code;
        if (code !== "NOT_FOUND" && code !== "PERMISSION_DENIED") {
          throw fileErr;
        }
      }
      await client.files.getDirectoryMetadata({ directory_path: absolutePath });
      return { name, type: "directory" };
    }
  }

  private async readDbfsFile(absolutePath: string): Promise<Buffer> {
    const client = this.workspace();
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
    absolutePath: string,
    buffer: Buffer,
    overwrite: boolean,
  ): Promise<void> {
    const client = this.workspace();
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
    for (let offset = 0; offset < buffer.length; offset += DBFS_PUT_MAX_BYTES) {
      const slice = buffer.subarray(offset, offset + DBFS_PUT_MAX_BYTES);
      await client.dbfs.addBlock({ handle, data: slice.toString("base64") });
    }
    await client.dbfs.close({ handle });
  }
}

/* ------------------------------ helpers ------------------------------ */

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

function parseHttpDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}
