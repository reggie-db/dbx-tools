/**
 * Durable snapshot storage abstraction and Databricks Volume adapter.
 *
 * Backup policy depends only on {@link VolumeStorage}. The Databricks adapter
 * receives an initialized {@link DatabricksFileSystem}, keeping profile and
 * application authentication in `@dbx-tools/databricks` rather than this
 * package. Other durable stores can implement the same narrow contract.
 *
 * @module
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabricksFileSystem } from "@dbx-tools/databricks/databricks-fs";

/** One entry in durable snapshot storage. */
export interface VolumeEntry {
  name: string;
  path: string;
  size?: number;
}

/** Storage contract used by restore, upload, manifest, and retention policy. */
export interface VolumeStorage {
  exists(path: string): Promise<boolean>;
  download(remote: string, local: string): Promise<void>;
  upload(local: string, remote: string, options?: { overwrite?: boolean }): Promise<void>;
  readJson<T>(path: string): Promise<T | null>;
  writeJson(path: string, value: unknown): Promise<void>;
  list(path: string): Promise<VolumeEntry[]>;
  delete(path: string): Promise<void>;
}

/** Stream local snapshots to and from a rooted Unity Catalog Volume filesystem. */
export class DatabricksVolumeStorage implements VolumeStorage {
  constructor(private readonly fileSystem: DatabricksFileSystem) {}

  async exists(path: string): Promise<boolean> {
    return this.fileSystem.exists(path);
  }

  async download(remote: string, local: string): Promise<void> {
    await mkdir(dirname(local), { recursive: true });
    const source = await this.fileSystem.readStream(remote);
    await pipeline(Readable.fromWeb(source), createWriteStream(local));
  }

  async upload(
    local: string,
    remote: string,
    options: { overwrite?: boolean } = {},
  ): Promise<void> {
    const source = Readable.toWeb(createReadStream(local)) as globalThis.ReadableStream<Uint8Array>;
    await this.fileSystem.writeStream(remote, source, options);
  }

  async readJson<T>(path: string): Promise<T | null> {
    if (!(await this.fileSystem.exists(path))) return null;
    const text = await this.fileSystem.readFile(path, { encoding: "utf-8" });
    return JSON.parse(text) as T;
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    await this.fileSystem.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      overwrite: true,
    });
  }

  async list(path: string): Promise<VolumeEntry[]> {
    if (!(await this.fileSystem.exists(path))) return [];
    return (await this.fileSystem.readdir(path)).map((entry) => ({
      name: entry.name,
      path: `${path.replace(/\/$/, "")}/${entry.name}`,
      size: entry.size,
    }));
  }

  async delete(path: string): Promise<void> {
    await this.fileSystem.deleteFile(path, { force: true });
  }
}
