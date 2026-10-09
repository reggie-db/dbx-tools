/**
 * User-scoped workspace skill catalogues cached as one semantic record.
 *
 * @module
 */

import { CacheManager } from "@databricks/appkit";
import { errorUtils, log, object } from "@dbx-tools/shared-core";
import { posixPath } from "@dbx-tools/shared-fs";
import type { RequestContext } from "@mastra/core/request-context";
import { LRUCache } from "lru-cache";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const CACHE_NAMESPACE = "mastra:workspace-skill-catalogue";
const CATALOGUE_VERSION = 1;
const MAX_SCOPED_CATALOGUES = 256;
const logger = log.logger("mastra/skill-cache");

const SkillCatalogueEntrySchema = z
  .object({
    name: z.string().describe("Unique skill name from SKILL.md frontmatter."),
    description: z.string().describe("Skill description from SKILL.md frontmatter."),
    instructions: z.string().describe("Markdown instructions below SKILL.md frontmatter."),
    sourceId: z.string().describe("Identity of the mounted source that owns this skill."),
    sourcePath: z.string().describe("Path to SKILL.md relative to its source root."),
    signature: z
      .string()
      .optional()
      .describe("Stable metadata signature used to retain unchanged instructions."),
  })
  .describe("One parsed skill in a materialized workspace catalogue.");

const SkillCatalogueSchema = z
  .object({
    version: z.literal(CATALOGUE_VERSION).describe("Persisted catalogue schema version."),
    generatedAt: z.string().datetime().describe("Time the catalogue was last refreshed."),
    roots: z.array(z.string()).describe("Ordered source identities included in the catalogue."),
    skills: z
      .array(SkillCatalogueEntrySchema)
      .describe("Parsed skills after ordered duplicate-name precedence is applied."),
  })
  .describe("One user-scoped materialized workspace skill catalogue.");

/** Parsed skill retained in a materialized workspace catalogue. */
export type SkillCatalogueEntry = z.infer<typeof SkillCatalogueEntrySchema>;

/** Versioned persisted skill catalogue. */
export type SkillCatalogue = z.infer<typeof SkillCatalogueSchema>;

/** One ordered filesystem root contributing skills to a catalogue. */
export interface SkillCatalogueSource {
  /** Stable source identity including its mount precedence. */
  id: string;
  /** List one source-relative directory with provider metadata when available. */
  list(path: string): Promise<SkillCatalogueFileEntry[]>;
  /** Read one source-relative file fresh from its owning filesystem. */
  read(path: string): Promise<string>;
}

/** Minimal directory metadata used to compare one catalogue refresh. */
export interface SkillCatalogueFileEntry {
  metadata?: Readonly<Record<string, unknown>>;
  name: string;
  size?: number;
  type: "directory" | "file";
}

/** Options for one user-scoped workspace skill catalogue. */
export interface WorkspaceSkillCatalogueOptions {
  host: string;
  sources: readonly SkillCatalogueSource[];
  ttlMs?: number;
  userKey: string;
}

/** Request state used to resolve one user-scoped catalogue owner. */
export interface SkillCatalogueResolveContext {
  abortSignal?: AbortSignal;
  requestContext?: RequestContext;
}

/** Resolve one request's complete skill catalogue. */
export type SkillCatalogueResolver = (
  context: SkillCatalogueResolveContext,
) => Promise<WorkspaceSkillCatalogue>;

interface ParsedSkill {
  description: string;
  instructions: string;
  name: string;
}

const scopedCatalogues = new LRUCache<string, WorkspaceSkillCatalogue>({
  max: MAX_SCOPED_CATALOGUES,
});

/** Default lifetime for one complete workspace skill catalogue. */
export const DEFAULT_WORKSPACE_SKILL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Materialized catalogue with one AppKit cache record and fresh auxiliary reads. */
export class WorkspaceSkillCatalogue {
  readonly cacheKey: string;
  readonly host: string;
  readonly userKey: string;

  private lastValid?: SkillCatalogue;
  private readonly ttlMs: number;
  private sources: readonly SkillCatalogueSource[];

