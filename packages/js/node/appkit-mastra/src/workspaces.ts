/**
 * Mastra workspace factory for Databricks Apps.
 *
 * Builds a {@link Workspace} with Databricks Sandbox command execution, an
 * isolated `/tmp` scratch mount, and a {@link CompositeFilesystem} over the
 * named skill folders
 * resolved for that request. A skill folder maps a name to a location plus its
 * readable / writable policy: a Databricks path mounted through the OBO client
 * on {@link MASTRA_USER_KEY}, or any {@link WorkspaceFilesystem} a consuming
 * library already owns. {@link DEFAULT_SKILL_FOLDERS} supplies the Assistant
 * trees, and `skillFolders` merges over it - same name overrides, `false`
 * disables, a new name adds. Optional mount resolvers contribute further
 * filesystems and skill scan roots on top.
 *
 * Databricks mounts use `@dbx-tools/databricks` {@link DatabricksFileSystem}
 * wrapped by {@link filesystems}; inaccessible roots are skipped independently.
 *
 * @module
 */

import { createHash } from "node:crypto";
import {
  ConfigurationError,
  createWorkspaceClient,
  getExecutionContext,
} from "@databricks/appkit";
import type { WorkspaceClient } from "@databricks/appkit";
import { pluginRegistry } from "@dbx-tools/appkit";
import {
  filesCache as filesCachePlugin,
  type FilesCacheExports,
  type FilesCacheScope,
} from "@dbx-tools/appkit/files-cache";
import { DatabricksFileSystem, workspaceClient } from "@dbx-tools/databricks";
import { LocalFileSystem } from "@dbx-tools/fs";
import { errorUtils, log, object, stringUtils, token } from "@dbx-tools/shared-core";
import {
  fs as sharedFS,
  posixPath,
  type FileSystemCache,
} from "@dbx-tools/shared-fs";
import type { RequestContext } from "@mastra/core/request-context";
import {
  WORKSPACE_TOOLS,
  Workspace,
  type SkillsResolver,
  type WorkspaceFilesystem,
  type WorkspaceSandbox,
  type WorkspaceSandboxResolver,
  type ToolConfigWithArgsContext,
  type WorkspaceToolConfig,
  type WorkspaceToolsConfig,
} from "@mastra/core/workspace";

import {
  MASTRA_SCOPES_KEY,
  MASTRA_USER_EMAIL_KEY,
  MASTRA_USER_KEY,
  resolveUserKey,
  type User,
} from "./config.ts";
import {
  filesystems,
  MountedCompositeFilesystem,
  scratchFilesystem,
  type MastraFileSystemAdapterOptions,
} from "./filesystems.ts";
import { MontySandbox } from "./monty-sandbox.ts";
import { DatabricksSandbox, type DatabricksWorkspaceSandboxOptions } from "./sandbox.ts";
import {
  ORGANIZATION_ASSISTANT_PATH,
  personalWorkspacePath,
} from "./skill-paths.ts";

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
  /** Absolute Databricks workspace root mounted at its actual path. */
  path?: SkillFolderValue<string>;
  /** Ready-made mount, for locations the OBO client cannot reach. */
  filesystem?: SkillFolderValue<WorkspaceFilesystem>;
  /** Human-friendly mount name shown in filesystem listings. */
  displayName?: string;
  /** Mount description shown in filesystem listings and workspace instructions. */
  description?: string;
  /**
   * Scan this mount for `SKILL.md` files. Defaults to `true`; `false` mounts
   * the location for file tools without adding it to skill discovery.
   */
  readable?: boolean;
  /**
   * Skill roots relative to this filesystem root. Defaults to `["."]`.
   * Each path is joined to the actual mount path before Mastra scans it.
   */
  skills?: readonly string[];
  /**
   * Allow write attempts to a {@link path} mount. Defaults to `true` for
   * `/Workspace` roots and `false` elsewhere. Databricks permissions still
   * determine whether each mutation succeeds.
   */
  writable?: boolean;
  /**
   * Create a writable {@link path} root when missing. Defaults to
   * {@link writable}; set `false` for pre-existing roots with conditional access.
   */
  createRoot?: boolean;
  /** Mount point in the composite namespace. Databricks paths default to their actual root. */
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
export type DefaultSkillFolderName = "organization-skills" | "personal-skills";

/**
 * Sandbox selection for {@link createWorkspace}. Databricks is the default;
 * `false` disables command execution, and a Mastra provider or resolver is an
 * explicit replacement.
 */
