/**
 * AppKit-backed caching for Databricks workspace skill mounts.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { CacheManager } from "@databricks/appkit";
import { hash, object } from "@dbx-tools/shared-core";
import type {
  CopyOptions,
  FileContent,
  FileEntry,
  FileStat,
  FileSystem,
  ListOptions,
  MakeDirectoryOptions,
  ReadFileOptions,
  RemoveOptions,
  WriteFileOptions,
} from "@dbx-tools/shared-fs";

import { filesystems, type MastraFileSystemAdapter } from "./filesystems.ts";

const CACHE_NAMESPACE = "mastra:workspace-skills";
const DEFAULT_MAX_SCOPED_MOUNTS = 256;

interface CachedFileStat extends Omit<FileStat, "accessedAt" | "createdAt" | "modifiedAt"> {
  accessedAt?: number;
  createdAt?: number;
  modifiedAt?: number;
}

interface ScopedMountEntry {
  adapter: MastraFileSystemAdapter;
  cache: AppKitCachedFileSystem;
  host: string;
  root: string;
  userKey: string;
}

const scopedMounts = new Map<string, ScopedMountEntry>();

/** Default remote skill metadata and content cache lifetime. */
export const DEFAULT_WORKSPACE_SKILL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Options for one AppKit-cached workspace skill filesystem. */
export interface AppKitCachedFileSystemOptions {
  host: string;
  source: FileSystem;
  ttlMs?: number;
  userKey: string;
}

/** Stable Mastra mount plus the identity key used for source reuse. */
export interface CachedWorkspaceSkillMount {
  cacheKey: string;
  filesystem: MastraFileSystemAdapter;
}

/**
 * Cache read-only filesystem operations through AppKit while delegating
 * mutations to the current request's source.
 */
export class AppKitCachedFileSystem implements FileSystem<"appkit-cache"> {
  readonly backend = "appkit-cache" as const;
  readonly id: string;
  readonly readOnly: boolean;
  readonly root: string;

  private source: FileSystem;
  private readonly host: string;
  private readonly ttlSec: number;
  private readonly userKey: string;

  constructor(options: AppKitCachedFileSystemOptions) {
    this.host = options.host;
    this.source = options.source;
    this.root = options.source.root;
    this.readOnly = options.source.readOnly;
    this.ttlSec = cacheTtlSec(options.ttlMs);
    this.userKey = options.userKey;
    this.id = `appkit-skill-cache-${hash.fnvHash(this.host, this.userKey, this.root)}`;
  }

  /** Rebind cache misses and writes to the current request's OBO filesystem. */
  bind(source: FileSystem): void {
    if (source.root !== this.root || source.readOnly !== this.readOnly) {
      throw new Error("Cannot rebind a workspace skill cache to a different filesystem scope");
    }
    this.source = source;
  }

  async init(): Promise<void> {
    await this.source.init();
  }

  async close(): Promise<void> {
    await this.source.close();
  }

  resolvePath(inputPath: string): string {
    return this.source.resolvePath(inputPath);
  }

  async readFile(inputPath: string): Promise<Uint8Array>;
  async readFile(
    inputPath: string,
    options: ReadFileOptions & { encoding: string },
  ): Promise<string>;
  async readFile(inputPath: string, options?: ReadFileOptions): Promise<string | Uint8Array> {
    const value = await this.cached("readFile", inputPath, undefined, async (source) => ({
      base64: Buffer.from(await source.readFile(inputPath)).toString("base64"),
    }));
    const bytes = Buffer.from(value.base64, "base64");
    return options?.encoding ? bytes.toString(options.encoding as BufferEncoding) : bytes;
  }

  async writeFile(
    inputPath: string,
    content: FileContent,
    options?: WriteFileOptions,
  ): Promise<void> {
    await this.mutate((source) => source.writeFile(inputPath, content, options));
  }

  async appendFile(inputPath: string, content: FileContent): Promise<void> {
    await this.mutate((source) => source.appendFile(inputPath, content));
  }

  async deleteFile(inputPath: string, options?: RemoveOptions): Promise<void> {
    await this.mutate((source) => source.deleteFile(inputPath, options));
  }

  async copyFile(
    sourcePath: string,
    destinationPath: string,
    options?: CopyOptions,
  ): Promise<void> {
    await this.mutate((source) => source.copyFile(sourcePath, destinationPath, options));
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    options?: CopyOptions,
  ): Promise<void> {
    await this.mutate((source) => source.moveFile(sourcePath, destinationPath, options));
  }

  async mkdir(inputPath: string, options?: MakeDirectoryOptions): Promise<void> {
    await this.mutate((source) => source.mkdir(inputPath, options));
  }

  async rmdir(inputPath: string, options?: RemoveOptions): Promise<void> {
    await this.mutate((source) => source.rmdir(inputPath, options));
  }

