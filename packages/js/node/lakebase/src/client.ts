/**
 * Profile-aware Lakebase discovery and short-lived database credentials.
 *
 * This module is the Node owner for resolving a parsed target into concrete
 * connection identity. Reuse {@link LakebaseClient} from AppKit integrations,
 * CLIs, and proxies instead of calling Lakebase APIs or selecting defaults in
 * each consumer.
 *
 * @module
 */

import {
  client as authClient,
  profile as authProfile,
  type AuthClient,
  type DatabricksAuthOptions,
} from "@dbx-tools/auth";
import type { DatabricksProfileSummary } from "@dbx-tools/shared-auth";
import { log, object, stringUtils } from "@dbx-tools/shared-core";
import { z } from "zod";

import type { ParsedAddress } from "./address.ts";

const logger = log.logger("lakebase");
const API_BASE = "/api/2.0/postgres";
const CREDENTIAL_REFRESH_BUFFER_MS = 2 * 60_000;
/** Postgres database name Lakebase provisions on a new branch. */
const LAKEBASE_DEFAULT_DATABASE = "databricks_postgres";
/** Resource id Lakebase uses for {@link LAKEBASE_DEFAULT_DATABASE}. */
const LAKEBASE_DEFAULT_DATABASE_ID = "databricks-postgres";
/**
 * Built-in database name for ordinary PostgreSQL (including Graphiti's
 * embedded server). A Lakebase path or URL that only names this database
 * has not chosen a Lakebase database yet.
 */
const GENERIC_POSTGRES_DATABASE = "postgres";
const DISCOVERY_TTL_MS = 30_000;
const SESSION_TTL_MS = 10 * 60_000;

/** Lakebase OAuth credential returned by the Databricks Postgres API. */
export const DatabaseCredentialSchema = z
  .object({
    token: z.string().min(1).describe("OAuth token used as the PostgreSQL password."),
    expire_time: z
      .string()
      .datetime()
      .describe("UTC ISO 8601 time when the PostgreSQL OAuth token expires."),
  })
  .describe("Short-lived Lakebase PostgreSQL OAuth credential.");

/** Lakebase OAuth credential returned by the Databricks Postgres API. */
export type DatabaseCredential = z.infer<typeof DatabaseCredentialSchema>;

/** Resolved Lakebase endpoint and database connection identity. */
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

/** Minimal authenticated Databricks API surface used by Lakebase discovery. */
export interface LakebaseApiClient {
  profiles(): DatabricksProfileSummary[];
  request(path: string, options?: LakebaseRequestOptions): Promise<unknown>;
}

/** Lakebase-owned request options for its Databricks APIs. */
export interface LakebaseRequestOptions {
  body?: unknown;
  signal?: AbortSignal;
}

/** Injectable Lakebase discovery dependencies. */
export interface LakebaseClientDependencies {
  createClient(options: DatabricksAuthOptions): Promise<LakebaseApiClient>;
  isDatabricksApp(): boolean;
}

const DEFAULT_DEPENDENCIES: LakebaseClientDependencies = {
  createClient: async (options) => {
    const auth = await authClient.createAuthClient(options);
    return {
      profiles: () => authProfile.listProfiles(),
      request: (path, requestOptions) => request(auth, path, requestOptions),
    };
  },
  isDatabricksApp,
};