export type WorkspaceSandboxSelection =
  | false
  | "databricks"
  | "monty"
  | DatabricksWorkspaceSandboxOptions
  | WorkspaceSandbox
  | WorkspaceSandboxResolver;

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
  /** Additional native Mastra workspace tool configuration and overrides. */
  tools?: WorkspaceToolsConfig;
  /** AppKit plugin context used to discover optional sibling capabilities. */
  pluginContext?: pluginRegistry.PluginContextLike;
  /** Enable BM25 keyword search over indexed workspace content. */
  bm25?: boolean;
  /**
   * Command sandbox. Defaults to Monty. Pass `"databricks"` or an options
   * object for Databricks Sandbox, `false` to disable command execution, or an
   * explicit Mastra sandbox/provider resolver.
   */
  sandbox?: WorkspaceSandboxSelection;
  /**
   * Extra LOCAL skill roots mounted read-only for every request's skill discovery.
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
 * - `organization-skills` - `/Workspace/.assistant` with `skills`; write
 *   attempts require approval and remain subject to Databricks permissions.
 * - `personal-skills` - the requesting user's `/Workspace/Users/<email>` root
 *   with `.assistant/skills`, writable and skipped without an email.
 */
export const DEFAULT_SKILL_FOLDERS: Readonly<Record<DefaultSkillFolderName, SkillFolderOptions>> = {
  "organization-skills": {
    description: "Organization skills shared with everyone in this Databricks workspace.",
    displayName: "Organization Skills",
    path: ORGANIZATION_ASSISTANT_PATH,
    readable: true,
    skills: ["skills"],
    writable: true,
    createRoot: false,
  },
  "personal-skills": {
    description: "Your Databricks workspace home directory for personal files and skills.",
    displayName: "Home",
    path: ({ requestContext }) => {
      const email = resolveScopedEmail(requestContext);
      return email ? personalWorkspacePath(email) : undefined;
    },
    readable: true,
    skills: [".assistant/skills"],
    writable: true,
    createRoot: false,
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
 *     "organization-skills": {
 *       path: "/Workspace/Shared/.assistant",
 *       skills: ["skills"],
 *     },
 *     "personal-skills": false,
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
  const extraSkillPaths = options.extraSkillPaths ?? [];
  const filesCache = pluginRegistry
    .instance(options.pluginContext, filesCachePlugin)
    ?.exports();
  const retainFilesystemSource =
    filesCache !== undefined &&
    (options.mounts?.length ?? 0) === 0 &&
    Object.values(skillFolders).every(
      (folder) =>
        typeof folder.filesystem !== "function" &&
        !(typeof folder.path === "function" && folder.mount !== undefined),
    );
  const resolvers = buildMountResolvers(
    skillFolders,
    [...(options.mounts ?? []), ...localSkillMountResolvers(extraSkillPaths)],
    filesCache,
  );
  const resolveContribution = contributionResolver(resolvers);
  const resolveFilesystem = (context: WorkspaceMountContext) =>
    resolveWorkspaceFilesystem(
      resolveContribution,
      context,
      retainFilesystemSource ? filesCache : undefined,
    );
  const skills: SkillsResolver =
    options.skills ??
    (async ({ requestContext }) => {
      const context = { requestContext };
      const contribution = await resolveContribution(context);
      return resolveDistinctSkillPaths(
        await resolveFilesystem(context),
        contribution.skillPaths ?? [],
      );
    });
  const checkSkillFileMtime = options.checkSkillFileMtime ?? false;
  const bm25 = options.bm25 !== false;
  const sandbox = resolveWorkspaceSandbox(options.sandbox, id, name);
  const tools = workspaceTools(options.tools);
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
    sandbox: sandbox ? sandboxName(options.sandbox) : "disabled",
  });

  const workspace = new Workspace({
    id,
    name,
    filesystem: resolveFilesystem,
    ...(resolvers.length > 0 || options.skills
      ? {
          skills,
          checkSkillFileMtime,
        }
      : {}),
    ...(sandbox
      ? {
          sandbox,
          instructions: { dynamicSandbox: "resolve" as const },
        }
      : {}),
    bm25,
    tools,
  });
  return workspace;
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

/** Require approval unless a filesystem mutation stays inside the caller's home mount. */
function requireApprovalOutsideHome({
  args,
  requestContext,
}: ToolConfigWithArgsContext): boolean {
  const emailValue = requestContext[MASTRA_USER_EMAIL_KEY];
  const email = typeof emailValue === "string" ? stringUtils.trimToNull(emailValue) : undefined;
  const inputPath = args.path;
  if (!email || typeof inputPath !== "string" || !posixPath.isAbsolute(inputPath)) return true;
  const normalized = posixPath.normalize(inputPath);
  if (!normalized.ok) return true;
  return !posixPath.isWithinRoot(personalWorkspacePath(email), normalized.path);
}

