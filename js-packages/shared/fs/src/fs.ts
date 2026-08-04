export type FileContent = string | Uint8Array;

export type FileEntryType = "file" | "directory" | "symbolic-link" | "other";

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

export interface FileStat extends FileEntry {
  /** Path relative to the filesystem root. */
  path: string;

  createdAt?: Date;
  modifiedAt?: Date;
  accessedAt?: Date;

  mimeType?: string;
}

export interface ReadFileOptions {
  /**
   * Return decoded text using this encoding.
   * Without an encoding, readFile returns Uint8Array.
   */
  encoding?: string;
}

export interface WriteFileOptions {
  /** Replace an existing file. Defaults to true. */
  overwrite?: boolean;
}

export interface RemoveOptions {
  /** Do not fail if the target does not exist. */
  force?: boolean;

  /** Recursively remove directory contents. */
  recursive?: boolean;
}

export interface CopyOptions {
  /** Replace an existing destination. Defaults to true. */
  overwrite?: boolean;
}

export interface MakeDirectoryOptions {
  /** Create missing parent directories. */
  recursive?: boolean;
}

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
