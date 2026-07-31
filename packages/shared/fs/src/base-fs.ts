/**
 * Abstract {@link FileSystem} base: lifecycle, rooted POSIX paths, encoding, and
 * portable fallbacks so a concrete backend only implements low-level I/O.
 *
 * A new adapter typically overrides:
 * - {@link onInit} / {@link onClose} (optional)
 * - {@link createRootDirectory} when {@link BaseFileSystemOptions.createRoot} is set
 * - {@link toBackendPath} when the backend needs non-POSIX separators
 * - {@link preparePath} for post-resolve checks (e.g. symlink containment)
 * - the `*At` primitives and {@link isNotFoundError}
 * - optional `try*` hooks for native append / copy / move
 *
 * @module
 */

import { error, functionModule, hash, object, type OneOrMany } from "@dbx-tools/shared-core";
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
} from "./fs.ts";
import * as posixPath from "./posix-path.ts";

/**
 * One root path segment. Strings are split on `/` and sanitized; numbers /
 * booleans / bigints stringify then sanitize; objects and arrays are FNV-hashed
 * as a single segment.
 */
export type FileSystemRootSegment = string | number | boolean | bigint | object;

/**
 * A single {@link FileSystemRootSegment} or a non-empty list of them. Nested
 * arrays/objects inside the list are one hashed segment each (not flattened).
 */
export type FileSystemRootInput = FileSystemRootSegment | OneOrMany<FileSystemRootSegment>;

/**
 * Characters no backend accepts inside a single path component: a separator
 * (which would silently deepen the path) or a NUL / control character.
 *
 * This is a DENY-list on purpose. Spaces, `@`, `&`, `#`, parentheses and
 * non-ASCII are all legal directory names on POSIX and in a Databricks
 * workspace, and replacing one with a hash points the filesystem at a
 * directory that does not exist - a failure that is silent and very hard to
 * trace back. Only reject what genuinely cannot be a component.
 */
const UNSAFE_PATH_SEGMENT = /[\\/\u0000-\u001F\u007F]/;

/**
 * Turn {@link root} into a POSIX filesystem root:
 *
 * 1. Expand one-or-many input segments
 * 2. Strings split on `/` (and `\`); objects/arrays FNV-hash as one piece
 * 3. Each resulting component that cannot be a path component - see
 *    {@link UNSAFE_PATH_SEGMENT} - is replaced with {@link hash.fnvHash}
 * 4. Join with `/` and run {@link posixPath.normalizeRoot}
 *
 * Defaults to `/`. A leading `/` on the first string segment is preserved.
 *
 * @example
 * normalizeFileSystemRoot("/cool/wow"); // "/cool/wow"
 * normalizeFileSystemRoot("/Users/me@corp.com/My Notes"); // unchanged
 * normalizeFileSystemRoot(["/path", { user: 1 }, true]); // "/path/<hash>/true"
 */
export function normalizeFileSystemRoot(root?: FileSystemRootInput): string {
  if (root === undefined) return "/";
  const segments = object.toOneOrMany(root);
  const absolute = isAbsoluteRootStart(segments[0]);
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment === null || segment === undefined) {
      throw new TypeError("Filesystem root segments must be non-null");
    }
    appendRootParts(parts, segment);
  }
  if (parts.length === 0) return "/";
  const joined = parts.join("/");
  return posixPath.normalizeRoot(absolute ? `/${joined}` : joined);
}

function isAbsoluteRootStart(segment: FileSystemRootSegment): boolean {
  return typeof segment === "string" && posixPath.isAbsolute(segment.trim());
}

function appendRootParts(parts: string[], segment: FileSystemRootSegment): void {
  switch (typeof segment) {
    case "string":
      for (const piece of splitPathPieces(segment)) {
        parts.push(sanitizePathSegment(piece));
      }
      return;
    case "number":
    case "boolean":
    case "bigint":
      parts.push(sanitizePathSegment(String(segment)));
      return;
    default:
      parts.push(hash.fnvHash(segment));
  }
}

