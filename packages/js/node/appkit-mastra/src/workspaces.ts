/**
 * Mastra workspace factory for Databricks Apps.
 *
 * Builds a per-request {@link Workspace} whose filesystem is a
 * {@link CompositeFilesystem} over the NAMED skill folders resolved for that
 * request. A skill folder maps a name to a location plus its readable /
 * writable policy: a Databricks path mounted through the OBO client on
 * {@link MASTRA_USER_KEY}, or any {@link WorkspaceFilesystem} a consuming
 * library already owns. {@link DEFAULT_SKILL_FOLDERS} supplies the Assistant
 * trees, and `skillFolders` merges over it - same name overrides, `false`
 * disables, a new name adds. Optional mount resolvers contribute further
 * filesystems and skill scan roots on top.
 *
 * Databricks mounts use `@dbx-tools/databricks` {@link DatabricksFileSystem}
 * wrapped by {@link filesystems}; missing roots fall back to
 * {@link scratchFilesystem}.
 *
 * @module
 */

import type { WorkspaceClient } from "@databricks/appkit";
import { DatabricksFileSystem, workspace as databricksWorkspace } from "@dbx-tools/databricks";
import { error, log, string, token } from "@dbx-tools/shared-core";
import type { RequestContext } from "@mastra/core/request-context";
import {
  CompositeFilesystem,
  Workspace,
  type SkillsContext,
  type SkillsResolver,
  type WorkspaceFilesystem,
} from "@mastra/core/workspace";

import { MASTRA_SCOPES_KEY, MASTRA_USER_EMAIL_KEY, MASTRA_USER_KEY, type User } from "./config.ts";
import { scratchFilesystem, filesystems } from "./filesystems.ts";
import { ASSISTANT_SHARED_SKILLS_PATH, userAssistantSkillsPath } from "./skill-paths.ts";

/* ------------------------------ constants ------------------------------ */

/** OAuth scopes that gate Databricks workspace file mounts. */
const WORKSPACE_FILE_SCOPES = ["workspace", "workspace.workspace", "all-apis"] as const;

const logger = log.logger("mastra/workspaces");

/* -------------------------------- types -------------------------------- */

/** Per-request context for mount and skill-folder resolvers. */
export interface WorkspaceMountContext {
  requestContext?: RequestContext;
}

/**
 * A skill-folder field given either directly or as a per-request resolver.
 * A resolver returning `undefined` skips the folder for that request.
 */
export type SkillFolderValue<T> =
  T | ((context: WorkspaceMountContext) => T | undefined | Promise<T | undefined>);

/**
 * One named skill-folder location and its read / write policy.
 *
 * Give {@link path} for a Databricks workspace tree (mounted through the
 * request's OBO client), or {@link filesystem} for a mount the consumer builds
 * itself. {@link filesystem} wins when both are set.
 */
export interface SkillFolderOptions {
  /** Absolute Databricks workspace path for this folder. */
  path?: SkillFolderValue<string>;
  /** Ready-made mount, for locations the OBO client cannot reach. */
  filesystem?: SkillFolderValue<WorkspaceFilesystem>;
  /**
   * Scan this mount for `SKILL.md` files. Defaults to `true`; `false` mounts
   * the location for file tools without adding it to skill discovery.
   */
  readable?: boolean;
  /**
   * Allow writes to a {@link path} mount (and create the root when missing).
   * Defaults to `false`. A supplied {@link filesystem} carries its own
   * read-only flag instead.
   */
  writable?: boolean;
  /** Mount point in the composite namespace. Defaults to `/<name>`. */
  mount?: string;
}

/** Mount map plus optional Mastra skill scan roots for one resolver. */
export interface WorkspaceMountContribution {
  mounts: Record<string, WorkspaceFilesystem>;
  /** Paths within the composite namespace where `SKILL.md` files are scanned. */
  skillPaths?: string[];
}

/** Contributes filesystem mounts (and optional skill paths) for one request. */
export type WorkspaceMountResolver = (
  context: WorkspaceMountContext,
) => WorkspaceMountContribution | Promise<WorkspaceMountContribution>;

/** Names carried by {@link DEFAULT_SKILL_FOLDERS}. */
export type DefaultSkillFolderName = "workspace-team" | "workspace-team-app";

