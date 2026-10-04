/** Cached Databricks Lakebase discovery and database credentials. */

import {
  DatabricksAuthOptions,
  DatabricksClient,
} from "@dbx-tools/auth";
import { log } from "@dbx-tools/shared-core";

import type { ParsedAddress } from "./address.ts";

const logger = log.logger("lakebase");
const API_BASE = "/api/2.0/postgres";
const DEFAULT_DATABASE = "databricks_postgres";
const DISCOVERY_TTL_MS = 30_000;
const SESSION_TTL_MS = 10 * 60_000;

export interface ResolvedLakebase {
  host: string;
  port: number;
  database: string;
  user: string;
  endpoint: string;
  project: string;
  branch: string;
}

interface Timed<T> {
  value: T;
  expiresAt: number;
}

export class LakebaseClient {
  private readonly sessions = new Map<string, Timed<DatabricksClient>>();
  private readonly resolved = new Map<string, Timed<ResolvedLakebase>>();

  constructor(private readonly authOptions = DatabricksAuthOptions.create()) {}

  async resolve(target: ParsedAddress, startupUser?: string): Promise<ResolvedLakebase> {
    const profile = await this.resolveProfile(startupUser);
    const key = `${profile ?? "<default>"}:${JSON.stringify(target)}`;
    const cached = current(this.resolved.get(key));
    if (cached) return cached;
    const value = await this.discover(await this.session(profile), target);
    this.resolved.set(key, timed(value, DISCOVERY_TTL_MS));
    return value;
  }

  async generateDatabaseCredential(endpoint: string, startupUser?: string): Promise<string> {
    const profile = await this.resolveProfile(startupUser);
    const response = record(
      await (await this.session(profile)).request(`${API_BASE}/credentials`, {
        body: { endpoint },
      }),
    );
    const token = text(response.token);
    if (!token) throw new Error("Lakebase credential response did not contain token");
    return token;
  }

  private async session(profile?: string): Promise<DatabricksClient> {
    const key = profile ?? "<default>";
    const cached = current(this.sessions.get(key));
    if (cached) return cached;
    const value = await DatabricksClient.create({ ...this.authOptions, profile });
    this.sessions.set(key, timed(value, SESSION_TTL_MS));
    return value;
  }

  private async resolveProfile(startupUser?: string): Promise<string | undefined> {
    if (this.authOptions.profile) return this.authOptions.profile;
    const candidate = startupUser?.trim();
    if (!candidate || isDatabricksApp()) return undefined;
    const client = await this.session();
    const exists = client.auth.listProfiles().some((profile) => profile.name === candidate);
    logger.debug("resolved Lakebase startup profile", { startupUser: candidate, exists });
    return exists ? candidate : undefined;
  }

  private async discover(
    client: DatabricksClient,
    target: ParsedAddress,
  ): Promise<ResolvedLakebase> {
    let project = target.project;
    let branch = target.branch;
    let endpointId = target.endpointId;
    if (!project && target.host) {
      const found = await this.findEndpointByHost(client, target.host);
      if (found) ({ project, branch, endpointId } = found);
    }
    project ??= selectProject(await this.list(client, `${API_BASE}/projects`, "projects"));
    const projectPath = `${API_BASE}/projects/${project}`;
    const projectRecord = record(await client.request(projectPath));
    branch = selectBranch(
      projectRecord,
      await this.list(client, `${projectPath}/branches`, "branches"),
      branch,
    );
    const branchPath = `${projectPath}/branches/${branch}`;
    const endpoint = selectEndpoint(
      await this.list(client, `${branchPath}/endpoints`, "endpoints"),
      endpointId,
      target.host,
    );
    endpointId = resourceId(endpoint, "endpoints");
    if (!endpointId) throw new Error("Lakebase endpoint has no resource name");
    const host = text(at(endpoint, "status", "hosts", "host"));
    if (!host) throw new Error(`Lakebase endpoint ${endpointId} has no writable host`);
    const port = number(at(endpoint, "status", "hosts", "port")) ?? 5432;
    const database = selectDatabase(
      await this.list(client, `${branchPath}/databases`, "databases"),
      target.databaseResourceId ?? target.database,
    );
    const me = record(await client.request("/api/2.0/preview/scim/v2/Me"));
    const user = text(me.userName);
    if (!user) throw new Error("Databricks identity response did not contain userName");
    return {
      host,
      port,
      database,
      user,
      endpoint: `projects/${project}/branches/${branch}/endpoints/${endpointId}`,
      project,
      branch,
    };
  }