  constructor(private readonly options: WorkspaceSkillCatalogueOptions) {
    this.host = options.host;
    this.userKey = options.userKey;
    this.sources = options.sources;
    this.ttlMs = positiveTtl(options.ttlMs);
    this.cacheKey = object.toStableKey({
      host: options.host,
      roots: options.sources.map(({ id }) => id),
      userKey: options.userKey,
      version: CATALOGUE_VERSION,
    });
  }

  /** Rebind refreshes and lazy reads to the current request's filesystem clients. */
  bind(sources: readonly SkillCatalogueSource[]): void {
    const identities = sources.map(({ id }) => id);
    if (object.toStableKey(identities) !== object.toStableKey(this.sources.map(({ id }) => id))) {
      throw new Error("Cannot rebind a skill catalogue to a different ordered root set");
    }
    this.sources = sources;
  }

  /** Return the cached catalogue, refreshing all roots once on cache miss. */
  async get(signal?: AbortSignal): Promise<SkillCatalogue> {
    const cache = CacheManager.getInstanceSync();
    try {
      const catalogue = SkillCatalogueSchema.parse(
        await cache.getOrExecute(
          [CACHE_NAMESPACE, CATALOGUE_VERSION, this.options.host, this.rootKey()],
          () => this.refresh(),
          this.options.userKey,
          {
            ttl: Math.max(1, Math.ceil(this.ttlMs / 1000)),
            callerSignal: signal,
          },
        ),
      );
      this.lastValid = catalogue;
      return catalogue;
    } catch (error) {
      if (!this.lastValid) throw error;
      logger.warn("skill catalogue refresh failed; retaining last valid catalogue", {
        error: errorUtils.errorMessage(error),
        roots: this.sources.map(({ id }) => id),
      });
      return this.lastValid;
    }
  }

  /** Expire this complete catalogue without touching unrelated cache entries. */
  async invalidate(): Promise<void> {
    const cache = CacheManager.getInstanceSync();
    await cache.delete(this.persistentKey(cache));
  }

  /** Read one selected skill's auxiliary file directly from its current source. */
  async readSkillFile(
    skillName: string,
    inputPath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const catalogue = await this.get(signal);
    const skill = catalogue.skills.find(({ name }) => name === skillName);
    if (!skill) throw new Error(`Unknown skill: ${skillName}`);
    const normalized = posixPath.normalize(inputPath);
    if (
      !normalized.ok ||
      normalized.path === "/" ||
      inputPath.split("/").some((segment) => segment === "..")
    ) {
      throw new Error(`Invalid skill file path: ${inputPath}`);
    }
    const source = this.sources.find(({ id }) => id === skill.sourceId);
    if (!source) throw new Error(`Skill source is no longer mounted: ${skill.sourceId}`);
    const parent = skill.sourcePath.split("/").slice(0, -1).join("/");
    const path = [parent, normalized.path.replace(/^\/+/, "")].filter(Boolean).join("/");
    return source.read(path);
  }

  private async refresh(): Promise<SkillCatalogue> {
    const previous = new Map(
      this.lastValid?.skills.map((skill) => [`${skill.sourceId}\0${skill.sourcePath}`, skill]) ?? [],
    );
    const selected = new Map<string, SkillCatalogueEntry>();
    for (const source of this.sources) {
      for (const candidate of await discoverSkillFiles(source)) {
        const prior = previous.get(`${source.id}\0${candidate.path}`);
        const signature = fileSignature(candidate.entry);
        let parsed: ParsedSkill | undefined;
        if (signature && prior?.signature === signature) {
          parsed = prior;
        } else {
          parsed = parseSkill(
            await source.read(candidate.path),
            candidate.path,
          );
        }
        if (!parsed || selected.has(parsed.name)) continue;
        selected.set(parsed.name, {
          ...parsed,
          sourceId: source.id,
          sourcePath: candidate.path,
          ...(signature ? { signature } : {}),
        });
      }
    }
    return SkillCatalogueSchema.parse({
      version: CATALOGUE_VERSION,
      generatedAt: new Date().toISOString(),
      roots: this.sources.map(({ id }) => id),
      skills: [...selected.values()],
    });
  }