function workspaceTools(configured: WorkspaceToolsConfig | undefined): WorkspaceToolsConfig {
  const requireApproval: WorkspaceToolConfig =
    configured?.requireApproval === undefined
      ? { requireApproval: requireApprovalOutsideHome }
      : {};
  const defaults = {
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: requireApproval,
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: requireApproval,
    [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: requireApproval,
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: requireApproval,
    [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: requireApproval,
  } satisfies WorkspaceToolsConfig;
  const configuredTools = configured as
    Readonly<Record<string, WorkspaceToolConfig | undefined>> | undefined;
  const mergedTools = Object.fromEntries(
    Object.entries(defaults).map(([name, defaultConfig]) => [
      name,
      { ...defaultConfig, ...configuredTools?.[name] },
    ]),
  );
  return {
    ...defaults,
    ...configured,
    ...mergedTools,
  };
}
function resolveWorkspaceSandbox(
  selection: WorkspaceSandboxSelection | undefined,
  workspaceId: string,
  workspaceName: string,
): WorkspaceSandbox | WorkspaceSandboxResolver | undefined {
  const configured = selection ?? "monty";
  if (configured === false) return undefined;
  if (configured === "monty") return new MontySandbox();
  if (typeof configured === "function" || isSandbox(configured)) return configured;

  const options: DatabricksWorkspaceSandboxOptions =
    configured === "databricks" ? { provider: "databricks" } : configured;
  return ({ requestContext }) => {
    const user = requestContext.get(MASTRA_USER_KEY) as User | undefined;
    if (!user) {
      throw ConfigurationError.resourceNotFound(
        "Databricks sandbox user context",
        "Invoke command tools from an agent turn served by the Mastra plugin.",
      );
    }
    const configuredId =
      typeof options.sandboxId === "function"
        ? options.sandboxId({ requestContext })
        : options.sandboxId;
    const sandboxId = configuredId ?? defaultSandboxId(workspaceId, user.id);
    const client =
      typeof options.client === "function"
        ? options.client({ requestContext })
        : (options.client ?? createWorkspaceClient());
    const {
      provider: _provider,
      sandboxId: _sandboxId,
      client: _client,
      ...sandboxOptions
    } = options;
    return new DatabricksSandbox({
      ...sandboxOptions,
      client,
      sandboxId,
      displayName: options.displayName ?? `Mastra ${workspaceName}`,
    });
  };
}

function defaultSandboxId(workspaceId: string, userId: string): string {
  const digest = createHash("sha256")
    .update(object.toStableKey({ workspaceId, userId }))
    .digest("hex")
    .slice(0, 32);
  return `mastra-${digest}`;
}

function isSandbox(value: unknown): value is WorkspaceSandbox {
  return Boolean(
    value && typeof value === "object" && "id" in value && "provider" in value && "status" in value,
  );
}

function sandboxName(selection: WorkspaceSandboxSelection | undefined): string {
  if (selection === undefined || selection === "monty") return "monty";
  if (selection === "databricks") return "databricks";
  if (selection === false) return "disabled";
  if (typeof selection === "function") return "resolver";
  return isSandbox(selection) ? selection.provider : (selection.provider ?? "databricks");
}

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

/** Resolve the request client and authorization-safe files-cache scope. */
async function resolveFilesCacheScope(context: WorkspaceMountContext): Promise<
  | {
      client: WorkspaceClient;
      scope: FilesCacheScope;
    }
  | undefined
> {
  const requestContext = context.requestContext;
  const user = requestContext?.get(MASTRA_USER_KEY) as User | undefined;
  const client = user?.executionContext.client as WorkspaceClient | undefined;
  if (!requestContext || !user || !client) return undefined;
  return {
    client,
    scope: {
      host: (await client.config.getHost()).toString(),
      userKey: resolveUserKey(requestContext),
      ...(process.env.DATABRICKS_WORKSPACE_ID?.trim()
        ? { workspaceId: process.env.DATABRICKS_WORKSPACE_ID.trim() }
        : {}),
    },
  };
}

/** Join one relative skill root to its actual composite mount path. */
function mountedSkillPath(mount: string, skillRoot: string): string {
  if (posixPath.isAbsolute(skillRoot)) {
    throw new TypeError(`Skill path must be relative to its mount: ${skillRoot}`);
  }
  const normalized = posixPath.normalize(skillRoot);
  if (!normalized.ok) {
    throw new TypeError(`Skill path escapes its mount: ${skillRoot}`);
  }
  return posixPath.join(posixPath.normalizeRoot(mount), normalized.path.slice(1));
}

/** Return whether a Databricks path belongs to the writable Workspace namespace. */
function isWorkspaceRoot(root: string): boolean {
  const normalized = posixPath.normalizeRoot(root);
  return normalized === "/Workspace" || normalized.startsWith("/Workspace/");
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
  filesCache: FilesCacheExports | undefined,
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

  const scoped = await resolveFilesCacheScope(context);
  const client = scoped?.client;
  const fileSystemCache =
    filesCache && scoped ? await filesCache.forScope(scoped.scope) : undefined;

  for (const [name, folder] of Object.entries(skillFolders)) {
    const resolved = await resolveSkillFolderFilesystem(name, folder, context, {
      client,
      fileSystemCache,
    });
    if (!resolved) continue;
    const mount = folder.mount ?? resolved.root ?? `/${name}`;
    mounts[mount] = resolved.filesystem;
    if (folder.readable !== false) {
      skillPaths.push(...(folder.skills ?? ["."]).map((path) => mountedSkillPath(mount, path)));
    }
  }

  logger.debug("skill-folders:mounted", {
    mountKeys: Object.keys(mounts),
    skillPaths,
  });

  return {
    mounts,
    skillPaths,
  };
}

/**
 * Resolve one skill folder to a Mastra filesystem, or `undefined` to skip it
 * for this request.
 */
async function resolveSkillFolderFilesystem(
  name: string,
  folder: SkillFolderOptions,
  context: WorkspaceMountContext,
  cache: {
    client: WorkspaceClient | undefined;
    fileSystemCache: FileSystemCache | undefined;
  },
): Promise<
  | {
      filesystem: WorkspaceFilesystem;
      root?: string;
    }
  | undefined
> {
  if (folder.filesystem !== undefined) {
    const filesystem = await resolveSkillFolderValue(folder.filesystem, context);
    return filesystem
      ? {
          filesystem,
        }
      : undefined;
  }
  // A path mount needs the request's OBO client to reach the workspace.
  if (folder.path === undefined || !cache.client) {
    logger.debug("skill-folder:skipped", {
      name,
      reason: folder.path === undefined ? "no-location" : "missing-obo-client",
    });
    return undefined;
  }
  const root = stringUtils.trimToNull(await resolveSkillFolderValue(folder.path, context));
  if (!root) return undefined;
  const writable = folder.writable ?? isWorkspaceRoot(root);
  const resolved = await databricksFilesystem(
    cache.client,
    root,
    !writable,
    folder.createRoot ?? (folder.writable === true),
    cache.fileSystemCache,
    {
      ...(folder.description ? { description: folder.description } : {}),
      ...(folder.displayName ? { displayName: folder.displayName } : {}),
    },
  );
  return resolved ? { ...resolved, root } : undefined;
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
    id = name ? stringUtils.toSlug(name) : "workspace";
  }
  if (!name) {
    name = Array.from(stringUtils.tokenize(id)).join(" ");
  }
  return { id, name };
}

/** Collect the skill-folder resolver and any caller-supplied ones. */
function buildMountResolvers(
  skillFolders: Record<string, SkillFolderOptions>,
  mounts: WorkspaceMountResolver[] | undefined,
  filesCache: FilesCacheExports | undefined,
): WorkspaceMountResolver[] {
  const resolvers: WorkspaceMountResolver[] = [scratchMountResolver()];
  const folderCount = Object.keys(skillFolders).length;
  if (folderCount > 0) {
    resolvers.push((context) => resolveSkillFolderMounts(skillFolders, context, filesCache));
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

/** Contribute one isolated local scratch filesystem at `/tmp`. */
function scratchMountResolver(): WorkspaceMountResolver {
  return () => ({
    mounts: { "/tmp": scratchFilesystem() },
  });
}

/** Mount startup-provisioned local skill roots into Mastra's workspace filesystem. */
function localSkillMountResolvers(paths: readonly string[]): WorkspaceMountResolver[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))].map((root) => {
    const mount = posixPath.normalizeRoot(root);
    const source = new LocalFileSystem({
      root,
      readOnly: true,
      createRoot: false,
    });
    const filesystem = filesystems(source, { readOnly: true });
    return () => ({
      mounts: { [mount]: filesystem },
      skillPaths: [mount],
    });
  });
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
  return stringUtils.trimToNull(requestContext?.get(MASTRA_USER_EMAIL_KEY)) ?? undefined;
}

