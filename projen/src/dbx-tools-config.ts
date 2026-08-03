/**
 * In-memory `package.json` `dbxToolsConfig` record for a package.
 *
 * Values are read and written on the component's object; each write flushes the
 * record to the manifest through `project.package.addField`.
 */
import { object } from "@dbx-tools/shared-core";
import { Component, javascript } from "projen";

/** `package.json` field name for the dbx-tools config object. */
const DBX_TOOLS_CONFIG_KEY = "dbxToolsConfig";

/** Options for {@link DBXToolsConfig}. */
export interface DBXToolsConfigOptions {
  /** Initial tags to record (distinct; order preserved). */
  readonly tags?: string[];
}

function readDBXToolsConfig(pkg: javascript.NodePackage): Record<string, unknown> {
  try {
    const manifest = pkg.manifest as unknown;
    if (object.isRecord(manifest)) {
      const config = manifest[DBX_TOOLS_CONFIG_KEY];
      if (object.isRecord(config)) {
        return config;
      }
    }
  } catch {}
  return {};
}

function loadConfig(dbxToolsConfig: DBXToolsConfig, pkg: javascript.NodePackage) {
  const { tags, ...config } = readDBXToolsConfig(pkg);
  if (Array.isArray(tags)) {
    object
      .sequence(tags)
      .filter((v: unknown) => typeof v === "string")
      .forEach((v: string) => dbxToolsConfig.tags.push(v));
  }
  Object.entries(config).forEach(([key, value]) => {
    dbxToolsConfig[key] = value;
  });
}

/**
 * Owns a package's in-memory `dbxToolsConfig` object. Callers mutate it
 * directly - push to {@link DBXToolsConfig.tags}, or assign any other key
 * through the index signature. Every own key (i.e. not inherited from
 * `Component`) is collected by {@link DBXToolsConfig.data} and written through
 * `project.package.addField` at synth, so nothing is cached on a field.
 */
export class DBXToolsConfig extends Component {
  private readonly inheritedKeys: ReadonlySet<string>;
  readonly tags: string[];
  [key: string]: unknown;

  constructor(
    override readonly project: javascript.NodeProject,
    options: DBXToolsConfigOptions = {},
  ) {
    super(project);
    this.inheritedKeys = new Set(Object.keys(this));
    this.tags = [];
    loadConfig(this, project.package);
    options.tags?.forEach((v: string) => this.tags.push(v));
  }

  data(): Record<string, unknown> {
    const dataRecord: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this)) {
      if (this.inheritedKeys.has(key)) continue;
      dataRecord[key] = value;
    }
    dataRecord.tags = object.sequence(this.tags).distinct().toArray();
    return dataRecord;
  }

  preSynthesize(): void {
    let dataRecord: Record<string, unknown> | undefined = this.data();
    if (object.isEmpty(dataRecord, { recursive: true })) {
      dataRecord = undefined;
    }
    this.project.package.addField(DBX_TOOLS_CONFIG_KEY, dataRecord);
  }
}
