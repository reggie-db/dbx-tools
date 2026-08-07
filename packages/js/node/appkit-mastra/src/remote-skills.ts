/**
 * Startup provisioning of remote Agent-Skill sources for a Mastra workspace.
 *
 * A {@link RemoteSkillSource} names WHERE a `SKILL.md` tree comes from - the
 * {@link AITOOLS_SOURCE} constant, a GitHub `owner/repo`, any git / GitLab URL,
 * or a direct download URL - and optional per-source policy.
 * {@link provisionRemoteSkills} materializes every source into a local
 * `SKILL.md` tree at app boot and returns the directories to hand Mastra as
 * extra skill scan paths.
 *
 * Resolution per source, in order:
 *
 * 1. the {@link AITOOLS_SOURCE} constant (`"aitools"`): Databricks' own skill
 *    set, read straight from the public repo the `databricks aitools` CLI
 *    sources from. No CLI, no Databricks auth - which is what makes it usable
 *    inside a Databricks App container, where the CLI is not installed;
 * 2. the OPTIONAL `skills` npm CLI (peer dep): if installed, each source is
 *    copied into a staging dir with `skills add <source> --agent <dir> --copy`,
 *    which understands every source format the ecosystem does (GitHub
 *    shorthand, git URLs, archive/download URLs);
 * 3. otherwise a plain {@link fetch} of the source URL (built with
 *    {@link net.urlBuilder}), writing the downloaded `SKILL.md` to a staging
 *    dir.
 *
 * A source that resolves through neither path fails app startup, unless the
 * source (or the top-level call) sets `failOnError: false`, in which case it is
 * logged and skipped so one bad source never takes the app down.
 *
 * Every provisioned tree carries a {@link METADATA_FILE} recording when each
 * source was last downloaded, and a source is only re-downloaded once that
 * record is older than {@link DEFAULT_REFRESH_TTL_MS} (seven days). This runs at app
 * BOOT, so without it a container that restarts a dozen times an hour re-pulls
 * the whole AI Tools set a dozen times for content that changes rarely. The
 * record travels WITH the tree rather than in process memory, so the reuse
 * survives a restart - which is the only way it helps a Databricks App at all.
 * Pass `refreshTtlMs: 0` to download on every boot.
 *
 * The default destination is the Databricks workspace Assistant skills tree
 * (`/Workspace/.assistant/skills`, the same tree a "save this as a skill"
 * action writes to), so provisioned skills persist across restarts and are
 * discovered by the built-in Assistant-skills mount. Pass `userEmail` (or an
 * explicit `databricksBasePath`) to target `/Users/<email>/.assistant/skills`
 * instead. When no Databricks client is resolvable at startup - or the resolved
 * identity cannot WRITE the destination, which is the normal case for a
 * Databricks App service principal against the admin-owned shared tree (see
 * {@link openWritableWorkspace}) - the tree is written under
 * {@link localFS.tmpFS} and returned as an extra local skill path for the
 * current process. Storage location degrades; the skills themselves do not.
 *
 * @module
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { appkit } from "@dbx-tools/appkit";
import type { WorkspaceClientLike } from "@dbx-tools/appkit";
import { exec } from "@dbx-tools/core";
import { DatabricksFileSystem } from "@dbx-tools/databricks";
import { localFS, type LocalFileSystem } from "@dbx-tools/fs";
import { find } from "@dbx-tools/path";
import { error, hash, json, log, net, object, string } from "@dbx-tools/shared-core";
import type { OneOrMany } from "@dbx-tools/shared-core";
import type { FileSystem } from "@dbx-tools/shared-fs";

import { ASSISTANT_SHARED_SKILLS_PATH, userAssistantSkillsPath } from "./skill-paths.ts";

const logger = log.logger("mastra/remote-skills");

/**
 * Agent id the `skills` CLI installs a bare `SKILL.md` tree under.
 *
 * `universal` is the CLI's own name for "no particular agent, just the plain
 * tree", which is what this module wants - it re-hosts the result itself. The
 * id must be one the installed CLI knows: an unrecognized one is rejected
 * outright (`Invalid agents: ...`), taking every non-`aitools` source down with
 * it, since a CLI failure is a hard failure rather than a fall-through to
 * {@link stageViaFetch}.
 */