  private async findEndpointByHost(
    client: DatabricksClient,
    host: string,
  ): Promise<{ project: string; branch: string; endpointId: string } | undefined> {
    for (const project of await this.list(client, `${API_BASE}/projects`, "projects")) {
      const projectId = resourceId(project, "projects");
      if (!projectId) continue;
      const projectPath = `${API_BASE}/projects/${projectId}`;
      for (const branch of await this.list(client, `${projectPath}/branches`, "branches")) {
        const branchId = resourceId(branch, "branches");
        if (!branchId) continue;
        for (const endpoint of await this.list(
          client,
          `${projectPath}/branches/${branchId}/endpoints`,
          "endpoints",
        )) {
          const candidate = text(at(endpoint, "status", "hosts", "host"));
          const endpointId = resourceId(endpoint, "endpoints");
          if (candidate === host && endpointId) {
            return { project: projectId, branch: branchId, endpointId };
          }
        }
      }
    }
    return undefined;
  }

  private async list(client: DatabricksClient, path: string, field: string): Promise<object[]> {
    const values: object[] = [];
    let pageToken: string | undefined;
    do {
      const query = pageToken ? `${path}?page_token=${encodeURIComponent(pageToken)}` : path;
      const response = record(await client.request(query));
      const page = response[field];
      if (Array.isArray(page)) values.push(...page.filter(isRecord));
      pageToken = text(response.next_page_token);
    } while (pageToken);
    return values;
  }
}

function selectProject(projects: object[]): string {
  const usable = projects.map((value) => resourceId(value, "projects")).filter(isString);
  if (usable.length === 1) return usable[0]!;
  throw new Error(
    usable.length === 0
      ? "No Lakebase projects were found"
      : `Multiple Lakebase projects found; specify one: ${usable.join(", ")}`,
  );
}

function selectBranch(project: object, branches: object[], explicit?: string): string {
  if (explicit) return explicit;
  const defaultBranch = text(at(project, "status", "default_branch"));
  if (defaultBranch) return defaultBranch;
  const flagged = branches.find((value) => at(value, "status", "default") === true);
  const candidates = branches.map((value) => resourceId(value, "branches")).filter(isString);
  const selected = resourceId(flagged, "branches") ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!selected) throw new Error(`Lakebase branch is ambiguous: ${candidates.join(", ")}`);
  return selected;
}

function selectEndpoint(endpoints: object[], explicit?: string, host?: string): object {
  const usable = endpoints.filter((value) => !isInactive(value));
  const selected = explicit
    ? usable.find((value) => resourceId(value, "endpoints") === explicit)
    : host
      ? usable.find((value) => text(at(value, "status", "hosts", "host")) === host)
      : usable.find((value) => {
          const type = text(at(value, "status", "endpoint_type"));
          return type === "READ_WRITE" || type === "ENDPOINT_TYPE_READ_WRITE";
        }) ?? (usable.length === 1 ? usable[0] : undefined);
  if (!selected) throw new Error("Lakebase read-write endpoint is ambiguous or unavailable");
  return selected;
}

function selectDatabase(databases: object[], explicit?: string): string {
  const candidates = databases
    .filter((value) => !isInactive(value))
    .map((value) => ({
      id: resourceId(value, "databases"),
      name: text(at(value, "status", "postgres_database")),
    }))
    .filter((value): value is { id: string | undefined; name: string } => Boolean(value.name));
  const selected = explicit
    ? candidates.find((value) => value.id === explicit || value.name === explicit)?.name
    : candidates.find((value) => value.name === DEFAULT_DATABASE)?.name ??
      (candidates.length === 1 ? candidates[0]?.name : undefined);
  if (!selected) throw new Error("Lakebase database is ambiguous or unavailable");
  return selected;
}

function isInactive(value: object): boolean {
  const state = text(at(value, "status", "current_state"))?.toUpperCase();
  return state === "ARCHIVED" || state === "DELETING" || state === "DELETED" || state === "DISABLED";
}

function resourceId(value: object | undefined, kind: string): string | undefined {
  const name = value ? text(record(value).name) : undefined;
  if (!name) return undefined;
  const parts = name.split("/");
  const index = parts.lastIndexOf(kind);
  return index >= 0 ? parts[index + 1] : undefined;
}

function isDatabricksApp(): boolean {
  return Boolean(process.env.DATABRICKS_APP_NAME || process.env.DATABRICKS_APP_PORT);
}

function timed<T>(value: T, ttlMs: number): Timed<T> {
  return { value, expiresAt: Date.now() + ttlMs };
}

function current<T>(entry: Timed<T> | undefined): T | undefined {
  return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Databricks API response is not an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function at(value: object, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) current = isRecord(current) ? current[key] : undefined;
  return current;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