  private rootKey(): string {
    return object.toStableKey(this.sources.map(({ id }) => id));
  }

  private persistentKey(cache: CacheManager): string {
    return cache.generateKey(
      [CACHE_NAMESPACE, CATALOGUE_VERSION, this.options.host, this.rootKey()],
      this.options.userKey,
    );
  }
}

/** Return one stable catalogue owner for a user, host, and ordered root set. */
export function workspaceSkillCatalogue(
  options: WorkspaceSkillCatalogueOptions,
): WorkspaceSkillCatalogue {
  const key = object.toStableKey({
    host: options.host,
    roots: options.sources.map(({ id }) => id),
    userKey: options.userKey,
  });
  const existing = scopedCatalogues.get(key);
  if (existing) {
    existing.bind(options.sources);
    return existing;
  }
  const catalogue = new WorkspaceSkillCatalogue(options);
  scopedCatalogues.set(key, catalogue);
  return catalogue;
}

/** Invalidate matching complete catalogues and retain their stable owners. */
export async function clearWorkspaceSkillCache(options: {
  host: string;
  userKey?: string;
}): Promise<void> {
  const matches = [...scopedCatalogues.values()].filter(
    (catalogue) =>
      catalogue.host === options.host &&
      (options.userKey === undefined || catalogue.userKey === options.userKey),
  );
  await Promise.all(matches.map((catalogue) => catalogue.invalidate()));
}

async function discoverSkillFiles(
  source: SkillCatalogueSource,
): Promise<Array<{ entry: SkillCatalogueFileEntry; path: string }>> {
  let rootEntries: SkillCatalogueFileEntry[];
  try {
    rootEntries = await source.list(".");
  } catch (error) {
    if (errorUtils.errorContext(error).notAccessible) return [];
    throw error;
  }
  const candidates: Array<{ entry: SkillCatalogueFileEntry; path: string }> = [];
  const rootSkill = rootEntries.find(
    ({ name, type }) => name.toLowerCase() === "skill.md" && type === "file",
  );
  if (rootSkill) candidates.push({ entry: rootSkill, path: rootSkill.name });
  await Promise.all(
    rootEntries
      .filter(({ type }) => type === "directory")
      .map(async (directory) => {
        const entries = await source.list(directory.name);
        const skill = entries.find(
          ({ name, type }) => name.toLowerCase() === "skill.md" && type === "file",
        );
        if (skill) candidates.push({ entry: skill, path: posixPath.join(directory.name, skill.name) });
      }),
  );
  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

function parseSkill(source: string, path: string): ParsedSkill | undefined {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) {
    logger.warn("skill skipped (missing YAML frontmatter)", { path });
    return undefined;
  }
  const metadata = parseYaml(match[1]!) as unknown;
  if (!object.isRecord(metadata)) {
    logger.warn("skill skipped (invalid YAML frontmatter)", { path });
    return undefined;
  }
  const parsed = z
    .object({
      name: z.string().trim().min(1),
      description: z.string().trim().min(1),
    })
    .safeParse(metadata);
  if (!parsed.success) {
    logger.warn("skill skipped (invalid metadata)", {
      path,
      error: parsed.error.message,
    });
    return undefined;
  }
  return {
    name: parsed.data.name,
    description: parsed.data.description,
    instructions: match[2]!.trim(),
  };
}

function fileSignature(entry: SkillCatalogueFileEntry): string | undefined {
  const metadata = object.isRecord(entry.metadata) ? entry.metadata : {};
  const values = {
    modifiedAt: metadata.modifiedAt,
    objectId: metadata.objectId,
    size: entry.size,
  };
  return Object.values(values).some((value) => value !== undefined)
    ? object.toStableKey(values)
    : undefined;
}

function positiveTtl(value = DEFAULT_WORKSPACE_SKILL_CACHE_TTL_MS): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Workspace skill catalogue ttlMs must be a positive finite number");
  }
  return value;
}