const SKILLS_CLI_AGENT = "universal";

/** Where the `skills` CLI drops a plain `SKILL.md` tree under a target dir. */
const SKILLS_CLI_LAYOUT = [".agents", "skills"] as const;

/** Cap on a direct-fetch download body, matching the `skills` CLI default. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Maximum time one remote file download may block startup. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Stable temp directory holding one rebuilt skill tree per remote source. */
const LOCAL_SKILLS_DIR = "mastra-local-skills";

/**
 * Bookkeeping file written at the root of every provisioned skill tree, naming
 * when each source was last downloaded. A dotfile so the skill scanners, which
 * look for `<dir>/SKILL.md`, never mistake it for a skill.
 */
const METADATA_FILE = ".metadata.json";

/** Shape marker for {@link METADATA_FILE}; an unknown version is ignored, not read. */
const METADATA_VERSION = 1;

/** How long a provisioned source is reused before being downloaded again. */
const DEFAULT_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------ AI Tools ------------------------------ */

/**
 * Source constant selecting Databricks' own AI Tools skill set.
 *
 * @example
 * mastra({ remoteSkills: "aitools" });
 */
export const AITOOLS_SOURCE = "aitools";

/** The {@link AITOOLS_SOURCE} literal, for callers spelling the union out. */
export type AiToolsSource = typeof AITOOLS_SOURCE;

/**
 * The PUBLIC repo `databricks aitools install` sources from. Reading it
 * directly is what lets an app get the same skills the CLI installs without
 * the CLI - which a Databricks App container does not ship.
 */
const AITOOLS_REPO = "databricks/databricks-agent-skills";

/** Repo ref the skills are read from. Override per source with `ref`. */
const AITOOLS_REF = "main";

/** Skill files downloaded at once; the set is ~30 skills of a few files each. */
const AITOOLS_CONCURRENCY = 8;

/** The subset of the repo's generated `manifest.json` this module reads. */
interface AiToolsManifest {
  skills?: Record<string, { files?: string[]; repo_dir?: string }>;
}

/* -------------------------------- types -------------------------------- */

/**
 * One remote skill source and its per-source policy.
 *
 * `source` is {@link AITOOLS_SOURCE} or anything the `skills` ecosystem
 * understands: a GitHub `owner/repo` shorthand, a full GitHub / GitLab / git
 * URL, or a direct download URL to a `SKILL.md` or archive.
 */
export interface RemoteSkillSourceOptions {
  /** `"aitools"`, a GitHub shorthand, a git / GitLab URL, or a download URL. */
  source: net.UrlLike | AiToolsSource;
  /** Install only these skill names from the source. */
  skills?: string | string[];
  /** Include experimental skills. `"aitools"` only. */
  experimental?: boolean;
  /** Pin the repo ref (tag / branch / sha). `"aitools"` only; defaults to `main`. */
  ref?: string;
  /** Override the byte ceiling on a direct-fetch download for this source. */
  maxDownloadBytes?: number;
  /**
   * How long this source's provisioned tree is reused before it is downloaded
   * again, in milliseconds. Overrides the top-level
   * {@link ProvisionRemoteSkillsOptions.refreshTtlMs}; `0` re-downloads on
   * every boot.
   */
  refreshTtlMs?: number;
  /**
   * When `false`, a source that fails to resolve is logged and skipped instead
   * of failing app startup. Overrides the top-level {@link ProvisionRemoteSkillsOptions.failOnError}.
   */
  failOnError?: boolean;
}

/**
 * A remote skill source: the {@link AITOOLS_SOURCE} constant, a URL-like
 * (string / `URL` / `{ url }`), or a {@link RemoteSkillSourceOptions} bag with
 * per-source policy.
 */
export type RemoteSkillSource = net.UrlLike | AiToolsSource | RemoteSkillSourceOptions;

/**
 * The workspace `remoteSkills` option: one source, a non-empty list of them, or
 * a {@link ProvisionRemoteSkillsOptions} bag when top-level policy is needed.
 */