/** Options for {@link createWorkspace}. */
export interface CreateWorkspaceOptions {
  /** Workspace id; derived from `name` or `"workspace"` when omitted. */
  id?: string;
  /** Display name; derived from `id` when omitted. */
  name?: string;
  /**
   * Start from {@link DEFAULT_SKILL_FOLDERS}. Defaults to `true`; `false`
   * starts from an empty map, leaving only the {@link skillFolders} given here.
   */
  assistantSkills?: boolean;
  /**
   * Named skill folders merged over {@link DEFAULT_SKILL_FOLDERS}: a matching
   * name overrides that default, `false` disables it, and any other name adds
   * a folder.
   */
  skillFolders?: Record<string, SkillFolderOptions | false>;
  /** Extra per-request mount resolvers (run after the skill-folder mounts). */
  mounts?: WorkspaceMountResolver[];
  /** Replace the auto-built dynamic skills resolver. */
  skills?: SkillsResolver;
  /** Forwarded to Mastra when skill discovery is enabled. */
  checkSkillFileMtime?: boolean;
  /** Enable BM25 keyword search over indexed workspace content. */
  bm25?: boolean;
  /**
   * Extra LOCAL skill scan paths added to every request's skill discovery.
   * Used by the plugin to surface remote skills provisioned to a local temp
   * dir at startup (see `remote-skills.ts`). Databricks-hosted remote skills
   * need no entry here - they land in the Assistant tree the built-in mount
   * already scans.
   */
  extraSkillPaths?: string[];
}

/* ------------------------------- defaults ------------------------------- */

/**
 * The skill folders every workspace starts with.
 *
 * - `workspace-team` - the shared workspace Assistant tree, read-only because
 *   writing it is a workspace-admin action.
 * - `workspace-team-app` - the requesting user's own Assistant tree, writable
 *   so the app can save skills back to it. Skipped when the request carries no
 *   user email.
 */
export const DEFAULT_SKILL_FOLDERS: Readonly<Record<DefaultSkillFolderName, SkillFolderOptions>> = {
  "workspace-team": {
    path: ASSISTANT_SHARED_SKILLS_PATH,
    readable: true,
    writable: false,
  },
  "workspace-team-app": {
    path: ({ requestContext }) => {
      const email = resolveScopedEmail(requestContext);
      return email ? userAssistantSkillsPath(email) : undefined;
    },
    readable: true,
    writable: true,
  },
};

/**
 * Create a Mastra {@link Workspace} with per-request Databricks mounts.
 *
 * @example Default skill folders only
 * ```ts
 * createWorkspace()
 * ```
 *
 * @example Override a default, drop another, and add a location of your own
 * ```ts
 * createWorkspace({
 *   skillFolders: {
 *     "workspace-team": { path: "/Workspace/Shared/team-skills" },
 *     "workspace-team-app": false,
 *     runbooks: { path: "/Workspace/Shared/runbooks/skills", writable: true },
 *     volume: { filesystem: myVolumeFilesystem },
 *   },
 * })
 * ```
 *
 * @example Skill folders plus a custom mount resolver
 * ```ts
 * createWorkspace({
 *   mounts: [
 *     async ({ requestContext }) => ({
 *       mounts: { "/data": myFilesystem },
 *       skillPaths: [],
 *     }),
 *   ],
 * })
 * ```
 */
export function createWorkspace(options: CreateWorkspaceOptions = {}): Workspace {
  const { id, name } = resolveWorkspaceIdentity(options);
  const skillFolders = resolveSkillFolders(options);
  const folderNames = Object.keys(skillFolders);
  const resolvers = buildMountResolvers(skillFolders, options.mounts);
  const extraSkillPaths = options.extraSkillPaths ?? [];
  const skills =
    options.skills ??
    (resolvers.length > 0 || extraSkillPaths.length > 0
      ? buildWorkspaceSkillsResolver(resolvers, extraSkillPaths)
      : undefined);
  const checkSkillFileMtime = options.checkSkillFileMtime ?? folderNames.length > 0;
  const bm25 = options.bm25 !== false;
  logger.debug("workspace:create", {
    id,
    name,
    resolverCount: resolvers.length,
    skillFolders: folderNames,
    customMountResolvers: options.mounts?.length ?? 0,
    customSkillsResolver: Boolean(options.skills),
    checkSkillFileMtime,
    bm25,
    extraSkillPaths: extraSkillPaths.length,
  });

  return new Workspace({
    id,
    name,
    filesystem: (context) => resolveWorkspaceFilesystem(resolvers, context),
    ...(skills
      ? {
          skills,
          checkSkillFileMtime,
        }
      : {}),
    bm25,
  });
}

/**
 * Merge the configured skill folders over {@link DEFAULT_SKILL_FOLDERS}.
 *
 * `assistantSkills: false` drops the defaults, and a `false` value removes one
 * entry by name.
 */
