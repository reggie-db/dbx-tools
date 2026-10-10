/**
 * Mastra workspace factory for Databricks Apps.
 *
 * Builds native Mastra workspace configuration from Databricks paths. Paths
 * mount at the same path by default, `~` resolves to the current user's
 * Databricks workspace home, and `/tmp[/subpath]` resolves to stable
 * user-scoped storage under the host's ephemeral temp directory.
 *
 * Databricks mounts use `@dbx-tools/databricks` {@link DatabricksFileSystem}
 * wrapped by {@link filesystems}; inaccessible roots are skipped independently.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError, createWorkspaceClient } from "@databricks/appkit";
import type { WorkspaceClient } from "@databricks/appkit";
import { appkit, pluginRegistry } from "@dbx-tools/appkit";
import {
  filesCache as filesCachePlugin,
  type FilesCacheExports,
  type FilesCacheScope,
} from "@dbx-tools/appkit/files-cache";
import { DatabricksFileSystem, workspaceClient } from "@dbx-tools/databricks";
import { LocalFileSystem } from "@dbx-tools/fs";
import { match, type PathMatchInput } from "@dbx-tools/path";
import { errorUtils, log, object, stringUtils, token } from "@dbx-tools/shared-core";
import {
  fs as sharedFS,
  posixPath,
  type CacheableFileSystemOperation,
  type FileSystem,
  type FileSystemCache,
  type FileSystemCacheOptions,
  MemoryFileSystem,
} from "@dbx-tools/shared-fs";
import type { RequestContext } from "@mastra/core/request-context";
import {
  Workspace,
  type SkillsResolver,
  type WorkspaceConfig,
  type WorkspaceFilesystem,
  type WorkspaceSandbox,
  type WorkspaceSandboxResolver,
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
  type MastraFileSystemAdapterOptions,
} from "./filesystems.ts";
import { MontySandbox } from "./monty-sandbox.ts";
import { DatabricksSandbox, type DatabricksWorkspaceSandboxOptions } from "./sandbox.ts";
import { ORGANIZATION_ASSISTANT_PATH, personalWorkspacePath } from "./skill-paths.ts";

/* ------------------------------ constants ------------------------------ */

/** OAuth scopes that gate Databricks workspace file mounts. */
const WORKSPACE_FILE_SCOPES = ["workspace", "workspace.workspace", "all-apis"] as const;
const SCRATCH_MOUNT = "/tmp";
const CACHEABLE_FILESYSTEM_OPERATIONS = [
  "exists",
  "readFile",
  "readdir",
  "stat",
] as const satisfies readonly CacheableFileSystemOperation[];

const logger = log.logger("mastra/workspaces");
let workspaceSourceSequence = 0;
const databricksWorkspaceOptions = new WeakMap<Workspace, DatabricksWorkspaceOptions>();

/* -------------------------------- types -------------------------------- */

/** Per-request context for mount and skill-folder resolvers. */
export interface DatabricksWorkspaceContext {
  requestContext?: RequestContext;
}

/**
 * One Databricks path mounted into a Mastra workspace.
 */