export type RemoteSkillsOption =
  RemoteSkillSource | OneOrMany<RemoteSkillSource> | ProvisionRemoteSkillsOptions;

/** A source entry with its `source` flattened to a plain string. */
type NormalizedSource = Omit<RemoteSkillSourceOptions, "source"> & { source: string };

/** Top-level remote-skills provisioning options. */
export interface ProvisionRemoteSkillsOptions {
  /** Sources to materialize at startup. */
  sources: RemoteSkillSource | OneOrMany<RemoteSkillSource>;
  /**
   * Fail app startup when a source can't be resolved. Defaults to `true`. A
   * per-source `failOnError` wins over this.
   */
  failOnError?: boolean;
  /**
   * Absolute Databricks path that roots the destination Assistant skills tree.
   * Defaults to the OBO user's `/Users/<email>/.assistant/skills`.
   */
  databricksBasePath?: string;
  /** Auth-scoped Databricks client. Defaults to the AppKit execution context. */
  client?: WorkspaceClientLike;
  /** User email used to derive the default Databricks destination. */
  userEmail?: string;
  /** Byte ceiling on a direct-fetch download. Defaults to 10 MiB. */
  maxDownloadBytes?: number;
  /**
   * How long a provisioned tree is reused before its source is downloaded
   * again, in milliseconds. Defaults to seven days; `0` re-downloads on every
   * boot. A per-source `refreshTtlMs` wins over this.
   */
  refreshTtlMs?: number;
}

/** What {@link provisionRemoteSkills} resolved. */
export interface ProvisionedRemoteSkills {
  /**
   * Extra LOCAL skill scan paths to hand Mastra (a temp dir per source that
   * couldn't be written to Databricks). Empty when everything landed in the
   * Databricks Assistant tree, which the built-in mount already scans.
   */
  localSkillPaths: string[];
  /** Absolute Databricks destination each source was written to, if any. */
  databricksBasePath?: string;
  /**
   * Names of every skill directory now available, whether it was downloaded on
   * this boot or reused from a still-fresh tree (see {@link METADATA_FILE}).
   */
  skillNames: string[];
}

/**
 * What one source's last download left behind, as recorded in
 * {@link METADATA_FILE}.
 */
export interface RemoteSkillCacheEntry {
  /** The source string this entry was downloaded from, for readability. */
  source: string;
  /** When the download completed, ISO-8601. */
  downloadedAt: string;
  /** Skill directory names the download produced. */
  skills: string[];
  /**
   * The content-affecting policy that download used. Also folded into the entry
   * KEY, so narrowing `skills` or moving `ref` misses the cache instead of
   * silently serving the previous selection.
   */
  policy?: { skills?: string[]; experimental?: boolean; ref?: string };
}

/** The {@link METADATA_FILE} document: one entry per provisioned source. */
export interface RemoteSkillsMetadata {
  version: number;
  sources: Record<string, RemoteSkillCacheEntry>;
}

/* ------------------------------- helpers ------------------------------- */

/** Normalize the `remoteSkills` option into a flat options bag. */
export function normalizeRemoteSkillsOption(
  option: RemoteSkillsOption | undefined,
): ProvisionRemoteSkillsOptions | undefined {
  if (option === undefined) return undefined;
  const bag = isProvisionOptions(option) ? option : undefined;
  const sources = toSourceList(bag ? bag.sources : (option as RemoteSkillSource));
  // An empty list is the same as no configuration at all.
  if (!object.isOneOrMany(sources)) return undefined;
  return { ...bag, sources };
}

/** A `sources`-bearing bag is the top-level options shape, not a single source. */
function isProvisionOptions(value: unknown): value is ProvisionRemoteSkillsOptions {
  return object.isRecord(value) && "sources" in value;
}

/** One source or many, as a plain array. A source is never itself an array. */
function toSourceList(
  input: RemoteSkillSource | OneOrMany<RemoteSkillSource>,
): RemoteSkillSource[] {
  return Array.isArray(input) ? [...input] : [input];
}

