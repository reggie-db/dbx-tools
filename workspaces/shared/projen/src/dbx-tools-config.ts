/**
 * In-memory `package.json` `dbxToolsConfig` record for a workspace package.
 *
 * Values are read and written on the component's object; each write flushes the
 * record to the manifest through `project.package.addField`.
 */
import { Component, javascript } from "projen";

/** `package.json` field name for the dbx-tools config object. */
export const DBX_TOOLS_CONFIG_KEY = "dbxToolsConfig";

/** Options for {@link DBXToolsConfig}. */
export interface DBXToolsConfigOptions {
  /** Initial tags to record (distinct; order preserved). */
  readonly tags?: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readManifest(pkg: javascript.NodePackage): Record<string, unknown> {
  try {
    const manifest = pkg.manifest as unknown;
    if (!isPlainObject(manifest)) return {};
    return manifest;
  } catch {
    return {};
  }
}

function loadConfig(pkg: javascript.NodePackage): Record<string, unknown> {
  const raw = readManifest(pkg)[DBX_TOOLS_CONFIG_KEY];
  if (!isPlainObject(raw)) return {};
  return { ...raw };
}



/**
 * Owns a package's in-memory `dbxToolsConfig` object. Callers mutate it with
 * {@link readField} / {@link setField}; each {@link setField} writes through
 * `project.package.addField`.
 */
export class DBXToolsConfig extends Component {
  private readonly _config: Record<string, unknown>;

  constructor(
    readonly project: javascript.NodeProject,
    options: DBXToolsConfigOptions = {},
  ) {
    super(project);
    this._config = loadConfig(project.package);
    // `package.json` is projen-owned; lock it read-only so the generated tree stays
    // consistent. Set here (not in `preSynthesize`) so a direct
    // `project.package.file.readonly = false` opt-out applied later still wins at synth.
    project.package.file.readonly = true;
    if (options.tags !== undefined) this.writeTags(options.tags);
  }


  /** Read a value from the in-memory config; `undefined` when any segment is absent. */
  public readField(path: string | string[]): unknown {
    let current: unknown = this._config;
    for (const key of typeof path === "string" ? [path] : path) {
      if (!isPlainObject(current)) return undefined;
      current = current[key];
      if (current == null) return undefined;
    }
    return current;
  }

  /** Write a value into the in-memory config and flush it to `package.json`. */
  public setField(value: unknown, path: string | string[]): void {
    const keys = typeof path === "string" ? [path] : path;
    if (keys.length === 0) throw new Error("setField requires at least one key");
    let current = this._config;
    for (const key of keys.slice(0, -1)) {
      if (!isPlainObject(current[key])) current[key] = {};
      current = current[key] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]!] = value;
    this.flush();
  }

  /** The distinct tags on `dbxToolsConfig.tags` (empty if unset). */
  public get tags(): readonly string[] {
    const tags = this.readField("tags");
    if (!Array.isArray(tags)) return [];
    return [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))];
  }

  /** Add tags at the end, keeping the list distinct (incoming moved to the end). */
  public addTags(...tags: string[]): void {
    if (tags.length === 0) return;
    const incoming = [...new Set(tags)];
    this.writeTags([...this.tags.filter((t) => !incoming.includes(t)), ...incoming]);
  }

  /** Add tags at the front, keeping the list distinct (incoming moved to the front). */
  public prependTags(...tags: string[]): void {
    if (tags.length === 0) return;
    this.writeTags([...tags, ...this.tags]);
  }

  /** Shallow copy of the in-memory record, omitting default-empty fields. */
  public snapshot(): Record<string, unknown> {
    const config = { ...this._config };
    const tags = config.tags;
    if (Array.isArray(tags) && tags.length === 0) delete config.tags;
    return config;
  }

  private writeTags(tags: string[]): void {
    const normalized = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    if (normalized.length === 0) delete this._config.tags;
    else this._config.tags = normalized;
    this.flush();
  }

  /** Flush the in-memory config to `package.json` via projen. */
  private flush(): void {
    this.project.package.addField(DBX_TOOLS_CONFIG_KEY, this.snapshot());
  }
}