/**
 * Wrap a {@link DatabricksFileSystem} as a Mastra filesystem. Missing or
 * inaccessible roots return `undefined` so the independent `/tmp` mount and
 * any other accessible roots remain usable.
 */
async function databricksFilesystem(
  client: WorkspaceClient,
  root: string,
  readOnly: boolean = true,
  createRoot: boolean = !readOnly,
  fileSystemCache?: FileSystemCache,
  adapterOptions: Pick<
    MastraFileSystemAdapterOptions,
    "description" | "displayName"
  > = {},
): Promise<
  | {
      filesystem: WorkspaceFilesystem;
    }
  | undefined
> {
  const initialClient = workspaceClient.toLegacyWorkspaceClient(client);
  const fs = new DatabricksFileSystem({
    client: () => {
      try {
        return workspaceClient.toLegacyWorkspaceClient(getExecutionContext().client);
      } catch {
        return initialClient;
      }
    },
    root,
    readOnly,
    createRoot,
  });
  const source = fileSystemCache ? sharedFS.cache(fs, fileSystemCache) : fs;
  const filesystem = filesystems(source, { ...adapterOptions, readOnly });
  try {
    await filesystem.init();
    if (await filesystem.exists(".")) {
      return { filesystem };
    }
  } catch (err) {
    logger.debug("databricks-mount:skipped", {
      root,
      readOnly,
      error: errorUtils.errorMessage(err),
    });
  }
  return undefined;
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

  return {
    mounts,
    skillPaths,
  };
}