/** Flatten a source entry - string, `URL`, `{ url }`, or options bag - to a {@link NormalizedSource}. */
function toSourceOptions(source: RemoteSkillSource): NormalizedSource {
  if (typeof source === "string") return { source };
  if (source instanceof URL) return { source: source.toString() };
  if ("source" in source) return { ...source, source: toSourceString(source.source) };
  return { source: source.url };
}

/** A {@link net.UrlLike} as the plain string the staging paths work with. */
function toSourceString(source: net.UrlLike): string {
  if (typeof source === "string") return source;
  return source instanceof URL ? source.toString() : source.url;
}

/** True when a source selects the built-in Databricks AI Tools skill set. */
function isAiToolsSource(source: string): boolean {
  return source.trim().toLowerCase() === AITOOLS_SOURCE;
}

/* -------------------------------- cache -------------------------------- */

/**
 * The policy that decides what a source's download CONTAINS.
 *
 * Only these three change the resulting tree, so only these belong in the cache
 * key - `failOnError` and `maxDownloadBytes` govern how a failure is handled,
 * not what a success produces.
 */
function cachePolicy(sourceOptions: NormalizedSource): RemoteSkillCacheEntry["policy"] {
  const skills = string.parseList(sourceOptions.skills);
  const policy = {
    ...(skills.length > 0 ? { skills: [...skills].sort() } : {}),
    ...(sourceOptions.experimental === true ? { experimental: true } : {}),
    ...(string.trimToNull(sourceOptions.ref) ? { ref: sourceOptions.ref!.trim() } : {}),
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/**
 * Stable identity of a source AND its content-affecting policy.
 *
 * Keying on the source alone would let a changed `skills` filter or `ref` read
 * back the previous download for a day; keying on both turns that into a miss.
 * The skill list is sorted first so a reordered array is still the same key.
 */
function cacheKey(sourceOptions: NormalizedSource): string {
  return hash.fnvHash(
    JSON.stringify({ source: sourceOptions.source, policy: cachePolicy(sourceOptions) ?? null }),
  );
}

/** The effective reuse window: per-source, then top-level, then seven days. */
function resolveRefreshTtl(
  sourceOptions: NormalizedSource,
  options: ProvisionRemoteSkillsOptions,
): number {
  return sourceOptions.refreshTtlMs ?? options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
}

/**
 * Read the metadata document at the root of a provisioned tree, or `undefined`
 * when there is none, it is unreadable, or it was written by a shape this
 * version does not know.
 *
 * Never throws: a missing or corrupt record is a cache MISS, which costs a
 * download - while letting it fail would take app startup down over
 * bookkeeping.
 */
async function readMetadata(fs: FileSystem): Promise<RemoteSkillsMetadata | undefined> {
  try {
    if (!(await fs.exists(METADATA_FILE))) return undefined;
    const raw = await fs.readFile(METADATA_FILE, { encoding: "utf8" });
    const parsed = json.parse(raw, undefined) as RemoteSkillsMetadata | undefined;
    if (!object.isRecord(parsed) || parsed.version !== METADATA_VERSION) return undefined;
    return object.isRecord(parsed.sources) ? parsed : undefined;
  } catch (err) {
    logger.debug("cache:unreadable", { error: error.errorMessage(err) });
    return undefined;
  }
}

/**
 * Whether an entry is still inside its reuse window.
 *
 * A `ttlMs` of `0` disables reuse outright, and an unparseable or FUTURE
 * timestamp counts as stale - a clock that moved backwards should cost one
 * extra download, not pin a tree as fresh indefinitely.
 */
function isFresh(entry: RemoteSkillCacheEntry, ttlMs: number): boolean {
  if (ttlMs <= 0 || !Array.isArray(entry.skills)) return false;
  const downloadedAt = object.toDate(entry.downloadedAt);
  if (!downloadedAt) return false;
  const age = Date.now() - downloadedAt.getTime();
  return age >= 0 && age < ttlMs;
}

/**
 * Merge one source's entry into the tree's metadata document, preserving what
 * other sources recorded - the Databricks destination is SHARED, so a blind
 * overwrite would drop every sibling source's timestamp and re-download the
 * lot on the next boot.
 */
async function writeMetadata(
  fs: FileSystem,
  key: string,
  entry: RemoteSkillCacheEntry,
): Promise<void> {
  const current = await readMetadata(fs);
  const next: RemoteSkillsMetadata = {
    version: METADATA_VERSION,
    sources: { ...current?.sources, [key]: entry },
  };
  await fs.writeFile(METADATA_FILE, `${JSON.stringify(next, null, 2)}\n`, { overwrite: true });
}

/** The stable local tree a source is rebuilt into, keyed by {@link cacheKey}. */
function localSkillsFS(key: string): LocalFileSystem {
  return localFS.tmpFS(`${LOCAL_SKILLS_DIR}/${key}`);
}

/**
 * Materialize every configured remote skill source at app startup.
 *
 * Writes each resolved `SKILL.md` tree to the Databricks user Assistant skills
 * folder when a writable workspace is available, else under
 * {@link localFS.tmpFS} returned in {@link ProvisionedRemoteSkills.localSkillPaths}.
 */
export async function provisionRemoteSkills(
  option: RemoteSkillsOption | undefined,
): Promise<ProvisionedRemoteSkills> {
  const options = normalizeRemoteSkillsOption(option);
  const empty: ProvisionedRemoteSkills = { localSkillPaths: [], skillNames: [] };
  if (!options) return empty;

  const failDefault = options.failOnError !== false;
  const client = options.client ?? appkit.tryGetExecutionContext()?.client;
  // Probed rather than assumed: an identity that cannot write the workspace
  // tree falls back to the local one instead of failing startup. The probe also
  // creates the root, which the first cache READ needs - `copySkillDirs` would
  // otherwise be the first thing to create it, which is too late.
  const requestedBasePath = resolveDatabricksBasePath(options, client);
  const destination = requestedBasePath
    ? await openWritableWorkspace(requestedBasePath, client as WorkspaceClient)
    : undefined;
  const databricksBasePath = destination ? requestedBasePath : undefined;

  const localSkillPaths: string[] = [];
  const skillNames: string[] = [];
  let staging: LocalFileSystem | undefined;

  try {
    const sources = Array.isArray(options.sources) ? options.sources : [options.sources];
    for (const entry of sources) {
      const sourceOptions = toSourceOptions(entry);
      const failOnError = sourceOptions.failOnError ?? failDefault;
      try {
        // Where this source's bookkeeping lives: the shared Databricks tree, or
        // the source's own stable local dir.
        const key = cacheKey(sourceOptions);
        const cacheFS = destination ?? localSkillsFS(key);
        const cached = (await readMetadata(cacheFS))?.sources[key];
        if (cached && isFresh(cached, resolveRefreshTtl(sourceOptions, options))) {
          skillNames.push(...cached.skills);
          if (!destination) localSkillPaths.push(cacheFS.root);
          logger.info("remote skill ready", {
            source: sourceOptions.source,
            destination: databricksBasePath ?? cacheFS.root,
            downloadedAt: cached.downloadedAt,
            skills: cached.skills,
            cached: true,
          });
          continue;
        }

        logger.info("installing remote skill", {
          source: sourceOptions.source,
        });
        staging ??= await initializedScratch("mastra-remote-skills");
        const stagedDir = await stageSource(sourceOptions, staging.root, options);
        const staged = await collectSkillDirs(stagedDir);
        if (staged.length === 0) {
          throw new Error(`no SKILL.md found for source "${sourceOptions.source}"`);
        }
        const policy = cachePolicy(sourceOptions);
        const record: RemoteSkillCacheEntry = {
          source: sourceOptions.source,
          downloadedAt: new Date().toISOString(),
          skills: staged.map((dir) => dir.name),
          ...(policy ? { policy } : {}),
        };
        if (destination && databricksBasePath) {
          await copySkillDirs(destination, staged);
          // Only after the copy lands: a metadata entry written first would
          // mark a failed provision as fresh and suppress the retry for a day.
          await writeMetadata(destination, key, record);
        } else {
          localSkillPaths.push(await persistLocally(key, staged, record));
        }
        skillNames.push(...record.skills);
        logger.info("remote skill installed", {
          source: sourceOptions.source,
          destination: databricksBasePath ?? localSkillPaths.at(-1),
          skills: record.skills,
        });
      } catch (err) {
        if (failOnError) {
          throw new Error(
            `failed to provision remote skill source "${sourceOptions.source}": ${error.errorMessage(err)}`,
            { cause: error.toError(err) },
          );
        }
        logger.warn("source:skipped", {
          source: sourceOptions.source,
          error: error.errorMessage(err),
        });
      }
    }
  } finally {
    if (staging) {
      await rm(staging.root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return { localSkillPaths, databricksBasePath, skillNames };
}

/** Probe file {@link openWritableWorkspace} writes and removes. */
const WRITE_PROBE_FILE = ".dbx-tools-write-probe";

/**
 * Open the Databricks skills destination, or `undefined` when this identity
 * cannot write there.
 *
 * The default destination (`/Workspace/.assistant/skills`) is commonly
 * admins-only, and an app service principal is not an admin - so a Databricks
 * App writing there fails with `RESOURCE_DOES_NOT_EXIST`, which is how the
 * workspace API reports a path the caller is not allowed to see. That is a fact
 * about WHERE the tree is stored, not about whether the skills are usable, so it
 * degrades to the local tree (handed to Mastra as an extra scan path) rather
 * than taking app startup down over bookkeeping location.
 *
 * The probe is a real write: `mkdirs` succeeds on an existing directory even for
 * an identity that cannot write into it, so init alone proves nothing. Removing
 * the probe file is best-effort - a failed cleanup must not decide writability.
 */
async function openWritableWorkspace(
  basePath: string,
  client: WorkspaceClient,
): Promise<DatabricksFileSystem | undefined> {
  const fs = new DatabricksFileSystem({
    client,
    root: basePath,
    readOnly: false,
    createRoot: true,
  });
  try {
    await fs.init();
    await fs.writeFile(WRITE_PROBE_FILE, new Date().toISOString(), { overwrite: true });
  } catch (err) {
    logger.warn("destination:unwritable", {
      destination: basePath,
      error: error.errorMessage(err),
    });
    return undefined;
  }
  await fs.deleteFile(WRITE_PROBE_FILE, { force: true }).catch(() => undefined);
  return fs;
}

/** Resolve the Databricks Assistant skills destination, or `undefined` for local temp. */
function resolveDatabricksBasePath(
  options: ProvisionRemoteSkillsOptions,
  client: WorkspaceClientLike | undefined,
): string | undefined {
  if (!client) return undefined;
  if (options.databricksBasePath) return options.databricksBasePath.trim() || undefined;
  const email = string.trimToNull(options.userEmail);
  // A named user targets their personal Assistant tree (the "save a skill"
  // target); otherwise the shared workspace Assistant tree, which the built-in
  // Assistant-skills mount already scans.
  return email ? userAssistantSkillsPath(email) : ASSISTANT_SHARED_SKILLS_PATH;
}

/**
 * Stage one source into a fresh dir under `stagingRoot`, preferring the optional
 * `skills` CLI and falling back to a direct fetch.
 */
async function stageSource(
  sourceOptions: NormalizedSource,
  stagingRoot: string,
  options: ProvisionRemoteSkillsOptions,
): Promise<string> {
  const target = join(stagingRoot, `src-${hash.id()}`);
  await mkdir(target, { recursive: true });
  // AI Tools resolves from a known repo layout, so it never needs the CLI.
  if (isAiToolsSource(sourceOptions.source)) return stageAiTools(sourceOptions, target, options);
  const viaCli = await stageViaSkillsCli(sourceOptions, target);
  if (viaCli) return viaCli;
  return stageViaFetch(sourceOptions, target, options);
}

/**
 * Materialize the Databricks AI Tools skills into `target`.
 *
 * Reads the repo's own generated `manifest.json` (which names each skill's
 * files and whether it lives under `skills/` or `experimental/`) and downloads
 * them - the same thing `databricks aitools install` does, minus the CLI and
 * minus any Databricks auth, since the repo is public.
 */
async function stageAiTools(
  sourceOptions: NormalizedSource,
  target: string,
  options: ProvisionRemoteSkillsOptions,
): Promise<string> {
  const maxBytes = resolveMaxBytes(sourceOptions, options);
  const ref = string.trimToNull(sourceOptions.ref) ?? AITOOLS_REF;
  const manifest = json.parse(
    (await download(aiToolsRawUrl(ref, "manifest.json"), maxBytes)).toString("utf8"),
    undefined,
  ) as AiToolsManifest | undefined;

  const wanted = new Set(string.parseList(sourceOptions.skills));
  const selected = Object.entries(manifest?.skills ?? {}).filter(([name, entry]) =>
    wanted.size > 0
      ? wanted.has(name)
      : entry.repo_dir !== "experimental" || sourceOptions.experimental === true,
  );
  if (selected.length === 0) {
    throw new Error(`no matching skills in ${AITOOLS_REPO}@${ref}`);
  }

  const files = selected.flatMap(([name, entry]) =>
    (entry.files ?? []).map((file) => ({
      url: aiToolsRawUrl(ref, `${entry.repo_dir ?? "skills"}/${name}/${file}`),
      path: join(target, name, ...file.split("/")),
    })),
  );
  await mapConcurrent(files, AITOOLS_CONCURRENCY, async (item) => {
    const body = await download(item.url, maxBytes);
    await mkdir(dirname(item.path), { recursive: true });
    await writeFile(item.path, body);
  });

  logger.debug("aitools:staged", { ref, skills: selected.length, files: files.length });
  return target;
}

/** Raw-content URL for a path in the AI Tools repo at `ref`. */
function aiToolsRawUrl(ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${AITOOLS_REPO}/${ref}/${path}`;
}

/** Run `worker` over `items`, at most `limit` in flight. */
async function mapConcurrent<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      await worker(items[cursor++]!);
    }
  });
  await Promise.all(runners);
}

/**
 * Copy a source into `target` with the `skills` CLI when it is installed.
 * Returns the dir holding the copied `SKILL.md` trees, or `undefined` when the
 * CLI is absent (so the caller can fall back to a fetch).
 */
async function stageViaSkillsCli(
  sourceOptions: NormalizedSource,
  target: string,
): Promise<string | undefined> {
  const cli = await resolveSkillsCli();
  if (!cli) return undefined;

  const args = [
    ...cli.args,
    "add",
    sourceOptions.source,
    "--agent",
    SKILLS_CLI_AGENT,
    "--copy",
    "-y",
  ];
  for (const skill of string.parseList(sourceOptions.skills)) {
    args.push("--skill", skill);
  }
  if (string.parseList(sourceOptions.skills).length === 0) args.push("--skill", "*");

  const result = await exec.spawn(cli.command, args, {
    cwd: target,
    stdout: "capture",
    stderr: "capture",
    check: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `skills CLI failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return join(target, ...SKILLS_CLI_LAYOUT);
}

/**
 * Locate the optional `skills` CLI bin, resolved from THIS package's module
 * graph. Returns `undefined` when the peer dep isn't installed, so the caller
 * falls back to a direct fetch.
 */
async function resolveSkillsCli(): Promise<{ command: string; args: string[] } | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("skills/package.json");
    const bin = join(pkgPath, "..", "bin", "cli.mjs");
    if (await pathExists(bin)) return { command: process.execPath, args: [bin] };
  } catch {
    // peer dep absent or unresolvable - fetch fallback handles it
  }
  return undefined;
}

/**
 * Fetch a source URL and write the downloaded `SKILL.md` under `target`.
 * Used when the `skills` CLI isn't installed; supports a direct `SKILL.md` URL.
 */
async function stageViaFetch(
  sourceOptions: NormalizedSource,
  target: string,
  options: ProvisionRemoteSkillsOptions,
): Promise<string> {
  const url = net.urlBuilder(sourceOptions.source);
  if (!url) {
    throw new Error(
      `source "${sourceOptions.source}" is not a URL and the optional "skills" package is not installed`,
    );
  }
  const buffer = await download(url.toString(), resolveMaxBytes(sourceOptions, options));
  const name = string.toSlug(deriveSkillName(url.toString())) || "remote-skill";
  const skillDir = join(target, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), buffer);
  return target;
}

/** The effective download ceiling: per-source, then top-level, then the default. */
function resolveMaxBytes(
  sourceOptions: NormalizedSource,
  options: ProvisionRemoteSkillsOptions,
): number {
  return sourceOptions.maxDownloadBytes ?? options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
}

/** GET a URL, failing loudly on a non-2xx status or an oversized body. */
async function download(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DEFAULT_DOWNLOAD_TIMEOUT_MS),
  }).catch((err) => {
    throw new Error(`download failed (${url}): ${error.errorMessage(err)}`, {
      cause: error.toError(err),
    });
  });
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText} (${url})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`download exceeds ${maxBytes} bytes (${url})`);
  }
  return buffer;
}