/**
 * Split on `/` (after `\` → `/`); drop empty pieces from
 * leading/trailing/double slashes and no-op `.` pieces.
 */
function splitPathPieces(input: string): string[] {
  return posixPath
    .toPosix(input.trim())
    .split("/")
    .filter((piece) => piece.length > 0 && piece !== ".");
}

/**
 * Keep a usable path component verbatim; FNV-hash one that cannot be used.
 *
 * `..` is hashed rather than dropped so a root can never traverse above
 * itself while the offending segment stays visible in the resolved root.
 */
function sanitizePathSegment(segment: string): string {
  if (segment === ".." || UNSAFE_PATH_SEGMENT.test(segment)) {
    return hash.fnvHash(segment);
  }
  return segment;
}

export type FileSystemErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "NOT_DIRECTORY"
  | "IS_DIRECTORY"
  | "DIRECTORY_NOT_EMPTY"
  | "PERMISSION_DENIED"
  | "READ_ONLY"
  | "INVALID_PATH"
  | "NOT_SUPPORTED"
  | "IO_ERROR";

export class FileSystemError extends Error {
  readonly name = "FileSystemError";

  constructor(
    readonly code: FileSystemErrorCode,
    message: string,
    readonly path?: string,
    options?: { cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: error.toError(options.cause) } : undefined,
    );
  }
}

/**
 * Infer a {@link FileSystemErrorCode} from HTTP status / message tokens on an
 * unknown thrown value (via {@link error.errorContext}).
 *
 * Covers common SDK / REST wording so adapters do not reimplement the same
 * "not found" / "already exists" checks. Returns undefined when nothing matches.
 */
export function inferFileSystemErrorCode(err: unknown): FileSystemErrorCode | undefined {
  const ctx = error.errorContext(err);
  if (ctx.hasStatusCode(404) || ctx.hasMessage("not", "found") || ctx.hasMessage("not", "exist")) {
    return "NOT_FOUND";
  }
  if (ctx.hasStatusCode(409) || ctx.hasMessage("already", "exists")) {
    return "ALREADY_EXISTS";
  }
  // Before "not"+"directory": "directory not empty" contains both of those tokens.
  if (ctx.hasMessage("not", "empty")) {
    return "DIRECTORY_NOT_EMPTY";
  }
  if (ctx.hasMessage("not", "directory")) {
    return "NOT_DIRECTORY";
  }
  if (ctx.hasMessage("is", "directory") || ctx.hasMessage("not", "file")) {
    return "IS_DIRECTORY";
  }
  if (
    ctx.hasStatusCode(401, 403) ||
    ctx.hasMessage("permission", "denied") ||
    ctx.hasMessage("access", "denied")
  ) {
    return "PERMISSION_DENIED";
  }
  if (ctx.hasMessage("read", "only")) {
    return "READ_ONLY";
  }
  return undefined;
}

/**
 * Map an unknown backend failure into a {@link FileSystemError}.
 *
 * Prefer a backend-specific {@link codeOf} classifier (errno, SDK code). When
 * it returns undefined, falls back to {@link inferFileSystemErrorCode}. Message
 * and cause always go through `@dbx-tools/shared-core` {@link error} helpers.
 */
export function mapFileSystemError(
  err: unknown,
  filePath: string,
  codeOf?: (err: unknown) => FileSystemErrorCode | undefined,
): FileSystemError {
  if (err instanceof FileSystemError) return err;
  const message = error.errorMessage(err);
  return new FileSystemError(
    codeOf?.(err) ?? inferFileSystemErrorCode(err) ?? "IO_ERROR",
    message || `Filesystem operation failed: ${filePath}`,
    filePath,
    { cause: error.toError(err) },
  );
}

export interface BaseFileSystemOptions<TBackend extends string = string> {
  id: string;
  backend: TBackend;
  /**
   * Filesystem root. One segment or a list of segments ({@link FileSystemRootInput}):
   * primitives stringify, objects/arrays are FNV-hashed, then joined with `/`
   * and normalized via {@link posixPath.normalizeRoot}. Defaults to `/`.
   */
  root?: FileSystemRootInput;
  readOnly?: boolean;
  /**
   * Ensure {@link root} exists during init by calling {@link createRootDirectory}.
   * Defaults to false (remote roots usually already exist). Local disk adapters
   * typically pass true and override {@link createRootDirectory}.
   */
  createRoot?: boolean;
}