/** Cached Lakebase discovery and short-lived database credential client. */
export class LakebaseClient {
  private readonly sessions = new Map<string, Timed<LakebaseApiClient>>();
  private readonly resolved = new Map<string, Timed<ResolvedLakebase>>();
  private readonly credentials = new Map<string, Timed<string>>();
  private readonly credentialRefreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly authOptions: DatabricksAuthOptions = {},
    private readonly dependencies = DEFAULT_DEPENDENCIES,
  ) {}

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
    const key = `${profile ?? "<default>"}:${endpoint}`;
    const cached = current(this.credentials.get(key));
    if (cached) return cached;
    const pending = this.credentialRefreshes.get(key);
    if (pending) return pending;
    const refresh = this.refreshDatabaseCredential(key, endpoint, profile);
    this.credentialRefreshes.set(key, refresh);
    return refresh;
  }

  private async refreshDatabaseCredential(
    key: string,
    endpoint: string,
    profile?: string,
  ): Promise<string> {
    try {
      const credential = DatabaseCredentialSchema.parse(
        await (
          await this.session(profile)
        ).request(`${API_BASE}/credentials`, {
          body: { endpoint },
        }),
      );
      const expiresAt = Date.parse(credential.expire_time);
      const cacheExpiresAt = expiresAt - CREDENTIAL_REFRESH_BUFFER_MS;
      if (cacheExpiresAt > Date.now()) {
        this.credentials.set(key, { value: credential.token, expiresAt: cacheExpiresAt });
      }
      return credential.token;
    } finally {
      this.credentialRefreshes.delete(key);
    }
  }

  private async session(profile?: string): Promise<LakebaseApiClient> {
    const key = profile ?? "<default>";
    const cached = current(this.sessions.get(key));
    if (cached) return cached;
    const value = await this.dependencies.createClient({ ...this.authOptions, profile });
    this.sessions.set(key, timed(value, SESSION_TTL_MS));
    return value;
  }

  private async resolveProfile(startupUser?: string): Promise<string | undefined> {
    if (this.authOptions.profile) return this.authOptions.profile;
    const candidate = startupUser?.trim();
    if (!candidate || this.dependencies.isDatabricksApp()) return undefined;
    const client = await this.session();
    const exists = client.profiles().some((profile) => profile.name === candidate);
    logger.debug("resolved Lakebase startup profile", { startupUser: candidate, exists });
    return exists ? candidate : undefined;
  }

  private async discover(
    client: LakebaseApiClient,
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
    client: LakebaseApiClient,
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
          const endpointId = resourceId(endpoint, "endpoints");
          if (endpointHosts(endpoint).includes(host) && endpointId) {
            return { project: projectId, branch: branchId, endpointId };
          }
        }
      }
    }
    return undefined;
  }

  private async list(client: LakebaseApiClient, path: string, field: string): Promise<object[]> {
    const values: object[] = [];
    let pageToken: string | undefined;
    do {
      const query = pageToken ? `${path}?page_token=${encodeURIComponent(pageToken)}` : path;
      const response = record(await client.request(query));
      const page = response[field];
      if (Array.isArray(page)) values.push(...page.filter(object.isRecord));
      pageToken = text(response.next_page_token);
    } while (pageToken);
    return values;
  }
}

/** Create one cached Lakebase discovery and credential client. */
export function createLakebaseClient(options: DatabricksAuthOptions = {}): LakebaseClient {
  return new LakebaseClient(options);
}

function selectProject(projects: object[]): string {
  const usable = projects
    .filter((value) => !isInactive(value))
    .map((value) => resourceId(value, "projects"))
    .filter(isString);
  if (usable.length === 1) return usable[0]!;
  throw new Error(
    usable.length === 0
      ? "No Lakebase projects were found"
      : `Multiple Lakebase projects found; specify one: ${usable.join(", ")}`,
  );
}

function selectBranch(project: object, branches: object[], explicit?: string): string {
  const usable = branches.filter((value) => !isInactive(value));
  if (explicit) {
    const match = usable.find((value) => resourceId(value, "branches") === explicit);
    if (!match) throw new Error(`Lakebase branch is unavailable: ${explicit}`);
    return explicit;
  }
  const defaultBranch = text(at(project, "status", "default_branch"));
  const flagged = usable.find((value) => at(value, "status", "default") === true);
  const candidates = usable.map((value) => resourceId(value, "branches")).filter(isString);
  const selected =
    candidates.length === 1
      ? candidates[0]
      : (candidates.find((candidate) => candidate === resourcePathId(defaultBranch, "branches")) ??
        resourceId(flagged, "branches"));
  if (!selected) throw new Error(`Lakebase branch is ambiguous: ${candidates.join(", ")}`);
  return selected;
}

function selectEndpoint(endpoints: object[], explicit?: string, host?: string): object {
  const usable = endpoints.filter((value) => {
    const type = text(at(value, "status", "endpoint_type"))?.toUpperCase();
    return (
      !isInactive(value) &&
      at(value, "status", "disabled") !== true &&
      (type === "READ_WRITE" || type === "ENDPOINT_TYPE_READ_WRITE")
    );
  });
  const selected = explicit
    ? usable.find((value) => resourceId(value, "endpoints") === explicit)
    : host
      ? usable.find((value) => endpointHosts(value).includes(host))
      : usable.length === 1
        ? usable[0]
        : undefined;
  if (!selected) throw new Error("Lakebase read-write endpoint is ambiguous or unavailable");
  return selected;
}

interface DatabaseCandidate {
  id: string | undefined;
  name: string;
  default: boolean;
}