/** Derive a skill directory name from a download URL's last path segment. */
function deriveSkillName(urlString: string): string {
  const url = net.urlBuilder(urlString);
  const last = url?.pathname.split("/").filter(Boolean).pop() ?? "";
  return last.replace(/\.(md|zip|tar|tgz|gz)$/i, "");
}

/** A skill directory (holding a `SKILL.md`) staged on local disk. */
interface StagedSkillDir {
  name: string;
  absolutePath: string;
}

/**
 * Collect every skill directory under `root`: a `root/SKILL.md` (root IS the
 * skill) or each immediate child dir that contains a `SKILL.md`.
 */
async function collectSkillDirs(root: string): Promise<StagedSkillDir[]> {
  if (!(await pathExists(root))) return [];
  if (await pathExists(join(root, "SKILL.md"))) {
    const name = posix.basename(root.split(/[\\/]/).join("/"));
    return [{ name, absolutePath: root }];
  }
  const dirs: StagedSkillDir[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (await pathExists(join(dir, "SKILL.md"))) {
      dirs.push({ name: entry.name, absolutePath: dir });
    }
  }
  return dirs;
}

/**
 * Copy every staged skill directory into {@link destination}, preserving the
 * `<skill>/<relative>` layout. The destination is just a {@link FileSystem},
 * so the Databricks Assistant tree and the local fallback share one copier.
 */
