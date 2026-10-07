/** Typed `package.json` `dbxToolsConfig` record for a package. */
import { javascript } from "projen";
import { z } from "zod";

/** `package.json` field name for the dbx-tools config object. */
const CONFIG_KEY = "dbxToolsConfig";

/** Options for {@link DBXToolsConfig}. */
export interface DBXToolsConfigOptions {
  /** Initial tags to record (distinct; order preserved). */
  readonly tags?: string[];
  /** Declaration inputs converted to generated Zod modules (distinct; order preserved). */
  readonly codegenInputs?: string[];
  /** Whether the package receives compiled npm publication machinery. */
  readonly publishable?: boolean;
}

/** Serialized dbx-tools package and workspace generator configuration. */
export const DBXToolsConfigDataSchema = z
  .object({
    tags: z.array(z.string().min(1)).readonly().optional().describe("Package runtime tags."),
    codegenInputs: z
      .array(z.string().min(1))
      .readonly()
      .optional()
      .describe("Declaration inputs converted to generated Zod modules."),
    packageRoots: z
      .array(z.string().min(1))
      .readonly()
      .optional()
      .describe("Repository paths scanned for JavaScript packages."),
    publishable: z
      .boolean()
      .optional()
      .describe("Whether compiled npm publication machinery is enabled."),
    syncResynthPaths: z
      .array(z.string().min(1))
      .readonly()
      .optional()
      .describe("Additional paths that trigger watcher resynthesis."),
    syncWatchTasks: z
      .array(z.string().min(1))
      .readonly()
      .optional()
      .describe("Projen tasks supervised by `sync --watch`."),
  })
  .strict()
  .readonly()
  .describe("dbxToolsConfig serialized in a generated package manifest.");

/** Serialized dbx-tools package and workspace generator configuration. */
export type DBXToolsConfigData = z.infer<typeof DBXToolsConfigDataSchema>;

/** Owns the typed in-memory `dbxToolsConfig` written to `package.json`. */
export class DBXToolsConfig {
  /** Runtime tags that select package mixins. */
  readonly tags: string[];
  /** Declaration inputs converted to generated Zod modules. */
  readonly codegenInputs: string[];
  /** Repository paths scanned for JavaScript package discovery. */
  packageRoots?: string[];
  /** Whether compiled npm publication machinery is enabled. */
  publishable: boolean;
  /** Additional repository paths that trigger watcher resynthesis. */
  syncResynthPaths?: string[];
  /** Projen tasks supervised by `sync --watch`. */
  readonly syncWatchTasks: string[] = [];

  constructor(
    readonly project: javascript.NodeProject,
    options: DBXToolsConfigOptions = {},
  ) {
    this.tags = [...(options.tags ?? [])];
    this.codegenInputs = [...(options.codegenInputs ?? [])];
    this.publishable = options.publishable ?? true;
    project.package.addField(CONFIG_KEY, () => {
      const data = this.data();
      return Object.keys(data).length === 0 ? undefined : data;
    });
  }

  /** Render the serializable package manifest record. */
  data(): DBXToolsConfigData {
    const tags = [...new Set(this.tags)];
    const codegenInputs = [...new Set(this.codegenInputs)];
    return DBXToolsConfigDataSchema.parse({
      ...(tags.length ? { tags } : {}),
      ...(codegenInputs.length ? { codegenInputs } : {}),
      ...(!this.publishable ? { publishable: false } : {}),
      ...(this.packageRoots?.length ? { packageRoots: this.packageRoots } : {}),
      ...(this.syncResynthPaths?.length ? { syncResynthPaths: this.syncResynthPaths } : {}),
      ...(this.syncWatchTasks.length
        ? { syncWatchTasks: [...new Set(this.syncWatchTasks)] }
        : {}),
    });
  }
}