/**
 * Dynamic filesystem resolver passed to Mastra {@link Workspace}.
 *
 * Returns a {@link CompositeFilesystem} when any mount resolved; otherwise a
 * fresh {@link scratchFilesystem} so Mastra always has a writable local root.
 */
async function resolveWorkspaceFilesystem(
  resolveContribution: (context: WorkspaceMountContext) => Promise<WorkspaceMountContribution>,
  context: WorkspaceMountContext,
  filesCache?: FilesCacheExports,
): Promise<WorkspaceFilesystem> {
  const { mounts } = await resolveContribution(context);
  const mountKeys = Object.keys(mounts);
  if (mountKeys.length === 0) {
    logger.debug("filesystem:scratch", {
      hasRequestContext: Boolean(context.requestContext),
    });
    return scratchFilesystem();
  }
  logger.debug("filesystem:composite", { mountKeys });
  const load = () => new MountedCompositeFilesystem({ mounts });
  if (!filesCache) return load();
  const scoped = await resolveFilesCacheScope(context);
  if (!scoped) return load();
  return filesCache.forFileSystem(scoped.scope, { paths: mountKeys }, load);
}

/**
 * Expand skill roots into concrete skill directories and keep the first
 * same-named directory. Mastra still owns parsing, indexing, and refreshes,
 * while organization roots retain precedence over personal roots.
 */
async function resolveDistinctSkillPaths(
  filesystem: WorkspaceFilesystem,
  roots: readonly string[],
): Promise<string[]> {
  const selected = new Map<string, string>();
  for (const root of roots) {
    try {
      const entries = await filesystem.readdir(root);
      if (entries.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
        const name = posixPath.basename(root);
        if (!selected.has(name)) selected.set(name, root);
        continue;
      }
      for (const entry of entries) {
        if (entry.type !== "directory" || selected.has(entry.name)) continue;
        selected.set(entry.name, posixPath.join(root, entry.name));
      }
    } catch (error) {
      logger.debug("skill-root:skipped", {
        root,
        error: errorUtils.errorMessage(error),
      });
    }
  }
  return [...selected.values()];
}

/** Memoize one complete mount contribution for each request context. */
function contributionResolver(
  resolvers: WorkspaceMountResolver[],
): (context: WorkspaceMountContext) => Promise<WorkspaceMountContribution> {
  const scoped = new WeakMap<RequestContext, Promise<WorkspaceMountContribution>>();
  let unscoped: Promise<WorkspaceMountContribution> | undefined;
  return (context) => {
    if (!context.requestContext) {
      unscoped ??= resolveWorkspaceContribution(resolvers, context);
      return unscoped;
    }
    const existing = scoped.get(context.requestContext);
    if (existing) return existing;
    const pending = resolveWorkspaceContribution(resolvers, context);
    scoped.set(context.requestContext, pending);
    return pending;
  };
}