async function copySkillDirs(destination: FileSystem, dirs: StagedSkillDir[]): Promise<void> {
  await destination.init();
  for (const dir of dirs) {
    for (const relative of find.findFiles("**/*", { cwd: dir.absolutePath, nodir: true })) {
      const buffer = await readFile(join(dir.absolutePath, relative));
      const skillPath = posix.join(dir.name, relative.split(/[\\/]/).join("/"));
      await destination.writeFile(skillPath, buffer, { overwrite: true });
    }
  }
}

/**
 * Copy staged skill dirs into a STABLE local tree keyed by the source, and
 * return its root path.
 *
 * A given source resolves to the same content on almost every boot, so each
 * one owns a directory named for its {@link cacheKey} rather than leaving a
 * fresh scratch dir behind per restart. Keying on the source and its policy
 * (not the content) is what keeps two different sources from overwriting each
 * other.
 *
 * The metadata is written INSIDE the rebuild rather than after it: `rebuildFS`
 * replaces the stable root wholesale, so anything written afterwards would
 * survive only until the next refresh, and anything written before would be
 * thrown away by the swap.
 */
async function persistLocally(
  key: string,
  dirs: StagedSkillDir[],
  record: RemoteSkillCacheEntry,
): Promise<string> {
  const stable = await localFS.rebuildFS(`${LOCAL_SKILLS_DIR}/${key}`, async (scratch) => {
    await copySkillDirs(scratch, dirs);
    await writeMetadata(scratch, key, record);
  });
  return stable.root;
}

/**
 * A scratch filesystem whose root exists on disk, for the paths that hand a
 * real directory to `node:fs` or a child process rather than going through
 * the {@link FileSystem} API.
 */
async function initializedScratch(prefix: string): Promise<LocalFileSystem> {
  const scratch = localFS.scratchFS(prefix);
  await scratch.init();
  return scratch;
}

/** Best-effort existence check. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