function selectDatabase(databases: object[], explicit?: string): string {
  const candidates = databases
    .filter((value) => !isInactive(value))
    .map((value): DatabaseCandidate => ({
      id: resourceId(value, "databases"),
      name: text(at(value, "status", "postgres_database")) ?? "",
      default: at(value, "status", "default") === true,
    }))
    .filter((value) => Boolean(value.name));
  const requested = isGenericPostgresDatabase(explicit) ? undefined : explicit;
  if (requested) {
    const match = candidates.find((value) => value.id === requested || value.name === requested);
    if (!match) throw new Error(`Lakebase database is unavailable: ${requested}`);
    return match.name;
  }
  const ranked = candidates
    .filter((candidate) => !isGenericPostgresDatabase(candidate.name))
    .sort(compareDatabasePreference);
  const selected = ranked[0];
  const tied =
    selected &&
    ranked.filter((candidate) => compareDatabasePreference(candidate, selected) === 0).length === 1
      ? selected.name
      : undefined;
  if (!tied) throw new Error("Lakebase database is ambiguous or unavailable");
  return tied;
}

/**
 * Rank discovered databases so an unspecified Lakebase path gets the branch
 * default: a `status.default` database, then Lakebase's provisioned
 * `databricks_postgres`, then the only remaining application database. The
 * generic PostgreSQL name `postgres` is removed before this comparison.
 */
function compareDatabasePreference(left: DatabaseCandidate, right: DatabaseCandidate): number {
  if (left.default !== right.default) return left.default ? -1 : 1;
  const leftOwned = isLakebaseDefaultDatabase(left);
  const rightOwned = isLakebaseDefaultDatabase(right);
  if (leftOwned !== rightOwned) return leftOwned ? -1 : 1;
  return 0;
}

function isLakebaseDefaultDatabase(value: DatabaseCandidate): boolean {
  return value.name === LAKEBASE_DEFAULT_DATABASE || value.id === LAKEBASE_DEFAULT_DATABASE_ID;
}

function isGenericPostgresDatabase(value: string | undefined): boolean {
  return value === GENERIC_POSTGRES_DATABASE;
}

function isInactive(value: object): boolean {
  const state = text(at(value, "status", "current_state"))?.toUpperCase();
  return (
    state === "ARCHIVED" || state === "DELETING" || state === "DELETED" || state === "DISABLED"
  );
}

function resourceId(value: object | undefined, kind: string): string | undefined {
  const name = value ? text(record(value).name) : undefined;
  if (!name) return undefined;
  const parts = name.split("/");
  const index = parts.lastIndexOf(kind);
  return index >= 0 ? parts[index + 1] : undefined;
}

function resourcePathId(value: string | undefined, kind: string): string | undefined {
  if (!value) return undefined;
  const parts = value.split("/");
  const index = parts.lastIndexOf(kind);
  return index >= 0 ? parts[index + 1] : value;
}

function endpointHosts(value: object): string[] {
  return ["host", "read_write_pooled_host", "read_only_host"]
    .map((name) => text(at(value, "status", "hosts", name)))
    .filter(isString);
}

function isDatabricksApp(): boolean {
  return Boolean(process.env.DATABRICKS_APP_NAME || process.env.DATABRICKS_APP_PORT);
}

async function request(
  auth: AuthClient,
  path: string,
  options: LakebaseRequestOptions = {},
): Promise<unknown> {
  const url = new URL(path, `${auth.host.replace(/\/$/, "")}/`).toString();
  let headers = await auth.headers();
  let response = await send(url, headers, options);
  if (response.status === 401) {
    headers = await auth.headers({ refresh: true });
    response = await send(url, headers, options);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Databricks Lakebase API ${path} returned HTTP ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

function send(
  url: string,
  authHeaders: Readonly<Record<string, string>>,
  options: LakebaseRequestOptions,
): Promise<Response> {
  const headers = new Headers(authHeaders);
  headers.set("accept", "application/json");
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return fetch(url, {
    method: options.body === undefined ? "GET" : "POST",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal,
  });
}

function timed<T>(value: T, ttlMs: number): Timed<T> {
  return { value, expiresAt: Date.now() + ttlMs };
}

function current<T>(entry: Timed<T> | undefined): T | undefined {
  return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (!object.isRecord(value)) throw new Error("Databricks API response is not an object");
  return value;
}

function at(value: object, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) current = object.isRecord(current) ? current[key] : undefined;
  return current;
}

function text(value: unknown): string | undefined {
  return stringUtils.trimToUndefined(value);
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