export function resolveSkillFolders(
  options: Pick<CreateWorkspaceOptions, "assistantSkills" | "skillFolders"> = {},
): Record<string, SkillFolderOptions> {
  const merged: Record<string, SkillFolderOptions> =
    options.assistantSkills === false ? {} : { ...DEFAULT_SKILL_FOLDERS };
  for (const [name, folder] of Object.entries(options.skillFolders ?? {})) {
    if (folder === false) {
      delete merged[name];
    } else {
      merged[name] = folder;
    }
  }
  return merged;
}

/* ---------------------------- private helpers ---------------------------- */

/**
 * Return whether the request token carries a scope that allows workspace
 * file API access (`workspace` or `all-apis` on {@link MASTRA_SCOPES_KEY}).
 */
function hasWorkspaceFileScope(requestContext: RequestContext | undefined): boolean {
  return token.includesAccessTokenScope(
    requestContext?.get(MASTRA_SCOPES_KEY),
    WORKSPACE_FILE_SCOPES,
  );
}

/**
 * Mount resolver for the named skill folders.
 *
 * Gates on workspace file scope (or development mode), then mounts every
 * folder whose location resolves for this request.
 */
async function resolveSkillFolderMounts(
  skillFolders: Record<string, SkillFolderOptions>,
  context: WorkspaceMountContext,
): Promise<WorkspaceMountContribution> {
  const mounts: Record<string, WorkspaceFilesystem> = {};
  const skillPaths: string[] = [];
  const requestContext = context.requestContext;

  if (!requestContext || !shouldMountSkillFolders(requestContext)) {
    logger.debug("skill-folders:skipped", {
      reason: !requestContext ? "no-request-context" : "missing-workspace-scope",
      nodeEnv: process.env.NODE_ENV,
      scopes: requestContext?.get(MASTRA_SCOPES_KEY),
    });
    return { mounts, skillPaths };
  }

  const user = requestContext.get(MASTRA_USER_KEY) as User | undefined;
  const client = user?.executionContext.client as WorkspaceClient | undefined;

  for (const [name, folder] of Object.entries(skillFolders)) {
    const filesystem = await resolveSkillFolderFilesystem(name, folder, context, client);
    if (!filesystem) continue;
    const mount = folder.mount ?? `/${name}`;
    mounts[mount] = filesystem;
    if (folder.readable !== false) skillPaths.push(mount);
  }

  logger.debug("skill-folders:mounted", {
    mountKeys: Object.keys(mounts),
    skillPaths,
  });

  return { mounts, skillPaths };
}

/**
 * Resolve one skill folder to a Mastra filesystem, or `undefined` to skip it
 * for this request.
 */
async function resolveSkillFolderFilesystem(
  name: string,
  folder: SkillFolderOptions,
  context: WorkspaceMountContext,
  client: WorkspaceClient | undefined,
): Promise<WorkspaceFilesystem | undefined> {
  if (folder.filesystem !== undefined) {
    return resolveSkillFolderValue(folder.filesystem, context);
  }
  // A path mount needs the request's OBO client to reach the workspace.
  if (folder.path === undefined || !client) {
    logger.debug("skill-folder:skipped", {
      name,
      reason: folder.path === undefined ? "no-location" : "missing-obo-client",
    });
    return undefined;
  }
  const root = string.trimToNull(await resolveSkillFolderValue(folder.path, context));
  if (!root) return undefined;
  return databricksFilesystem(client, root, folder.writable !== true);
}

/** Read a {@link SkillFolderValue}, calling it when it is a per-request resolver. */
function resolveSkillFolderValue<T>(
  value: SkillFolderValue<T>,
  context: WorkspaceMountContext,
): T | undefined | Promise<T | undefined> {
  return typeof value === "function"
    ? (value as (context: WorkspaceMountContext) => T | undefined | Promise<T | undefined>)(context)
    : value;
}

/**
 * Fill in `id` and `name` when either is omitted on {@link CreateWorkspaceOptions}.
 * Slugifies `name` into `id`; tokenizes `id` into a display `name`.
 */
function resolveWorkspaceIdentity(options: CreateWorkspaceOptions): {
  id: string;
  name: string;
} {
  let id = options.id;
  let name = options.name;
  if (!id) {
    id = name ? string.toSlug(name) : "workspace";
  }
  if (!name) {
    name = Array.from(string.tokenize(id)).join(" ");
  }
  return { id, name };
}

