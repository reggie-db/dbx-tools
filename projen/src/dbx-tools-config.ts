/** Typed `package.json` `dbxToolsConfig` record for a package. */
import { javascript } from "projen";

/** `package.json` field name for the dbx-tools config object. */
const DBX_TOOLS_CONFIG_KEY = "dbxToolsConfig";

/** Options for {@link DBXToolsConfig}. */
export interface DBXToolsConfigOptions {
  /** Initial tags to record (distinct; order preserved). */
  readonly tags?: string[];
}

interface DBXToolsConfigData {
  readonly tags?: string[];
  readonly packageRoots?: string[];
  readonly syncResynthPaths?: string[];
}

/** Owns the typed in-memory `dbxToolsConfig` written to `package.json`. */
export class DBXToolsConfig {
  readonly tags: string[];
  packageRoots?: string[];
  syncResynthPaths?: string[];

  constructor(
    readonly project: javascript.NodeProject,
    options: DBXToolsConfigOptions = {},
  ) {
    this.tags = [...(options.tags ?? [])];
    project.package.addField(DBX_TOOLS_CONFIG_KEY, () => {
      const data = this.data();
      return Object.keys(data).length === 0 ? undefined : data;
    });
  }

  data(): DBXToolsConfigData {
    const tags = [...new Set(this.tags)];
    return {
      ...(tags.length ? { tags } : {}),
      ...(this.packageRoots?.length ? { packageRoots: this.packageRoots } : {}),
      ...(this.syncResynthPaths?.length ? { syncResynthPaths: this.syncResynthPaths } : {}),
    };
  }
}
