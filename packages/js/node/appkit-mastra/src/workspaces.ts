/**
 * Mastra workspace factory for Databricks Apps.
 *
 * Builds a per-request {@link Workspace} with Databricks Sandbox command
 * execution plus a {@link CompositeFilesystem} over the NAMED skill folders
 * resolved for that request. A skill folder maps a name to a location plus its
 * readable / writable policy: a Databricks path mounted through the OBO client
 * on {@link MASTRA_USER_KEY}, or any {@link WorkspaceFilesystem} a consuming
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

import { createHash } from "node:crypto";
import { ConfigurationError, createWorkspaceClient } from "@databricks/appkit";
import type { WorkspaceClient } from "@databricks/appkit";
import { DatabricksFileSystem, workspaceClient } from "@dbx-tools/databricks";
import { errorUtils, log, object, stringUtils, token } from "@dbx-tools/shared-core";
import { posixPath } from "@dbx-tools/shared-fs";
import type { RequestContext } from "@mastra/core/request-context";
import {
  CompositeFilesystem,
  Workspace,
  type SkillsContext,
  type SkillsResolver,
  type WorkspaceFilesystem,
  type WorkspaceSandbox,
  type WorkspaceSandboxResolver,
} from "@mastra/core/workspace";

import {
  MASTRA_SCOPES_KEY,
  MASTRA_USER_EMAIL_KEY,
  MASTRA_USER_KEY,
  resolveUserKey,
  type User,
} from "./config.ts";
import { scratchFilesystem } from "./filesystems.ts";
import { MontySandbox } from "./monty-sandbox.ts";
import { DatabricksSandbox, type DatabricksWorkspaceSandboxOptions } from "./sandbox.ts";
import { cachedWorkspaceSkillMount, DEFAULT_WORKSPACE_SKILL_CACHE_TTL_MS } from "./skill-cache.ts";
import { ASSISTANT_SHARED_SKILLS_PATH, userAssistantSkillsPath } from "./skill-paths.ts";

/* ------------------------------ constants ------------------------------ */

/** OAuth scopes that gate Databricks workspace file mounts. */
const WORKSPACE_FILE_SCOPES = ["workspace", "workspace.workspace", "all-apis"] as const;

const logger = log.logger("mastra/workspaces");
const MAX_SCOPED_WORKSPACE_FILESYSTEMS = 16;
const scopedWorkspaceFilesystems = new Map<string, WorkspaceFilesystem>();

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
  /**
   * Stable identity for this contribution. When every non-empty contribution
   * supplies one, Mastra reuses the resolved source across requests.
   */
  cacheKey?: string;
}

/** Contributes filesystem mounts (and optional skill paths) for one request. */
export type WorkspaceMountResolver = (
  context: WorkspaceMountContext,
) => WorkspaceMountContribution | Promise<WorkspaceMountContribution>;