export interface DatabricksWorkspacePathOptions {
  /** Absolute Databricks path or `~` shortcut for the current user's workspace home. */
  path: string;
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

/** String shorthand or full options for one Databricks workspace path. */
export type DatabricksWorkspacePath = string | DatabricksWorkspacePathOptions;

/** Fixed or request-dependent Databricks path entry. */
export type DatabricksWorkspacePathValue =
  | DatabricksWorkspacePath
  | false
  | ((
      context: DatabricksWorkspaceContext,
    ) =>
      | DatabricksWorkspacePath
      | false
      | undefined
      | Promise<DatabricksWorkspacePath | false | undefined>);

/** Operations and path globs cached by the Databricks filesystem shortcut. */
export interface DatabricksWorkspaceCacheFilter {
  /** Cached filesystem operations. Omit for `exists`, `readFile`, `readdir`, and `stat`. */
  operations?: CacheableFileSystemOperation | readonly CacheableFileSystemOperation[];
  /** Absolute or root-relative globs and predicates. `~` expands per request. */
  paths?: PathMatchInput | readonly PathMatchInput[];
}

/** Fixed or request-dependent filesystem cache selection. */
export type DatabricksWorkspaceCache =
  | boolean
  | DatabricksWorkspaceCacheFilter
  | readonly DatabricksWorkspaceCacheFilter[]
  | ((
      context: DatabricksWorkspaceContext,
    ) =>
      | boolean
      | DatabricksWorkspaceCacheFilter
      | readonly DatabricksWorkspaceCacheFilter[]
      | undefined
      | Promise<
          | boolean
          | DatabricksWorkspaceCacheFilter
          | readonly DatabricksWorkspaceCacheFilter[]
          | undefined
        >);

/** Mount map plus optional Mastra skill scan roots resolved for one request. */
interface WorkspaceMountContribution {
  mounts: Record<string, WorkspaceFilesystem>;
  /** Paths within the composite namespace where `SKILL.md` files are scanned. */
  skillPaths?: string[];
}

/** Internal filesystem contribution resolver. */
type WorkspaceMountResolver = (
  context: DatabricksWorkspaceContext,
) => WorkspaceMountContribution | Promise<WorkspaceMountContribution>;

/**
 * Sandbox selection for {@link databricksWorkspace}. Monty is the default;
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

/** Native Mastra workspace options plus Databricks path shortcuts. */
export interface DatabricksWorkspaceOptions extends Omit<
  WorkspaceConfig,
  "filesystem" | "mounts" | "sandbox" | "skills"
> {
  /**
   * Start from {@link DEFAULT_DATABRICKS_WORKSPACE_PATHS}. Defaults to `true`.
   */
  assistantPaths?: boolean;
  /**
   * Databricks paths appended after the defaults. A string is shorthand for
   * `{ path }`; a resolver may return either form per request.
   */
  paths?: readonly DatabricksWorkspacePathValue[];
  /** Native Mastra filesystems composed beside the Databricks paths. */
  mounts?: Record<string, WorkspaceFilesystem>;
  /** Replace the auto-built dynamic skills resolver. */
  skills?: SkillsResolver;
  /** Filesystem cache filters. Ignored when the AppKit files-cache plugin is absent. */
  cache?: DatabricksWorkspaceCache;
  /** AppKit plugin context used to discover optional sibling capabilities. */
  pluginContext?: pluginRegistry.PluginContextLike;
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
 * Default Databricks paths for shared and current-user Agent Skills.
 */
export const DEFAULT_DATABRICKS_WORKSPACE_PATHS: readonly DatabricksWorkspacePathOptions[] = [
  {
    path: ORGANIZATION_ASSISTANT_PATH,
    readable: true,
    skills: ["skills"],
    writable: true,
    createRoot: false,
  },
  {
    path: "~",
    readable: true,
    skills: [".assistant/skills"],
    writable: true,
    createRoot: false,
  },
];

/**
 * Create a Mastra {@link Workspace} with per-request Databricks mounts.
 *
 * @example Default Databricks paths
 * ```ts
 * databricksWorkspace()
 * ```
 *
 * @example Use only explicit paths
 * ```ts
 * databricksWorkspace({
 *   assistantPaths: false,
 *   paths: ["~/project", "/tmp/project", "/Volumes/main/default/data"],
 * })
 * ```
 *
 * @example Build a standard Mastra workspace yourself
 * ```ts
 * new Workspace({
 *   ...databricksWorkspaceConfig({ paths: ["~/project"] }),
 *   sandbox: mySandbox,
 * })
 * ```
 */
export function databricksWorkspaceConfig(
  options: DatabricksWorkspaceOptions = {},
): WorkspaceConfig {
  const { id, name } = resolveWorkspaceIdentity(options);
  const filesystemSourceKey = `${id}:${++workspaceSourceSequence}`;
  const paths = resolveDatabricksWorkspacePaths(options);
  const configuredPaths = paths.length;
  const extraSkillPaths = options.extraSkillPaths ?? [];
  const filesCache = pluginRegistry.instance(options.pluginContext, filesCachePlugin)?.exports();
  const configuredCache = options.cache;
  const mountFilesCache = configuredCache === false ? undefined : filesCache;
  const retainFilesystemSource =
    mountFilesCache !== undefined &&
    typeof configuredCache !== "function" &&
    paths.every((path) => typeof path !== "function");
  const resolvers = buildMountResolvers(
    paths,
    options.mounts,
    localSkillMountResolvers(extraSkillPaths),
    mountFilesCache,
    configuredCache,
  );
  const resolveContribution = contributionResolver(resolvers);
  const resolveFilesystem = (context: DatabricksWorkspaceContext) =>
    resolveWorkspaceFilesystem(
      resolveContribution,
      context,
      retainFilesystemSource ? mountFilesCache : undefined,
      filesystemSourceKey,
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
  const bm25 = options.bm25 ?? true;
  const sandbox = resolveWorkspaceSandbox(options.sandbox, id, name);
  const tools = workspaceTools(options.tools);
  logger.debug("workspace:create", {
    id,
    name,
    resolverCount: resolvers.length,
    configuredPaths,
    customMounts: Object.keys(options.mounts ?? {}).length,
    customSkillsResolver: Boolean(options.skills),
    checkSkillFileMtime,
    bm25,
    extraSkillPaths: extraSkillPaths.length,
    sandbox: sandbox ? sandboxName(options.sandbox) : "disabled",
  });

  const {
    assistantPaths: _assistantPaths,
    paths: _paths,
    mounts: _mounts,
    skills: _skills,
    cache: _cache,
    pluginContext: _pluginContext,
    sandbox: _sandbox,
    extraSkillPaths: _extraSkillPaths,
    ...workspaceOptions
  } = options;
  return {
    ...workspaceOptions,
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
  };
}

/** Create a native Mastra {@link Workspace} from {@link databricksWorkspaceConfig}. */
export function databricksWorkspace(options: DatabricksWorkspaceOptions = {}): Workspace {
  const workspace = new Workspace(databricksWorkspaceConfig(options));
  databricksWorkspaceOptions.set(workspace, options);
  return workspace;
}

/** @internal Bind a caller-created Databricks workspace to its AppKit plugin context. */
export function bindDatabricksWorkspaceContext(
  workspace: Workspace,
  pluginContext: pluginRegistry.PluginContextLike | undefined,
): Workspace {
  const options = databricksWorkspaceOptions.get(workspace);
  if (!options || options.pluginContext !== undefined || pluginContext === undefined) {
    return workspace;
  }
  return databricksWorkspace({ ...options, pluginContext });
}

/**
 * Resolve default and caller-provided Databricks paths in priority order.
 */
export function resolveDatabricksWorkspacePaths(
  options: Pick<DatabricksWorkspaceOptions, "assistantPaths" | "paths"> = {},
): DatabricksWorkspacePathValue[] {
  return [
    ...(options.assistantPaths === false ? [] : DEFAULT_DATABRICKS_WORKSPACE_PATHS),
    ...(options.paths ?? []),
  ];
}

/* ---------------------------- private helpers ---------------------------- */

function workspaceTools(configured: WorkspaceToolsConfig | undefined): WorkspaceToolsConfig {
  return {
    enabled: true,
    requireApproval: false,
    ...configured,
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
async function resolveFilesCacheScope(context: DatabricksWorkspaceContext): Promise<
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
  paths: readonly DatabricksWorkspacePathValue[],
  context: DatabricksWorkspaceContext,
  filesCache: FilesCacheExports | undefined,
  cacheConfig: DatabricksWorkspaceCache | undefined,
): Promise<WorkspaceMountContribution> {
  const mounts: Record<string, WorkspaceFilesystem> = {};
  const skillPaths: string[] = [];
  const requestContext = context.requestContext;

  const canMountDatabricks = Boolean(requestContext && shouldMountSkillFolders(requestContext));
  const scoped = canMountDatabricks ? await resolveFilesCacheScope(context) : undefined;
  const client = scoped?.client;
  const fileSystemCache =
    filesCache && scoped ? await filesCache.forScope(scoped.scope) : undefined;

  for (const [index, path] of paths.entries()) {
    const configured = await resolveDatabricksWorkspacePath(path, context);
    if (!configured) continue;
    if (posixPath.isWithinRoot(SCRATCH_MOUNT, configured.path)) {
      const mount = configured.mount ?? configured.path;
      mounts[mount] = userTempFilesystem(context, configured.path);
      if (configured.readable !== false) {
        skillPaths.push(...(configured.skills ?? []).map((path) => mountedSkillPath(mount, path)));
      }
      continue;
    }
    if (!canMountDatabricks) {
      logger.debug("workspace-path:skipped", {
        path: configured.path,
        reason: !requestContext ? "no-request-context" : "missing-workspace-scope",
      });
      continue;
    }
    const resolved = await resolveSkillFolderFilesystem(configured, context, cacheConfig, {
      client,
      fileSystemCache,
    });
    if (!resolved) continue;
    const mount = configured.mount ?? resolved.root;
    if (!mount) {
      logger.debug("workspace-path:skipped", { index, reason: "missing-mount" });
      continue;
    }
    mounts[mount] = resolved.filesystem;
    if (configured.readable !== false) {
      skillPaths.push(...(configured.skills ?? ["."]).map((path) => mountedSkillPath(mount, path)));
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

interface ResolvedDatabricksWorkspacePath {
  path: string;
  displayName?: string;
  description?: string;
  readable?: boolean;
  skills?: readonly string[];
  writable?: boolean;
  createRoot?: boolean;
  mount?: string;
}

async function resolveDatabricksWorkspacePath(
  value: DatabricksWorkspacePathValue,
  context: DatabricksWorkspaceContext,
): Promise<ResolvedDatabricksWorkspacePath | undefined> {
  const selected = typeof value === "function" ? await value(context) : value;
  if (selected === false || selected === undefined) return undefined;
  const configured = typeof selected === "string" ? { path: selected } : selected;
  const requestContext = requestContextValues(context.requestContext);
  const resolvedPath = resolveHomePath(configured.path, requestContext);
  if (!resolvedPath) return undefined;
  const resolvedMount = resolveHomePath(configured.mount, requestContext);
  return {
    ...configured,
    path: resolvedPath,
    ...(resolvedMount ? { mount: resolvedMount } : {}),
  };
}

/**
 * Resolve one skill folder to a Mastra filesystem, or `undefined` to skip it
 * for this request.
 */
async function resolveSkillFolderFilesystem(
  folder: ResolvedDatabricksWorkspacePath,
  context: DatabricksWorkspaceContext,
  cacheConfig: DatabricksWorkspaceCache | undefined,
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
  // A path mount needs the request's OBO client to reach the workspace.
  if (!cache.client) {
    logger.debug("skill-folder:skipped", {
      path: folder.path,
      reason: "missing-obo-client",
    });
    return undefined;
  }
  const root = stringUtils.trimToNull(folder.path);
  if (!root) return undefined;
  const writable = folder.writable ?? isWorkspaceRoot(root);
  const cacheOptions = cache.fileSystemCache
    ? await resolveFileCacheOptions(
        cacheConfig,
        context,
        root,
        folder.readable === false ? [] : (folder.skills ?? ["."]),
      )
    : undefined;
  const resolved = await databricksFilesystem(
    cache.client,
    root,
    !writable,
    folder.createRoot ?? folder.writable === true,
    cache.fileSystemCache,
    cacheOptions,
    {
      ...(folder.description ? { description: folder.description } : {}),
      ...(folder.displayName ? { displayName: folder.displayName } : {}),
    },
  );
  return resolved ? { ...resolved, root } : undefined;
}

async function resolveCacheConfig(
  value: DatabricksWorkspaceCache | undefined,
  context: DatabricksWorkspaceContext,
): Promise<
  boolean | DatabricksWorkspaceCacheFilter | readonly DatabricksWorkspaceCacheFilter[] | undefined
> {
  return typeof value === "function" ? value(context) : value;
}

function requestContextValues(requestContext: RequestContext | undefined): Record<string, unknown> {
  return requestContext?.toJSON() ?? {};
}

function resolveHomePath(
  input: string | undefined,
  requestContext: Record<string, unknown>,
): string | undefined {
  const value = stringUtils.trimToNull(input);
  if (!value || (value !== "~" && !value.startsWith("~/"))) return value ?? undefined;
  const emailValue = requestContext[MASTRA_USER_EMAIL_KEY];
  const email = typeof emailValue === "string" ? stringUtils.trimToNull(emailValue) : undefined;
  if (!email) return undefined;
  const home = personalWorkspacePath(email);
  return value === "~" ? home : `${home}/${value.slice(2)}`;
}

function toPolicyArray<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function cacheFilterMatches(
  policy: DatabricksWorkspaceCacheFilter,
  operation: CacheableFileSystemOperation,
  path: string,
  requestContext: Record<string, unknown>,
  root?: string,
): boolean {
  const operations = toPolicyArray(policy.operations ?? CACHEABLE_FILESYSTEM_OPERATIONS);
  if (!operations.includes(operation)) return false;
  if (policy.paths === undefined) return true;
  const inputs: PathMatchInput[] = [];
  for (const input of toPolicyArray<PathMatchInput>(policy.paths)) {
    if (typeof input !== "string") {
      inputs.push(input);
      continue;
    }
    const expanded = resolveHomePath(input, requestContext);
    if (!expanded) continue;
    inputs.push(
      !root || posixPath.isAbsolute(expanded) || expanded.startsWith("**")
        ? expanded
        : `${posixPath.normalizeRoot(root)}/${expanded.replace(/^\.\//, "")}`,
    );
  }
  return inputs.length > 0 && match.toPathMatcher(...inputs)(path);
}

async function resolveFileCacheOptions(
  configured: DatabricksWorkspaceCache | undefined,
  context: DatabricksWorkspaceContext,
  root: string,
  skillPaths: readonly string[],
): Promise<FileSystemCacheOptions | undefined> {
  const requestContext = requestContextValues(context.requestContext);
  const resolved = await resolveCacheConfig(configured, context);
  if (resolved === false) return undefined;
  if (resolved === undefined || resolved === true) {
    const roots = skillPaths.map((path) => mountedSkillPath(root, path));
    return {
      operations: CACHEABLE_FILESYSTEM_OPERATIONS,
      filter: (operation, path) =>
        operation !== "readFile" ||
        roots.some((skillRoot) => posixPath.isWithinRoot(skillRoot, path)),
    };
  }
  const policies = toPolicyArray(resolved);
  if (policies.length === 0) return undefined;
  const operations = [
    ...new Set(
      policies.flatMap((policy) =>
        toPolicyArray(policy.operations ?? CACHEABLE_FILESYSTEM_OPERATIONS),
      ),
    ),
  ];
  return {
    operations,
    filter: (operation, path) =>
      policies.some((policy) => cacheFilterMatches(policy, operation, path, requestContext, root)),
  };
}

/**
 * Fill in `id` and `name` when either is omitted on {@link DatabricksWorkspaceOptions}.
 * Slugifies `name` into `id`; tokenizes `id` into a display `name`.
 */
function resolveWorkspaceIdentity(options: DatabricksWorkspaceOptions): {
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
  paths: readonly DatabricksWorkspacePathValue[],
  mounts: Record<string, WorkspaceFilesystem> | undefined,
  localMounts: WorkspaceMountResolver[],
  filesCache: FilesCacheExports | undefined,
  cacheConfig: DatabricksWorkspaceCache | undefined,
): WorkspaceMountResolver[] {
  const resolvers: WorkspaceMountResolver[] = [];
  const pathCount = paths.length;
  if (pathCount > 0) {
    resolvers.push((context) => resolveSkillFolderMounts(paths, context, filesCache, cacheConfig));
  }
  if (mounts && Object.keys(mounts).length > 0) resolvers.push(() => ({ mounts }));
  resolvers.push(...localMounts);
  logger.debug("mounts:resolvers", {
    pathCount,
    customMountCount: Object.keys(mounts ?? {}).length,
    localMountCount: localMounts.length,
    totalResolverCount: resolvers.length,
  });
  return resolvers;
}

/** Stable user-scoped local storage under the host operating system's temp directory. */
function userTempFilesystem(
  context: DatabricksWorkspaceContext,
  workspacePath: string,
): WorkspaceFilesystem {
  const userKey = resolveUserKey(context.requestContext);
  const digest = createHash("sha256")
    .update(object.toStableKey({ package: "@dbx-tools/appkit-mastra", userKey }))
    .digest("hex")
    .slice(0, 16);
  const normalized = posixPath.normalizeRoot(workspacePath);
  const relative = normalized === SCRATCH_MOUNT ? "" : normalized.slice(`${SCRATCH_MOUNT}/`.length);
  const source = new LocalFileSystem({
    root: join(tmpdir(), "dbx-tools", "mastra", digest, relative),
    readOnly: false,
    createRoot: true,
  });
  return filesystems(source, {
    displayName: "Temporary Files",
    description:
      "User-scoped temporary files retained while the host keeps its ephemeral temp storage.",
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

/**
 * Wrap a {@link DatabricksFileSystem} as a Mastra filesystem. Missing or
 * inaccessible roots return `undefined` so other accessible roots remain
 * usable.
 */
async function databricksFilesystem(
  client: WorkspaceClient,
  root: string,
  readOnly: boolean = true,
  createRoot: boolean = !readOnly,
  fileSystemCache?: FileSystemCache,
  cacheOptions?: FileSystemCacheOptions,
  adapterOptions: Pick<MastraFileSystemAdapterOptions, "description" | "displayName"> = {},
): Promise<
  | {
      filesystem: WorkspaceFilesystem;
    }
  | undefined
> {
  const initialClient = workspaceClient.toLegacyWorkspaceClient(client);
  const fs = new DatabricksFileSystem({
    client: () => {
      const executionContext = appkit.tryGetExecutionContext();
      if (
        executionContext &&
        "isUserContext" in executionContext &&
        executionContext.isUserContext === true
      ) {
        return workspaceClient.toLegacyWorkspaceClient(executionContext.client);
      }
      return initialClient;
    },
    root,
    readOnly,
    createRoot,
  });
  const cached =
    fileSystemCache && cacheOptions ? sharedFS.cache(fs, fileSystemCache, cacheOptions) : fs;
  const source = verifyFirstFileSystemAccess(cached, () => fs.stat("."), root);
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

function verifyFirstFileSystemAccess<TFileSystem extends FileSystem>(
  filesystem: TFileSystem,
  readProbe: () => Promise<unknown>,
  root: string,
): TFileSystem {
  let readCheck: Promise<void> | undefined;
  let writeVerified = false;
  const boundMethods = new Map<PropertyKey, unknown>();
  const readOperations = new Set<PropertyKey>(["exists", "readFile", "readdir", "stat"]);
  const writeOperations = new Set<PropertyKey>([
    "appendFile",
    "copyFile",
    "deleteFile",
    "mkdir",
    "moveFile",
    "rmdir",
    "writeFile",
  ]);
  const verifyRead = async (): Promise<void> => {
    readCheck ??= Promise.resolve(readProbe()).then(() => undefined);
    try {
      await readCheck;
    } catch (error) {
      readCheck = undefined;
      logger.debug("databricks-mount:read-check-failed", {
        root,
        error: errorUtils.errorMessage(error),
      });
      throw error;
    }
  };

  return new Proxy(filesystem, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (boundMethods.has(property)) return boundMethods.get(property);
      const delegated = value.bind(target) as (...args: unknown[]) => unknown;
      let method = delegated;
      if (readOperations.has(property)) {
        method = async (...args: unknown[]) => {
          await verifyRead();
          return delegated(...args);
        };
      } else if (writeOperations.has(property)) {
        method = async (...args: unknown[]) => {
          try {
            const result = await delegated(...args);
            if (!writeVerified) {
              writeVerified = true;
              logger.debug("databricks-mount:write-check-passed", { root });
            }
            return result;
          } catch (error) {
            if (!writeVerified) {
              logger.debug("databricks-mount:write-check-failed", {
                root,
                error: errorUtils.errorMessage(error),
              });
            }
            throw error;
          }
        };
      }
      boundMethods.set(property, method);
      return method;
    },
  });
}

/**
 * Run every mount resolver for one request and merge mounts plus skill paths.
 * Later resolvers overwrite mount keys from earlier ones.
 */
async function resolveWorkspaceContribution(
  resolvers: WorkspaceMountResolver[],
  context: DatabricksWorkspaceContext,
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
 * Returns a {@link CompositeFilesystem} over every path that resolved for the
 * request. An empty composite exposes no implicit local storage.
 */
async function resolveWorkspaceFilesystem(
  resolveContribution: (context: DatabricksWorkspaceContext) => Promise<WorkspaceMountContribution>,
  context: DatabricksWorkspaceContext,
  filesCache?: FilesCacheExports,
  sourceKey?: string,
): Promise<WorkspaceFilesystem> {
  const { mounts } = await resolveContribution(context);
  const mountKeys = Object.keys(mounts);
  if (mountKeys.length === 0) {
    logger.debug("filesystem:empty", {
      hasRequestContext: Boolean(context.requestContext),
    });
    return filesystems(new MemoryFileSystem({ root: "/", readOnly: true }), {
      readOnly: true,
    });
  }
  logger.debug("filesystem:composite", { mountKeys });
  const load = () => new MountedCompositeFilesystem({ mounts });
  if (!filesCache) return load();
  const scoped = await resolveFilesCacheScope(context);
  if (!scoped) return load();
  return filesCache.forFileSystem(scoped.scope, { paths: mountKeys, key: sourceKey }, load);
}

/**
 * Expand skill roots into concrete skill directories and keep the first
 * same-named directory. Mastra still owns parsing, indexing, and refreshes,
 * while earlier configured roots retain precedence over later roots.
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
): (context: DatabricksWorkspaceContext) => Promise<WorkspaceMountContribution> {
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