/**
 * Base implementation for local, remote, and virtual filesystems.
 *
 * Subclasses implement the low-level `*At` primitives. This class provides:
 *
 * - Memoized {@link _init} (so an explicit {@link init} call is optional)
 * - Optional root creation via {@link createRootDirectory}
 * - POSIX-only rooted path normalization and traversal protection
 * - {@link toBackendPath} for host/separator conversion at the boundary
 * - Text encoding and decoding
 * - {@link exists}
 * - Parent-directory creation on write / append / copy / move
 * - Append / copy / move fallbacks (override `try*` for native ops)
 * - Recursive mkdir, readdir, and rmdir
 * - Extension filtering for {@link readdir}
 *
 * Namespace paths always use `/`. Host adapters convert with
 * {@link posixPath.toPosix} / {@link posixPath.toHost} in {@link toBackendPath}.
 */
export abstract class BaseFileSystem<
  TBackend extends string = string,
> implements FileSystem<TBackend> {
  readonly id: string;
  readonly backend: TBackend;
  /** POSIX-normalized root (see {@link posixPath.normalizeRoot}). */
  readonly root: string;
  readonly readOnly: boolean;
  protected readonly createRoot: boolean;

  /**
   * Memoized initialization. Every operation that needs a ready backend awaits
   * this, so callers (e.g. Mastra) may call {@link init} every time or never;
   * both are fine.
   */
  protected _init: () => Promise<void>;

  private initStarted = false;

  protected constructor(options: BaseFileSystemOptions<TBackend>) {
    this.id = options.id;
    this.backend = options.backend;
    this.root = normalizeFileSystemRoot(options.root);
    this.readOnly = options.readOnly ?? false;
    this.createRoot = options.createRoot ?? false;
    this._init = this.createInit();
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  private createInit(): () => Promise<void> {
    return functionModule.memoize(async () => {
      this.initStarted = true;
      if (this.createRoot) {
        await this.guard(this.root, () => this.createRootDirectory());
      }
      await this.onInit();
    });
  }

  async init(): Promise<void> {
    await this._init();
  }

  async close(): Promise<void> {
    if (!this.initStarted) return;
    try {
      await this._init();
    } catch {
      this.initStarted = false;
      this._init = this.createInit();
      return;
    }
    await this.onClose();
    this.initStarted = false;
    this._init = this.createInit();
  }

  /**
   * Ensure {@link root} exists when {@link createRoot} is true.
   *
   * Default is a no-op. Local adapters typically `mkdir -p`; remote adapters
   * leave the default when the root is provisioned out of band.
   */
  protected async createRootDirectory(): Promise<void> {}

  /** Override when the backend requires connection or validation work. */
  protected async onInit(): Promise<void> {}

  /** Override when the backend owns connections or other resources. */
  protected async onClose(): Promise<void> {}

  protected assertWritable(operation: string): void {
    if (this.readOnly) {
      throw new FileSystemError("READ_ONLY", `Cannot ${operation}: filesystem is read-only`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Paths (POSIX only)                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Normalize an input path into an absolute POSIX path inside the virtual
   * filesystem namespace (`/a/b`). Backslashes are converted; `..` escaping
   * the root throws {@link FileSystemError} `PERMISSION_DENIED`.
   */
  protected normalizePath(inputPath: string): string {
    if (inputPath.includes("\0")) {
      throw new FileSystemError("INVALID_PATH", "Paths cannot contain null characters", inputPath);
    }

    const result = posixPath.normalize(inputPath);
    if (!result.ok) {
      throw new FileSystemError("PERMISSION_DENIED", "Path escapes the filesystem root", inputPath);
    }
    return result.path;
  }

  /**
   * Convert a POSIX backend path (under {@link root}) into the form the
   * underlying API expects.
   *
   * Default is identity. Local disk overrides with {@link posixPath.toHost}.
   * Databricks / object-store adapters usually leave the default.
   */
  protected toBackendPath(posixBackendPath: string): string {
    return posixBackendPath;
  }

  /**
   * Convert a normalized namespace path (`/a/b`) into a backend path.
   *
   * Joins {@link root} with the namespace using POSIX `/`, then applies
   * {@link toBackendPath}. Override {@link toBackendPath} instead of this
   * method unless the join itself must change.
   */
  protected resolveBackendPath(namespacePath: string): string {
    const posix =
      namespacePath === "/" ? this.root : posixPath.join(this.root, namespacePath.slice(1));
    return this.toBackendPath(posix);
  }

  resolvePath(inputPath: string): string {
    return this.resolveBackendPath(this.normalizePath(inputPath));
  }

  /**
   * Resolve {@link inputPath}, ensure init, and run {@link preparePath}.
   */
  protected async resolveFor(
    inputPath: string,
    options?: { allowMissing?: boolean },
  ): Promise<string> {
    await this._init();
    return this.resolveNamespaceFor(this.normalizePath(inputPath), options);
  }

  /**
   * {@link resolveFor} for a path that is ALREADY a normalized namespace path
   * (`/a/b`). The single spelling for "namespace path to prepared backend
   * path", so no call site has to re-derive the chain by hand.
   */
  private resolveNamespaceFor(
    namespacePath: string,
    options?: { allowMissing?: boolean },
  ): Promise<string> {
    return this.preparePath(this.resolveBackendPath(namespacePath), options);
  }

  /**
   * Hook after lexical resolution. Override for realpath containment or
   * similar backend-specific checks. Default is a no-op.
   */
  protected async preparePath(
    resolvedPath: string,
    _options?: { allowMissing?: boolean },
  ): Promise<string> {
    return resolvedPath;
  }

  protected joinNamespace(parent: string, child: string): string {
    return this.normalizePath(posixPath.join(parent, child));
  }

  /** Namespace path without a leading slash (`.` for the root). */
  protected toRelativePath(namespacePath: string): string {
    return namespacePath === "/" ? "." : namespacePath.slice(1);
  }

  protected toBytes(content: FileContent): Uint8Array {
    return typeof content === "string" ? new TextEncoder().encode(content) : content;
  }

  /** Create parent directories for {@link inputPath} when it is nested. */
  protected async ensureParentDirectory(inputPath: string): Promise<void> {
    const namespacePath = this.normalizePath(inputPath);
    const parent = posixPath.dirname(namespacePath);
    if (parent === "/" || parent === namespacePath) return;
    await this.mkdir(parent, { recursive: true });
  }

  /* ------------------------------------------------------------------ */
  /* Backend primitives                                                 */
  /* ------------------------------------------------------------------ */

  protected abstract readBytesAt(resolvedPath: string): Promise<Uint8Array>;

  protected abstract writeBytesAt(
    resolvedPath: string,
    content: Uint8Array,
    options: Required<WriteFileOptions>,
  ): Promise<void>;

  protected abstract deleteFileAt(resolvedPath: string): Promise<void>;

  protected abstract createDirectoryAt(resolvedPath: string): Promise<void>;

  /**
   * Remove an empty directory.
   *
   * Recursive deletion is implemented by {@link BaseFileSystem}.
   */
  protected abstract removeDirectoryAt(resolvedPath: string): Promise<void>;

  /** Return only the direct children of a directory (`name` is the basename). */
  protected abstract listDirectoryAt(resolvedPath: string): Promise<FileEntry[]>;

  protected abstract statAt(resolvedPath: string): Promise<Omit<FileStat, "path">>;

  /**
   * Recognize the backend's not-found error.
   *
   * Default accepts {@link FileSystemError} `NOT_FOUND` plus common SDK / HTTP
   * "not found" shapes via {@link inferFileSystemErrorCode}. Override for
   * backend-specific codes (e.g. Node `ENOENT`) that do not carry a message.
   */
  protected isNotFoundError(err: unknown): boolean {
    if (err instanceof FileSystemError) return err.code === "NOT_FOUND";
    return inferFileSystemErrorCode(err) === "NOT_FOUND";
  }

  /**
   * Normalize a backend failure into a {@link FileSystemError}.
   *
   * Every `*At` / `try*` primitive is invoked through {@link guard}, so an
   * adapter never writes its own try/catch and cannot forget to normalize.
   * Override only to classify backend-specific codes (e.g. Node errno).
   */
  protected mapError(err: unknown, filePath: string): FileSystemError {
    return mapFileSystemError(err, filePath);
  }

  /** Run a backend primitive, routing any failure through {@link mapError}. */
  private async guard<T>(resolvedPath: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      throw this.mapError(err, resolvedPath);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Optional native-operation hooks                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Override when the backend supports native append.
   *
   * Parent directories are already created by {@link appendFile}. Return true
   * when the operation was performed. The default causes {@link BaseFileSystem}
   * to use read-concatenate-write.
   */
  protected async tryAppendFileAt(_resolvedPath: string, _content: Uint8Array): Promise<boolean> {
    return false;
  }

  /**
   * Override when the backend supports native server-side copying.
   *
   * Parent directories of the destination are already created by {@link copyFile}.
   */
  protected async tryCopyFileAt(
    _sourcePath: string,
    _destinationPath: string,
    _options: Required<CopyOptions>,
  ): Promise<boolean> {
    return false;
  }

  /**
   * Override for native rename or move support.
   *
   * Parent directories of the destination are already created by {@link moveFile}.
   */
  protected async tryMoveFileAt(
    _sourcePath: string,
    _destinationPath: string,
    _options: Required<CopyOptions>,
  ): Promise<boolean> {
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* File operations                                                    */
  /* ------------------------------------------------------------------ */

  async readFile(inputPath: string): Promise<Uint8Array>;
  async readFile(
    inputPath: string,
    options: ReadFileOptions & { encoding: string },
  ): Promise<string>;
  async readFile(inputPath: string, options?: ReadFileOptions): Promise<string | Uint8Array> {
    const resolvedPath = await this.resolveFor(inputPath);
    const content = await this.guard(resolvedPath, () => this.readBytesAt(resolvedPath));
    if (options?.encoding) {
      return new TextDecoder(options.encoding).decode(content);
    }
    return content;
  }

  async writeFile(
    inputPath: string,
    content: FileContent,
    options: WriteFileOptions = {},
  ): Promise<void> {
    await this._init();
    this.assertWritable("write file");

    const overwrite = await this.resolveOverwrite(inputPath, options, "File");
    await this.ensureParentDirectory(inputPath);
    const resolvedPath = await this.resolveFor(inputPath, { allowMissing: true });
    await this.guard(resolvedPath, () =>
      this.writeBytesAt(resolvedPath, this.toBytes(content), { overwrite }),
    );
  }

  async appendFile(inputPath: string, content: FileContent): Promise<void> {
    await this._init();
    this.assertWritable("append file");

    const bytes = this.toBytes(content);
    await this.ensureParentDirectory(inputPath);
    const resolvedPath = await this.resolveFor(inputPath, { allowMissing: true });

    if (await this.guard(resolvedPath, () => this.tryAppendFileAt(resolvedPath, bytes))) {
      return;
    }

    const existing = (await this.exists(inputPath))
      ? await this.readFile(inputPath)
      : new Uint8Array();
    const combined = new Uint8Array(existing.byteLength + bytes.byteLength);
    combined.set(existing);
    combined.set(bytes, existing.byteLength);
    await this.writeFile(inputPath, combined, { overwrite: true });
  }

  async deleteFile(inputPath: string, options: RemoveOptions = {}): Promise<void> {
    await this._init();
    this.assertWritable("delete file");

    await this.ignoringMissing(options, async () => {
      const entry = await this.stat(inputPath);
      if (entry.type === "directory") {
        throw new FileSystemError("IS_DIRECTORY", `Path is a directory: ${inputPath}`, inputPath);
      }
      const resolvedPath = await this.resolveFor(inputPath);
      await this.guard(resolvedPath, () => this.deleteFileAt(resolvedPath));
    });
  }

  async copyFile(
    sourcePath: string,
    destinationPath: string,
    options: CopyOptions = {},
  ): Promise<void> {
    const { source, destination, resolved } = await this.prepareTransfer(
      "copy file",
      sourcePath,
      destinationPath,
      options,
    );

    if (await this.guard(destination, () => this.tryCopyFileAt(source, destination, resolved))) {
      return;
    }

    await this.writeFile(destinationPath, await this.readFile(sourcePath), resolved);
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    options: CopyOptions = {},
  ): Promise<void> {
    const { source, destination, resolved } = await this.prepareTransfer(
      "move file",
      sourcePath,
      destinationPath,
      options,
    );

    if (await this.guard(destination, () => this.tryMoveFileAt(source, destination, resolved))) {
      return;
    }

    await this.copyFile(sourcePath, destinationPath, resolved);
    const sourceStat = await this.stat(sourcePath);
    if (sourceStat.type === "directory") {
      await this.rmdir(sourcePath, { recursive: true });
    } else {
      await this.deleteFile(sourcePath);
    }
  }

  /**
   * Resolve the effective `overwrite` flag, rejecting when the target exists
   * and overwriting was refused. Shared by write / copy / move so the three
   * cannot disagree about what `overwrite: false` means.
   */
  private async resolveOverwrite(
    inputPath: string,
    options: { overwrite?: boolean },
    label: string,
  ): Promise<boolean> {
    const overwrite = options.overwrite ?? true;
    if (!overwrite && (await this.exists(inputPath))) {
      throw new FileSystemError(
        "ALREADY_EXISTS",
        `${label} already exists: ${inputPath}`,
        inputPath,
      );
    }
    return overwrite;
  }

  /** Shared copy / move prologue: writability, overwrite policy, both ends resolved. */
  private async prepareTransfer(
    operation: string,
    sourcePath: string,
    destinationPath: string,
    options: CopyOptions,
  ): Promise<{ source: string; destination: string; resolved: Required<CopyOptions> }> {
    await this._init();
    this.assertWritable(operation);

    const overwrite = await this.resolveOverwrite(destinationPath, options, "Destination");
    await this.ensureParentDirectory(destinationPath);

    return {
      source: await this.resolveFor(sourcePath),
      destination: await this.resolveFor(destinationPath, { allowMissing: true }),
      resolved: { overwrite },
    };
  }

  /** Run a removal, swallowing a not-found failure when `force` is set. */
  private async ignoringMissing(
    options: RemoveOptions,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (err) {
      if (options.force && this.isNotFoundError(err)) return;
      throw err;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Directory operations                                               */
  /* ------------------------------------------------------------------ */

  async mkdir(inputPath: string, options: MakeDirectoryOptions = {}): Promise<void> {
    await this._init();
    this.assertWritable("create directory");

    const namespacePath = this.normalizePath(inputPath);

    if (!options.recursive) {
      await this.createDirectory(namespacePath);
      return;
    }

    let currentPath = "";
    for (const segment of namespacePath.split("/").filter(Boolean)) {
      currentPath = `${currentPath}/${segment}`;
      try {
        const entry = await this.stat(currentPath);
        if (entry.type !== "directory") {
          throw new FileSystemError(
            "NOT_DIRECTORY",
            `Path component is not a directory: ${currentPath}`,
            currentPath,
          );
        }
      } catch (error) {
        if (!this.isNotFoundError(error)) throw error;
        await this.createDirectory(currentPath);
      }
    }
  }

  async rmdir(inputPath: string, options: RemoveOptions = {}): Promise<void> {
    await this._init();
    this.assertWritable("remove directory");

    await this.ignoringMissing(options, async () => {
      const entry = await this.stat(inputPath);
      if (entry.type !== "directory") {
        throw new FileSystemError(
          "NOT_DIRECTORY",
          `Path is not a directory: ${inputPath}`,
          inputPath,
        );
      }

      const namespacePath = this.normalizePath(inputPath);
      if (options.recursive) {
        await this.removeDirectoryContents(namespacePath);
      }
      await this.removeDirectory(namespacePath);
    });
  }

  private async removeDirectoryContents(namespacePath: string): Promise<void> {
    for (const entry of await this.listDirectory(namespacePath)) {
      const childPath = this.joinNamespace(namespacePath, entry.name);
      if (entry.type === "directory") {
        await this.removeDirectoryContents(childPath);
        await this.removeDirectory(childPath);
      } else {
        const resolvedPath = await this.resolveNamespaceFor(childPath);
        await this.guard(resolvedPath, () => this.deleteFileAt(resolvedPath));
      }
    }
  }

  /** {@link createDirectoryAt} for a namespace path, resolved and guarded. */
  private async createDirectory(namespacePath: string): Promise<void> {
    const resolvedPath = await this.resolveNamespaceFor(namespacePath, { allowMissing: true });
    await this.guard(resolvedPath, () => this.createDirectoryAt(resolvedPath));
  }

  /** {@link removeDirectoryAt} for a namespace path, resolved and guarded. */
  private async removeDirectory(namespacePath: string): Promise<void> {
    const resolvedPath = await this.resolveNamespaceFor(namespacePath);
    await this.guard(resolvedPath, () => this.removeDirectoryAt(resolvedPath));
  }

  /** {@link listDirectoryAt} for a namespace path, resolved and guarded. */
  private async listDirectory(namespacePath: string): Promise<FileEntry[]> {
    const resolvedPath = await this.resolveNamespaceFor(namespacePath);
    return this.guard(resolvedPath, () => this.listDirectoryAt(resolvedPath));
  }

  async readdir(inputPath: string, options: ListOptions = {}): Promise<FileEntry[]> {
    await this._init();

    const namespacePath = this.normalizePath(inputPath);

    if (!options.recursive) {
      return this.filterEntries(await this.listDirectory(namespacePath), options);
    }

    return this.listDirectoryRecursive(namespacePath, options, 0, "");
  }

  private async listDirectoryRecursive(
    namespacePath: string,
    options: ListOptions,
    depth: number,
    prefix: string,
  ): Promise<FileEntry[]> {
    const maximumDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    const entries = this.filterEntries(await this.listDirectory(namespacePath), options);

    const results: FileEntry[] = [];

    for (const entry of entries) {
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
      results.push({ ...entry, name: relativeName });

      if (entry.type === "directory" && depth < maximumDepth) {
        results.push(
          ...(await this.listDirectoryRecursive(
            this.joinNamespace(namespacePath, entry.name),
            options,
            depth + 1,
            relativeName,
          )),
        );
      }
    }

    return results;
  }

  private filterEntries(entries: FileEntry[], options: ListOptions): FileEntry[] {
    if (!options.extension) {
      return entries;
    }

    const extensions = (
      Array.isArray(options.extension) ? options.extension : [options.extension]
    ).map((extension) => {
      const normalized = extension.toLowerCase();
      return normalized.startsWith(".") ? normalized : `.${normalized}`;
    });

    return entries.filter((entry) => {
      if (entry.type !== "file") return true;
      const lower = entry.name.toLowerCase();
      return extensions.some((ext) => lower.endsWith(ext));
    });
  }

  async exists(inputPath: string): Promise<boolean> {
    await this._init();
    try {
      await this.stat(inputPath);
      return true;
    } catch (error) {
      if (this.isNotFoundError(error)) return false;
      if (error instanceof FileSystemError && error.code === "PERMISSION_DENIED") {
        return false;
      }
      throw error;
    }
  }

  async stat(inputPath: string): Promise<FileStat> {
    await this._init();
    const namespacePath = this.normalizePath(inputPath);
    const resolvedPath = await this.resolveNamespaceFor(namespacePath);
    const entry = await this.guard(resolvedPath, () => this.statAt(resolvedPath));
    return {
      ...entry,
      path: this.toRelativePath(namespacePath),
    };
  }
}