/** Names carried by {@link DEFAULT_SKILL_FOLDERS}. */
export type DefaultSkillFolderName = "workspace-team" | "workspace-team-app";

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
  /**
   * AppKit cache TTL for Databricks skill metadata and content.
   * Defaults to five minutes.
   */
  workspaceSkillRefreshTtlMs?: number;
  /** Enable BM25 keyword search over indexed workspace content. */
  bm25?: boolean;
  /**
   * Command sandbox. Defaults to Databricks Sandbox. Pass `false` to disable
   * command execution, or an explicit Mastra sandbox/provider resolver to
   * replace Databricks for this workspace.
   */
  sandbox?: WorkspaceSandboxSelection;
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
  const resolvers = buildMountResolvers(
    skillFolders,
    options.mounts,
    options.workspaceSkillRefreshTtlMs,
  );
  const extraSkillPaths = options.extraSkillPaths ?? [];
  const skills =
    options.skills ??
    (resolvers.length > 0 || extraSkillPaths.length > 0
      ? buildWorkspaceSkillsResolver(resolvers, extraSkillPaths)
      : undefined);
  const checkSkillFileMtime = options.checkSkillFileMtime ?? folderNames.length > 0;
  const bm25 = options.bm25 !== false;
  const sandbox = resolveWorkspaceSandbox(options.sandbox, id, name);
  logger.debug("workspace:create", {
    id,
    name,
    resolverCount: resolvers.length,
    skillFolders: folderNames,
    customMountResolvers: options.mounts?.length ?? 0,
    customSkillsResolver: Boolean(options.skills),
    checkSkillFileMtime,
    workspaceSkillRefreshTtlMs:
      options.workspaceSkillRefreshTtlMs ?? DEFAULT_WORKSPACE_SKILL_CACHE_TTL_MS,
    bm25,
    extraSkillPaths: extraSkillPaths.length,
    sandbox: sandbox ? sandboxName(options.sandbox) : "disabled",
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
    ...(sandbox
      ? {
          sandbox,
          instructions: { dynamicSandbox: "resolve" as const },
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

function resolveWorkspaceSandbox(
  selection: WorkspaceSandboxSelection | undefined,
  workspaceId: string,
  workspaceName: string,
): WorkspaceSandbox | WorkspaceSandboxResolver | undefined {
  const configured = selection ?? "databricks";
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
  if (selection === undefined || selection === "databricks") return "databricks";
  if (selection === "monty") return "monty";
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

/**
 * Mount resolver for the named skill folders.
 *
 * Gates on workspace file scope (or development mode), then mounts every
 * folder whose location resolves for this request.
 */
async function resolveSkillFolderMounts(
  skillFolders: Record<string, SkillFolderOptions>,
  context: WorkspaceMountContext,
  workspaceSkillRefreshTtlMs: number,
): Promise<WorkspaceMountContribution> {
  const mounts: Record<string, WorkspaceFilesystem> = {};
  const skillPaths: string[] = [];
  const cacheKeys: string[] = [];
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
  const userKey = user ? resolveUserKey(requestContext) : undefined;
  const host = client ? (await client.config.getHost()).toString() : undefined;

  for (const [name, folder] of Object.entries(skillFolders)) {
    const resolved = await resolveSkillFolderFilesystem(name, folder, context, {
      client,
      host,
      userKey,
      workspaceSkillRefreshTtlMs,
    });
    if (!resolved) continue;
    const mount = folder.mount ?? `/${name}`;
    mounts[mount] = resolved.filesystem;
    if (resolved.cacheKey) cacheKeys.push(resolved.cacheKey);
    if (folder.readable !== false) skillPaths.push(mount);
  }

  logger.debug("skill-folders:mounted", {
    mountKeys: Object.keys(mounts),
    skillPaths,
  });

  return {
    mounts,
    skillPaths,
    ...(cacheKeys.length === Object.keys(mounts).length && cacheKeys.length > 0
      ? { cacheKey: object.toStableKey(cacheKeys.sort()) }
      : {}),
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
    host: string | undefined;
    userKey: string | undefined;
    workspaceSkillRefreshTtlMs: number;
  },
): Promise<{ cacheKey?: string; filesystem: WorkspaceFilesystem } | undefined> {
  if (folder.filesystem !== undefined) {
    const filesystem = await resolveSkillFolderValue(folder.filesystem, context);
    return filesystem ? { filesystem } : undefined;
  }
  // A path mount needs the request's OBO client to reach the workspace.
  if (folder.path === undefined || !cache.client || !cache.host || !cache.userKey) {
    logger.debug("skill-folder:skipped", {
      name,
      reason: folder.path === undefined ? "no-location" : "missing-obo-client",
    });
    return undefined;
  }
  const root = stringUtils.trimToNull(await resolveSkillFolderValue(folder.path, context));
  if (!root) return undefined;
  return databricksFilesystem(cache.client, root, folder.writable !== true, {
    host: cache.host,
    ttlMs: cache.workspaceSkillRefreshTtlMs,
    userKey: cache.userKey,
  });
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
  workspaceSkillRefreshTtlMs = DEFAULT_WORKSPACE_SKILL_CACHE_TTL_MS,
): WorkspaceMountResolver[] {
  const resolvers: WorkspaceMountResolver[] = [];
  const folderCount = Object.keys(skillFolders).length;
  if (folderCount > 0) {
    resolvers.push((context) =>
      resolveSkillFolderMounts(skillFolders, context, workspaceSkillRefreshTtlMs),
    );
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
  return stringUtils.trimToNull(requestContext?.get(MASTRA_USER_EMAIL_KEY)) ?? undefined;
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
  cache: { host: string; ttlMs: number; userKey: string },
): Promise<{ cacheKey: string; filesystem: WorkspaceFilesystem } | undefined> {
  const fs = new DatabricksFileSystem({
    client: workspaceClient.toLegacyWorkspaceClient(client),
    root,
    readOnly,
    createRoot: !readOnly,
  });
  const cached = cachedWorkspaceSkillMount({
    host: cache.host,
    source: fs,
    ttlMs: cache.ttlMs,
    userKey: cache.userKey,
  });
  try {
    await cached.filesystem.init();
    if (await cached.filesystem.exists(".")) return cached;
  } catch (err) {
    logger.debug("databricks-mount:scratch-fallback", {
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
  const cacheKeys: string[] = [];
  let cacheable = true;

  for (const [index, resolver] of resolvers.entries()) {
    const contribution = await resolver(context);
    logger.debug("mounts:resolver", {
      index,
      mountKeys: Object.keys(contribution.mounts),
      skillPaths: contribution.skillPaths ?? [],
    });
    Object.assign(mounts, contribution.mounts);
    if (Object.keys(contribution.mounts).length > 0) {
      if (contribution.cacheKey) cacheKeys.push(contribution.cacheKey);
      else cacheable = false;
    }
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
    ...(cacheable && cacheKeys.length > 0
      ? { cacheKey: object.toStableKey(cacheKeys.sort()) }
      : {}),
  };
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
  const { cacheKey, mounts } = await resolveWorkspaceContribution(resolvers, context);
  const mountKeys = Object.keys(mounts);
  if (mountKeys.length === 0) {
    logger.debug("filesystem:scratch", {
      hasRequestContext: Boolean(context.requestContext),
    });
    return scratchFilesystem();
  }
  logger.debug("filesystem:composite", { mountKeys });
  if (!cacheKey) return new CompositeFilesystem({ mounts });
  const existing = scopedWorkspaceFilesystems.get(cacheKey);
  if (existing) {
    scopedWorkspaceFilesystems.delete(cacheKey);
    scopedWorkspaceFilesystems.set(cacheKey, existing);
    return existing;
  }
  const filesystem = new CompositeFilesystem({ mounts });
  scopedWorkspaceFilesystems.set(cacheKey, filesystem);
  while (scopedWorkspaceFilesystems.size > MAX_SCOPED_WORKSPACE_FILESYSTEMS) {
    const oldest = scopedWorkspaceFilesystems.keys().next().value;
    if (oldest === undefined) break;
    scopedWorkspaceFilesystems.delete(oldest);
  }
  return filesystem;
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
    const contribution = await resolveWorkspaceContribution(resolvers, context);
    const skillPaths = await uniqueSkillPaths(contribution);
    const merged = [...skillPaths, ...extraSkillPaths];
    logger.debug("skills:resolved", {
      configuredSkillPaths: contribution.skillPaths,
      skillPaths,
      extraSkillPaths,
    });
    return merged;
  };
}

/** Expand mounted roots and keep the first concrete skill for each directory name. */
async function uniqueSkillPaths(contribution: WorkspaceMountContribution): Promise<string[]> {
  const selected = new Map<string, string>();
  const unresolved: string[] = [];
  for (const root of contribution.skillPaths ?? []) {
    const mount = mountedFilesystem(root, contribution.mounts);
    if (!mount) {
      unresolved.push(root);
      continue;
    }
    let candidates: string[];
    try {
      candidates = await concreteSkillPaths(root, mount.path, mount.filesystem);
    } catch (error) {
      logger.debug("skills:root-expansion-failed", {
        root,
        error: errorUtils.errorMessage(error),
      });
      unresolved.push(root);
      continue;
    }
    if (candidates.length === 0) {
      unresolved.push(root);
      continue;
    }
    for (const candidate of candidates) {
      const name = posixPath.basename(candidate);
      const existing = selected.get(name);
      if (existing) {
        logger.debug("skills:duplicate-skipped", { name, path: candidate, selected: existing });
      } else {
        selected.set(name, candidate);
      }
    }
  }
  return [...selected.values(), ...unresolved];
}

/** Find the most-specific mounted filesystem containing one skill path. */
function mountedFilesystem(
  skillPath: string,
  mounts: Readonly<Record<string, WorkspaceFilesystem>>,
): { filesystem: WorkspaceFilesystem; path: string } | undefined {
  return Object.entries(mounts)
    .filter(([mount]) => skillPath === mount || skillPath.startsWith(`${mount}/`))
    .sort(([left], [right]) => right.length - left.length)
    .map(([path, filesystem]) => ({ filesystem, path }))[0];
}

/** Return concrete child skill directories from one mounted skill root. */
async function concreteSkillPaths(
  root: string,
  mount: string,
  filesystem: WorkspaceFilesystem,
): Promise<string[]> {
  const relativeRoot = root === mount ? "." : root.slice(mount.length + 1);
  if (await filesystem.exists(posixPath.join(relativeRoot, "SKILL.md"))) return [root];
  const entries = await filesystem.readdir(relativeRoot);
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "directory") continue;
    const relative = posixPath.join(relativeRoot, entry.name);
    if (await filesystem.exists(posixPath.join(relative, "SKILL.md"))) {
      candidates.push(posixPath.join(root, entry.name));
    }
  }
  return candidates;
}