/** Collect the skill-folder resolver and any caller-supplied ones. */
function buildMountResolvers(
  skillFolders: Record<string, SkillFolderOptions>,
  mounts: WorkspaceMountResolver[] | undefined,
): WorkspaceMountResolver[] {
  const resolvers: WorkspaceMountResolver[] = [];
  const folderCount = Object.keys(skillFolders).length;
  if (folderCount > 0) {
    resolvers.push((context) => resolveSkillFolderMounts(skillFolders, context));
  }
  if (mounts?.length) {
    resolvers.push(...mounts);
  }
  logger.debug("mounts:resolvers", {
    skillFolderCount: folderCount,
    customResolverCount: mounts?.length ?? 0,
    totalResolverCount: resolvers.length,
  });
  return resolvers;
}

/**
 * Gate skill-folder mounts on the request's token.
 *
 * Always allows mounts in development; in other environments requires
 * {@link hasWorkspaceFileScope}.
 */
function shouldMountSkillFolders(requestContext: RequestContext): boolean {
  if (process.env.NODE_ENV === "development") return true;
  return hasWorkspaceFileScope(requestContext);
}

/** Read the trimmed OBO user email stamped on {@link MASTRA_USER_EMAIL_KEY}. */
function resolveScopedEmail(requestContext: RequestContext | undefined): string | undefined {
  return string.trimToNull(requestContext?.get(MASTRA_USER_EMAIL_KEY)) ?? undefined;
}

/**
 * Wrap a {@link DatabricksFileSystem} as a Mastra filesystem. When the root is
 * missing (and {@link readOnly} so we will not create it), fall back to
 * {@link scratchFilesystem} so skill scans still have a writable local mount.
 */
async function databricksFilesystem(
  client: WorkspaceClient,
  root: string,
  readOnly: boolean = true,
): Promise<WorkspaceFilesystem> {
  const fs = new DatabricksFileSystem({
    client: databricksWorkspace.toLegacyWorkspaceClient(client),
    root,
    readOnly,
    createRoot: !readOnly,
  });
  try {
    await fs.init();
    if (await fs.exists(".")) {
      return filesystems(fs, { readOnly });
    }
  } catch (err) {
    logger.debug("databricks-mount:scratch-fallback", {
      root,
      readOnly,
      error: error.errorMessage(err),
    });
  }
  return scratchFilesystem();
}

/**
 * Run every mount resolver for one request and merge mounts plus skill paths.
 * Later resolvers overwrite mount keys from earlier ones.
 */
async function resolveWorkspaceContribution(
  resolvers: WorkspaceMountResolver[],
  context: WorkspaceMountContext,
): Promise<WorkspaceMountContribution> {
  const mounts: Record<string, WorkspaceFilesystem> = {};
  const skillPaths: string[] = [];

  for (const [index, resolver] of resolvers.entries()) {
    const contribution = await resolver(context);
    logger.debug("mounts:resolver", {
      index,
      mountKeys: Object.keys(contribution.mounts),
      skillPaths: contribution.skillPaths ?? [],
    });
    Object.assign(mounts, contribution.mounts);
    if (contribution.skillPaths?.length) {
      skillPaths.push(...contribution.skillPaths);
    }
  }

  logger.debug("mounts:merged", {
    mountKeys: Object.keys(mounts),
    skillPaths,
  });

  return { mounts, skillPaths };
}

/**
 * Dynamic filesystem resolver passed to Mastra {@link Workspace}.
 *
 * Returns a {@link CompositeFilesystem} when any mount resolved; otherwise a
 * fresh {@link scratchFilesystem} so Mastra always has a writable local root.
 */
async function resolveWorkspaceFilesystem(
  resolvers: WorkspaceMountResolver[],
  context: WorkspaceMountContext,
): Promise<WorkspaceFilesystem> {
  const { mounts } = await resolveWorkspaceContribution(resolvers, context);
  const mountKeys = Object.keys(mounts);
  if (mountKeys.length === 0) {
    logger.debug("filesystem:scratch", {
      hasRequestContext: Boolean(context.requestContext),
    });
    return scratchFilesystem();
  }
  logger.debug("filesystem:composite", { mountKeys });
  return new CompositeFilesystem({ mounts });
}

/**
 * Build the dynamic {@link SkillsResolver} that collects `skillPaths` from
 * every mount resolver on each request.
 */
function buildWorkspaceSkillsResolver(
  resolvers: WorkspaceMountResolver[],
  extraSkillPaths: string[] = [],
): SkillsResolver {
  return async (context: SkillsContext) => {
    const { skillPaths } = await resolveWorkspaceContribution(resolvers, context);
    const merged = [...(skillPaths ?? []), ...extraSkillPaths];
    logger.debug("skills:resolved", { skillPaths, extraSkillPaths });
    return merged;
  };
}