  async readdir(inputPath: string, options?: ListOptions): Promise<FileEntry[]> {
    return this.cached("readdir", inputPath, options, (source) =>
      source.readdir(inputPath, options),
    );
  }

  async exists(inputPath: string): Promise<boolean> {
    return this.cached("exists", inputPath, undefined, (source) => source.exists(inputPath));
  }

  async stat(inputPath: string): Promise<FileStat> {
    const value = await this.cached("stat", inputPath, undefined, async (source) =>
      serializeStat(await source.stat(inputPath)),
    );
    return deserializeStat(value);
  }

  /** Rotate this scope's cache generation so the next read reloads it. */
  async invalidate(): Promise<void> {
    const cache = await CacheManager.getInstance();
    await cache.set(this.generationKey(cache), randomUUID(), {
      ttl: this.ttlSec * 2,
    });
  }

  private async cached<T>(
    operation: string,
    inputPath: string,
    options: unknown,
    load: (source: FileSystem) => Promise<T>,
  ): Promise<T> {
    const source = this.source;
    const cache = await CacheManager.getInstance();
    const generation = await this.generation(cache);
    return cache.getOrExecute(
      [
        CACHE_NAMESPACE,
        this.host,
        this.root,
        generation,
        operation,
        source.resolvePath(inputPath),
        object.toStableKey(options ?? {}),
      ],
      () => load(source),
      this.userKey,
      { ttl: this.ttlSec },
    );
  }

  private async generation(cache: CacheManager): Promise<string> {
    return cache.getOrExecute(
      [CACHE_NAMESPACE, "generation", this.host, this.root],
      async () => randomUUID(),
      this.userKey,
      { ttl: this.ttlSec * 2 },
    );
  }

  private generationKey(cache: CacheManager): string {
    return cache.generateKey([CACHE_NAMESPACE, "generation", this.host, this.root], this.userKey);
  }

  private async mutate(run: (source: FileSystem) => Promise<void>): Promise<void> {
    const source = this.source;
    await run(source);
    await this.invalidate();
  }
}

/** Return one stable Mastra mount per resolved user, host, and source root. */
export function cachedWorkspaceSkillMount(
  options: AppKitCachedFileSystemOptions,
): CachedWorkspaceSkillMount {
  const cacheKey = object.toStableKey({
    host: options.host,
    readOnly: options.source.readOnly,
    root: options.source.root,
    userKey: options.userKey,
  });
  const existing = scopedMounts.get(cacheKey);
  if (existing) {
    existing.cache.bind(options.source);
    scopedMounts.delete(cacheKey);
    scopedMounts.set(cacheKey, existing);
    return { cacheKey, filesystem: existing.adapter };
  }

  const cache = new AppKitCachedFileSystem(options);
  const entry: ScopedMountEntry = {
    adapter: filesystems(cache, {
      id: cache.id,
      readOnly: options.source.readOnly,
    }),
    cache,
    host: options.host,
    root: options.source.root,
    userKey: options.userKey,
  };
  scopedMounts.set(cacheKey, entry);
  trimScopedMounts();
  return { cacheKey, filesystem: entry.adapter };
}

/** Invalidate one user's cached workspace skill scope. */
export async function clearWorkspaceSkillCache(options: {
  host: string;
  root?: string;
  userKey: string;
}): Promise<void> {
  const matches = [...scopedMounts.entries()].filter(
    ([, entry]) =>
      entry.host === options.host &&
      entry.userKey === options.userKey &&
      (options.root === undefined || entry.root === options.root),
  );
  await Promise.all(matches.map(([, entry]) => entry.cache.invalidate()));
}

function cacheTtlSec(ttlMs = DEFAULT_WORKSPACE_SKILL_CACHE_TTL_MS): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Workspace skill cache ttlMs must be a positive finite number");
  }
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

function serializeStat(value: FileStat): CachedFileStat {
  const { accessedAt, createdAt, modifiedAt, ...stat } = value;
  return {
    ...stat,
    ...(accessedAt ? { accessedAt: accessedAt.getTime() } : {}),
    ...(createdAt ? { createdAt: createdAt.getTime() } : {}),
    ...(modifiedAt ? { modifiedAt: modifiedAt.getTime() } : {}),
  };
}

function deserializeStat(value: CachedFileStat): FileStat {
  const { accessedAt, createdAt, modifiedAt, ...stat } = value;
  return {
    ...stat,
    ...(accessedAt !== undefined ? { accessedAt: new Date(accessedAt) } : {}),
    ...(createdAt !== undefined ? { createdAt: new Date(createdAt) } : {}),
    ...(modifiedAt !== undefined ? { modifiedAt: new Date(modifiedAt) } : {}),
  };
}

function trimScopedMounts(): void {
  while (scopedMounts.size > DEFAULT_MAX_SCOPED_MOUNTS) {
    const oldest = scopedMounts.keys().next().value;
    if (oldest === undefined) return;
    scopedMounts.delete(oldest);
  }
}
