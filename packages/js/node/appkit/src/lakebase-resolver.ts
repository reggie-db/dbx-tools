/**
 * Lakebase Postgres connection resolver.
 *
 * Reads the same env vars the `lakebase` plugin consumes (`PGHOST`,
 * `PGDATABASE`, `PGPORT`, `PGSSLMODE`, `LAKEBASE_ENDPOINT`) and fills in
 * whichever pieces are missing using the Lakebase Autoscaling REST API
 * under `/api/2.0/postgres/` via the Databricks workspace client.
 *
 * `LAKEBASE_ENDPOINT` (and `config.endpoint`) accept anything
 * {@link parseAddress} understands - canonical resource paths, Postgres
 * URIs, bare hostnames, or bare project ids. The resolver layers
 * whatever pieces fall out of parsing under explicit config / env
 * values, then fills the remaining gaps via the API:
 *
 *   1. Reverse-lookup: when a host is known but no resource path is,
 *      scan projects -> branches -> endpoints for a matching
 *      `status.hosts.host` and recover the owning project/branch/endpoint.
 *   2. Pick: when a project is known but child resources aren't, prefer
 *      the server-side default (`status.default`, `ENDPOINT_TYPE_READ_WRITE`,
 *      `databricks_postgres`) and fall back to "the only one" when a
 *      listing returns a single result.
 *   3. Auto-create: when no projects exist at all, create one whose
 *      id defaults to `project.name()` slugified (override
 *      with `config.autoCreate: "my-id"` or disable with
 *      `config.autoCreate: false`). The create call is idempotent - an
 *      `ALREADY_EXISTS` response from a concurrent boot is treated as
 *      success. Then poll the default endpoint until it reports
 *      `current_state` `READY` or `IDLE`.
 *
 * {@link applyLakebaseToEnv} writes the resolved values back to
 * `process.env` so the downstream `lakebase` plugin picks them up.
 *
 * @see https://docs.databricks.com/api/workspace/postgres
 *
 * @module
 */

import {
  ConfigurationError,
  ExecutionError,
  getUsernameWithApiLookup,
  getWorkspaceClient,
  ValidationError,
} from "@databricks/appkit";
import { config as coreConfig, project } from "@dbx-tools/core";
import { async, log, object, string } from "@dbx-tools/shared-core";
import { z } from "zod";

import { toContext } from "./databricks.ts";
import {
  parseAddress,
  parseResourcePath,
  SSL_MODES,
  type LakebaseConnectionInputs,
  type SslMode,
} from "./pgaddress.ts";

const logger = log.logger("lakebase-resolver");
const API_BASE = "/api/2.0/postgres";
const DEFAULT_PORT = 5432;
const DEFAULT_SSL_MODE: SslMode = "require";
const DEFAULT_PG_VERSION = 17;
/** Lakebase project ids: `^[a-z][a-z0-9-]{0,61}[a-z0-9]$`. */
const PROJECT_ID_MAX_LEN = 63;
const OPERATION_TIMEOUT_MS = 5 * 60_000;
const OPERATION_POLL_MS = 2_000;
const ENDPOINT_READY_TIMEOUT_MS = 5 * 60_000;
const ENDPOINT_READY_POLL_MS = 2_000;
/** Ceiling on a single backoff step, so a long wait still polls regularly. */
const POLL_MAX_DELAY_MS = 15_000;
const POLL_BACKOFF_FACTOR = 1.5;
/** Fraction of each delay applied as +/- jitter, so concurrent boots desynchronize. */
const POLL_JITTER_RATIO = 0.2;
/** Endpoint `status.endpoint_type` for the writable primary. */
const READ_WRITE_ENDPOINT_TYPE = "ENDPOINT_TYPE_READ_WRITE";
/** Endpoint `status.current_state` values that will accept a connection. */
const CONNECTABLE_ENDPOINT_STATES = new Set(["READY", "IDLE"]);
/** Endpoint `status.current_state` before a hostname is meaningful. */
const INITIALIZING_ENDPOINT_STATE = "INITIALIZING";
/** Lakebase's own default Postgres database name. */
const DEFAULT_DATABASE = "databricks_postgres";

/**
 * User-supplied Lakebase inputs (config or env) before any API resolution.
 * Extends {@link LakebaseConnectionInputs} with resolver-only options.
 * {@link resolveLakebaseConnection} fills gaps from the Lakebase API when
 * it has enough context (typically a `project`).
 */
export interface LakebaseResolverInputs extends LakebaseConnectionInputs {
  /**
   * What to do when no project exists in the workspace at all.
   * - `undefined` (default): derive a project id from
   *   {@link project.name} (the host repo's `package.json`
   *   name) slugified to Lakebase id constraints, then create it.
   * - `string`: create a new project with this exact id.
   * - `false`: skip creation and throw with a clear error message.
   */
  autoCreate?: string | false;
}

/** Fully-resolved Lakebase Postgres connection. */
export interface LakebaseConnection extends LakebaseConnectionInputs {
  port: number;
  sslMode: SslMode;
}

/**
 * Every field of the Lakebase REST payloads is modelled as optional and
 * validated at the boundary rather than asserted with a cast: the pickers below
 * branch on `status.*`, and a shape change upstream should surface as one loud
 * error here instead of an `undefined` three frames away. Enum-shaped fields
 * stay `string` so a newly added state does not fail the whole response.
 */
const projectSchema = z.object({
  // Full resource path: `projects/{p}`.
  name: z.string().optional(),
});
type Project = z.infer<typeof projectSchema>;

const endpointSchema = z.object({
  // Full resource path: `projects/{p}/branches/{b}/endpoints/{e}`.
  name: z.string().optional(),
  uid: z.string().optional(),
  // Server-side state. All connection info lives here - the spec block
  // only carries the desired configuration, not the runtime hostnames.
  status: z
    .object({
      endpoint_type: z.string().optional(),
      // Resolved hostnames; `hosts.host` is the writable primary.
      hosts: z
        .object({
          host: z.string().optional(),
          read_only_host: z.string().optional(),
        })
        .optional(),
      // Compute state: `INITIALIZING`, `STARTING`, `READY`, `IDLE`, ...
      current_state: z.string().optional(),
    })
    .optional(),
});
type Endpoint = z.infer<typeof endpointSchema>;

const branchSchema = z.object({
  // Full resource path: `projects/{p}/branches/{b}`.
  name: z.string().optional(),
  status: z
    .object({
      // True for the project's default branch (e.g. `production`).
      default: z.boolean().optional(),
      current_state: z.string().optional(),
    })
    .optional(),
});
type Branch = z.infer<typeof branchSchema>;

const databaseSchema = z.object({
  // Full resource path: `projects/{p}/branches/{b}/databases/{d}`.
  name: z.string().optional(),
  status: z
    .object({
      // Actual Postgres database name (used as `PGDATABASE`). May differ
      // from the resource id - e.g. resource `databricks-postgres`
      // surfaces as Postgres database `databricks_postgres`.
      postgres_database: z.string().optional(),
    })
    .optional(),
});
type Database = z.infer<typeof databaseSchema>;

/**
 * Lakebase REST list responses follow the Google AIP convention:
 * `{ <plural-resource>: T[], next_page_token?: string }`. We only read
 * the first page; for auto-config's "pick something sensible" semantics the
 * cap is fine.
 */
const listResponseSchema = z.object({
  next_page_token: z.string().optional(),
  projects: z.array(projectSchema).optional(),
  branches: z.array(branchSchema).optional(),
  endpoints: z.array(endpointSchema).optional(),
  databases: z.array(databaseSchema).optional(),
});

/**
 * Long-running operation envelope returned by mutating REST calls.
 * `done: true` means terminal; check `error` before reading `response`.
 */
const operationSchema = z.object({
  name: z.string().optional(),
  done: z.boolean().optional(),
  error: z.unknown().optional(),
  response: z.unknown().optional(),
});
type Operation = z.infer<typeof operationSchema>;

/** `PGPORT` must land inside the TCP port range. */
const portSchema = z.coerce.number().int().min(1).max(coreConfig.MAX_TCP_PORT);

const sslModeSchema = z.enum(SSL_MODES);

/**
 * Validate a `PGPORT`-shaped value. Returns `undefined` when unset, and throws
 * a {@link ValidationError} naming `PGPORT` for anything that is not a TCP
 * port, so a typo cannot reach the connection record as `NaN`.
 */
export function parsePort(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = portSchema.safeParse(value);
  if (!parsed.success) {
    throw ValidationError.invalidValue(
      "PGPORT",
      value,
      `a TCP port between 1 and ${coreConfig.MAX_TCP_PORT}`,
    );
  }
  return parsed.data;
}

/**
 * Validate a `PGSSLMODE`-shaped value. Returns `undefined` when unset, and
 * throws a {@link ValidationError} naming `PGSSLMODE` for an unsupported mode
 * rather than handing `pg` a value it will reject at connect time.
 */
export function parseSslMode(value: string | undefined): SslMode | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = sslModeSchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) {
    throw ValidationError.invalidValue("PGSSLMODE", value, SSL_MODES.join(", "));
  }
  return parsed.data;
}

/**
 * Delay before the next poll attempt: exponential backoff capped at
 * {@link POLL_MAX_DELAY_MS}, plus jitter so several apps booting against the
 * same workspace do not retry in lockstep.
 */
export function nextPollDelay(attempt: number, baseMs: number): number {
  const backoff = Math.min(baseMs * POLL_BACKOFF_FACTOR ** attempt, POLL_MAX_DELAY_MS);
  const jitter = backoff * POLL_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(backoff + jitter));
}

/**
 * Wait out {@link nextPollDelay} before the next attempt. Rejects with the
 * signal's reason when the caller cancels mid-wait, so a poll loop unwinds
 * instead of finishing its backoff first.
 */
export function pollDelay(attempt: number, baseMs: number, signal?: AbortSignal): Promise<void> {
  return async.sleep(nextPollDelay(attempt, baseMs), signal);
}

/**
 * Pull resolver inputs from `process.env`, parse the address blob, and
 * layer explicit config on top with this precedence:
 *
 *   `config.<field>` > `coreConfig.resolveValue` (shared config sources) >
 *   whatever {@link parseAddress} recovered from the
 *   `endpoint` / `LAKEBASE_ENDPOINT` blob.
 *
 * Set `config.endpoint` (or `LAKEBASE_ENDPOINT`) to any input
 * {@link parseAddress} understands: canonical resource paths, Postgres
 * URIs, bare hostnames, or bare project ids.
 */
export async function readLakebaseInputs(
  config?: LakebaseResolverInputs,
): Promise<LakebaseResolverInputs> {
  const rawAddress = config?.endpoint ?? coreConfig.resolveValue("LAKEBASE_ENDPOINT");
  const parsed = parseAddress(rawAddress);
  const portEnv = parsePort(coreConfig.resolveValue("PGPORT"));
  const sslModeEnv = parseSslMode(coreConfig.resolveValue("PGSSLMODE"));
  return {
    project: config?.project ?? parsed.project,
    branch: config?.branch ?? parsed.branch,
    // Only canonical endpoint resource paths survive here; URIs and
    // bare hostnames set `host` instead and leave `endpoint` undefined
    // until the REST resolver fills it in.
    endpoint: parsed.endpoint,
    database: config?.database ?? coreConfig.resolveValue("PGDATABASE") ?? parsed.database,
    host: config?.host ?? coreConfig.resolveValue("PGHOST") ?? parsed.host,
    port: config?.port ?? portEnv ?? parsed.port,
    sslMode: config?.sslMode ?? sslModeEnv ?? parsed.sslMode,
    autoCreate: config?.autoCreate,
  };
}

/**
 * Resolve a fully-populated Postgres connection record from config + env.
 *
 * Returns immediately without network traffic when env already supplies
 * `endpoint`, `host`, and `database`. Otherwise issues REST calls and
 * may auto-create a project (see module docstring).
 *
 * `signal` cancels every REST call and inter-poll sleep.
 *
 * @example
 * import { lakebaseResolver } from "@dbx-tools/appkit";
 *
 * const resolved = await lakebaseResolver.resolveLakebaseConnection(
 *   { autoCreate: false },
 *   AbortSignal.timeout(60_000),
 * );
 * lakebaseResolver.applyLakebaseToEnv(resolved);
 */
export async function resolveLakebaseConnection(
  config?: LakebaseResolverInputs,
  signal?: AbortSignal,
): Promise<LakebaseConnection> {
  const inputs = await readLakebaseInputs(config);
  let { project, branch, endpoint, database, host } = inputs;
  const port = inputs.port ?? DEFAULT_PORT;
  const sslMode = inputs.sslMode ?? DEFAULT_SSL_MODE;

  // Resource paths may carry redundant info; harvest project/branch
  // from any canonical path that snuck in via PGDATABASE or similar.
  if (endpoint && (!project || !branch)) {
    const parsedEndpoint = parseAddress(endpoint);
    project ??= parsedEndpoint.project;
    branch ??= parsedEndpoint.branch;
  }
  if (database && (!project || !branch)) {
    const parsedDatabase = parseAddress(database);
    project ??= parsedDatabase.project;
    branch ??= parsedDatabase.branch;
    if (parsedDatabase.databaseResourceId) {
      database = parsedDatabase.databaseResourceId;
    }
  }

  // Already complete: skip every REST call.
  if (endpoint && host && database) {
    return { project, branch, endpoint, database, host, port, sslMode };
  }

  const ws = getWorkspaceClient({});

  // Host known but no resource path: scan the workspace to find which
  // endpoint owns this host so we can populate LAKEBASE_ENDPOINT.
  if (!project && host) {
    const found = await findEndpointByHost(ws, host, signal);
    if (found) {
      project = found.project;
      branch = found.branch;
      endpoint ??= found.endpoint;
    }
  }

  // No project anywhere in config/env/address: list, pick, or create.
  if (!project) {
    project = await pickOrCreateProject(ws, config?.autoCreate, signal);
  }

  if (!branch) {
    branch = await pickBranch(ws, project, signal);
  }

  if (!endpoint) {
    const ep = await pickEndpoint(ws, project, branch, signal);
    endpoint = ep.name;
    host ??= ep.host;
  }

  if (!host && endpoint) {
    const parsedEndpoint = parseAddress(endpoint);
    if (parsedEndpoint.project && parsedEndpoint.branch && parsedEndpoint.endpointId) {
      const ep = await waitEndpointReady(
        ws,
        parsedEndpoint.project,
        parsedEndpoint.branch,
        parsedEndpoint.endpointId,
        signal,
      );
      host = ep.status?.hosts?.host;
      logger.debug("autopg: resolved host from endpoint", { host });
    }
  }

  if (!database) {
    database = await pickDatabase(ws, project, branch, signal);
  }

  return { project, branch, endpoint, database, host, port, sslMode };
}

/**
 * Write resolved values back to `process.env` so the `lakebase` plugin
 * (which reads env directly) picks them up during its own `setup()`.
 * Existing env values are preserved; only missing keys are filled in,
 * which keeps explicit overrides authoritative.
 *
 * This does NOT set `PGUSER`, which needs an await - see
 * {@link applyLakebaseEnv} for the complete set a Postgres pool requires.
 */
export function applyLakebaseToEnv(resolved: LakebaseConnection): void {
  if (resolved.endpoint) process.env.LAKEBASE_ENDPOINT ??= resolved.endpoint;
  if (resolved.host) process.env.PGHOST ??= resolved.host;
  if (resolved.database) process.env.PGDATABASE ??= resolved.database;
  process.env.PGPORT ??= String(resolved.port);
  process.env.PGSSLMODE ??= resolved.sslMode;
}

/**
 * Resolve the connection AND apply every Postgres env var a Lakebase pool needs,
 * returning the resolved connection plus the username that was applied.
 *
 * This is the whole set, which is the point of having one function for it:
 * `createLakebasePool()` throws unless `LAKEBASE_ENDPOINT`, `PGHOST`,
 * `PGDATABASE`, **and** a username (`PGUSER`, or `DATABRICKS_CLIENT_ID` for a
 * service principal) are all present, and a Databricks App `postgres` resource
 * binding supplies only the first. Anything that wants a working pool - the
 * `lakebase` plugin, or AppKit's PERSISTENT cache, which quietly degrades to
 * in-memory when the pool cannot be built - needs all four, so callers should not
 * pair {@link applyLakebaseToEnv} with their own username lookup.
 *
 * `PGUSER` is applied with `??=` like the rest, so an explicitly configured value
 * stays authoritative. The lookup returns `undefined` rather than throwing when it
 * cannot determine a user, leaving the pool to resolve its own.
 *
 * @example
 * import { lakebaseResolver } from "@dbx-tools/appkit";
 *
 * // Enough for `createLakebasePool()` to build a pool.
 * const { user } = await lakebaseResolver.applyLakebaseEnv({ autoCreate: false });
 */
export async function applyLakebaseEnv(
  config?: LakebaseResolverInputs,
  signal?: AbortSignal,
): Promise<{ resolved: LakebaseConnection; user?: string }> {
  const resolved = await resolveLakebaseConnection(config, signal);
  applyLakebaseToEnv(resolved);
  const user = await getUsernameWithApiLookup({});
  if (user) process.env.PGUSER ??= user;
  return { resolved, ...(user ? { user } : {}) };
}

type WorkspaceClient = ReturnType<typeof getWorkspaceClient>;

/** The SDK `Context` accepted by the workspace client's own copy of the SDK. */
type ApiRequestContext = NonNullable<Parameters<WorkspaceClient["apiClient"]["request"]>[1]>;

/**
 * Adapt an {@link AbortSignal} into the api client's cancellation context.
 * AppKit resolves a different copy of `@databricks/sdk-experimental` than this
 * package does, and `Context` carries a private field, so the two declarations
 * are nominally incompatible even though the api client only reads
 * `cancellationToken` and `logger` off the object.
 */
function requestContext(signal: AbortSignal | undefined): ApiRequestContext | undefined {
  return signal ? (toContext(signal) as unknown as ApiRequestContext) : undefined;
}

/**
 * Validate a Lakebase REST body. The full payload is logged rather than thrown
 * so a client never receives upstream detail.
 */
function parseResponse<T>(schema: z.ZodType<T>, path: string, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  logger.error("autopg: unexpected Lakebase API response", {
    path,
    issues: parsed.error.issues,
  });
  throw new ExecutionError("Lakebase API returned an unexpected response", { context: { path } });
}

/** GET helper that validates the JSON body and forwards cancellation. */
async function getJson<T>(
  ws: WorkspaceClient,
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await ws.apiClient.request(
    {
      path,
      method: "GET",
      headers: new Headers({ Accept: "application/json" }),
      raw: false,
    },
    requestContext(signal),
  );
  return parseResponse(schema, path, res);
}

/** POST helper for create / mutate calls; validates the JSON body. */
async function postJson<T>(
  ws: WorkspaceClient,
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
  query?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await ws.apiClient.request(
    {
      path,
      method: "POST",
      query,
      headers: new Headers({
        Accept: "application/json",
        "Content-Type": "application/json",
      }),
      raw: false,
      payload: body,
    },
    requestContext(signal),
  );
  return parseResponse(schema, path, res);
}

async function listProjects(ws: WorkspaceClient, signal?: AbortSignal): Promise<Project[]> {
  const res = await getJson(ws, `${API_BASE}/projects`, listResponseSchema, signal);
  return res.projects ?? [];
}

async function listBranches(
  ws: WorkspaceClient,
  project: string,
  signal?: AbortSignal,
): Promise<Branch[]> {
  const res = await getJson(
    ws,
    `${API_BASE}/projects/${project}/branches`,
    listResponseSchema,
    signal,
  );
  return res.branches ?? [];
}

async function listEndpoints(
  ws: WorkspaceClient,
  project: string,
  branch: string,
  signal?: AbortSignal,
): Promise<Endpoint[]> {
  const res = await getJson(
    ws,
    `${API_BASE}/projects/${project}/branches/${branch}/endpoints`,
    listResponseSchema,
    signal,
  );
  return res.endpoints ?? [];
}

async function listDatabases(
  ws: WorkspaceClient,
  project: string,
  branch: string,
  signal?: AbortSignal,
): Promise<Database[]> {
  const res = await getJson(
    ws,
    `${API_BASE}/projects/${project}/branches/${branch}/databases`,
    listResponseSchema,
    signal,
  );
  return res.databases ?? [];
}

async function getEndpoint(
  ws: WorkspaceClient,
  project: string,
  branch: string,
  endpointId: string,
  signal?: AbortSignal,
): Promise<Endpoint> {
  return getJson(
    ws,
    `${API_BASE}/projects/${project}/branches/${branch}/endpoints/${endpointId}`,
    endpointSchema,
    signal,
  );
}

/**
 * Scan the workspace for an endpoint whose `status.hosts.host` matches
 * the provided hostname. Used to recover the owning project/branch/
 * endpoint resource path when the caller only supplied a Postgres URI.
 *
 * O(projects * branches * endpoints) - fine for typical workspaces
 * (single digits per tier); pagination is intentionally not followed
 * since this is a best-effort fallback.
 */
async function findEndpointByHost(
  ws: WorkspaceClient,
  host: string,
  signal?: AbortSignal,
): Promise<{ project: string; branch: string; endpoint: string } | null> {
  const projects = await listProjects(ws, signal);
  for (const p of projects) {
    const projectId = parseResourcePath(p.name).project;
    if (!projectId) continue;
    const branches = await listBranches(ws, projectId, signal);
    for (const b of branches) {
      const branchId = parseResourcePath(b.name).branch;
      if (!branchId) continue;
      const endpoints = await listEndpoints(ws, projectId, branchId, signal);
      const match = endpoints.find((e) => e.status?.hosts?.host === host);
      if (match?.name) {
        logger.debug("autopg: matched endpoint by host", {
          host,
          endpoint: match.name,
        });
        return {
          project: projectId,
          branch: branchId,
          endpoint: match.name,
        };
      }
    }
  }
  logger.debug("autopg: no endpoint matched host", { host });
  return null;
}

/**
 * Pick the project to use, or create one when the workspace is empty.
 *
 * Selection order:
 * 1. Exactly one project listed -> use it.
 * 2. Zero projects AND `autoCreate !== false` -> ensure a project with
 *    the resolved id exists, then return its id.
 * 3. Zero projects AND `autoCreate === false` -> throw.
 * 4. Multiple projects -> throw with the candidate list (set
 *    `config.project` or pin a project id in `LAKEBASE_ENDPOINT`).
 */
async function pickOrCreateProject(
  ws: WorkspaceClient,
  autoCreate: string | false | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const projects = await listProjects(ws, signal);
  if (projects.length === 1) {
    const id = parseResourcePath(projects[0]!.name).project;
    if (id) {
      logger.debug("autopg: using only project", { project: id });
      return id;
    }
  }
  if (projects.length === 0) {
    if (autoCreate === false) {
      throw ConfigurationError.resourceNotFound(
        "Lakebase project",
        "autoCreate is false; create a project or set config.project / LAKEBASE_ENDPOINT.",
      );
    }
    const id = autoCreate ?? (await defaultProjectId());
    return ensureProject(ws, id, signal);
  }
  const candidates = projects
    .map((p) => parseResourcePath(p.name).project)
    .filter((id): id is string => Boolean(id))
    .join(", ");
  throw ConfigurationError.invalidConnection(
    "Lakebase",
    `Multiple projects found; set config.project or pin a project id in LAKEBASE_ENDPOINT. Candidates: ${candidates}`,
  );
}

/**
 * Derive a Lakebase project id from the host repo's `package.json`
 * name (via {@link project.name}) slugified to satisfy the
 * Lakebase id constraint (`^[a-z][a-z0-9-]{0,61}[a-z0-9]$`).
 *
 * Throws when the slug ends up empty or starts with a digit, since the
 * server would reject it anyway - callers should pass an explicit
 * `autoCreate` id in that case.
 */
async function defaultProjectId(): Promise<string> {
  const name = project.name();
  const slug = string.toSlugWithOptions({ maxLength: PROJECT_ID_MAX_LEN }, name);
  if (!slug || !/^[a-z]/.test(slug)) {
    logger.warn("autopg: project name does not slugify to a Lakebase project id", { name });
    throw ConfigurationError.invalidConnection(
      "Lakebase",
      "Could not derive a project id from the package name; pass autoCreate explicitly.",
    );
  }
  return slug;
}

/**
 * Ensure a Lakebase project with `projectId` exists. Creates it and
 * waits for the create operation to complete. An `ALREADY_EXISTS`
 * response is treated as success - someone else (a concurrent boot,
 * a sibling process) won the race and the project we wanted is now
 * sitting there ready for downstream pickers.
 *
 * Project creation typically provisions a default `production` branch
 * alongside; downstream pickers handle the rest.
 */
async function ensureProject(
  ws: WorkspaceClient,
  projectId: string,
  signal?: AbortSignal,
): Promise<string> {
  logger.warn("autopg: no projects found; creating", { project: projectId });
  try {
    const op = await postJson(
      ws,
      `${API_BASE}/projects`,
      operationSchema,
      { spec: { pg_version: DEFAULT_PG_VERSION } },
      { project_id: projectId },
      signal,
    );
    await waitForOperation(ws, op, signal);
    logger.info("autopg: created project", { project: projectId });
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
    logger.info("autopg: project already exists (race); proceeding", {
      project: projectId,
    });
  }
  return projectId;
}

/**
 * Recognize the Databricks SDK's `ALREADY_EXISTS` failure modes so a
 * lost race during `ensureProject` becomes a no-op instead of an error.
 *
 * The SDK throws `ApiError { errorCode, statusCode }` for structured
 * server errors and `HttpError { code }` for transport-layer 4xx/5xx.
 * Both surface a human message that often carries "already exists" so
 * we use that as a final fallback for forward compatibility.
 */
function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    statusCode?: number;
    code?: number;
    errorCode?: string;
    message?: string;
  };
  if (e.statusCode === 409 || e.code === 409) return true;
  if (e.errorCode && /already.?exists/i.test(e.errorCode)) return true;
  if (e.message && /already.?exists/i.test(e.message)) return true;
  return false;
}

/**
 * Reduce a Lakebase operation failure to an error safe to propagate: the
 * operation name plus whatever code the payload carries. The payload itself can
 * echo request context, so it goes to the log instead.
 */
function operationFailed(opName: string, opError: unknown): ExecutionError {
  logger.error("autopg: operation failed", { operation: opName, error: opError });
  const code = object.isRecord(opError) ? (opError.code ?? opError.reason) : undefined;
  return new ExecutionError(`Lakebase operation failed: ${opName}`, {
    context: {
      operation: opName,
      errorCode: typeof code === "string" || typeof code === "number" ? String(code) : "unknown",
    },
  });
}

/**
 * Poll a Lakebase long-running operation until `done: true`. Returns
 * the final operation envelope (which may carry `response` or `error`).
 *
 * Throws when:
 *   - the response carries an `error` field;
 *   - `op.name` is missing (nothing to poll);
 *   - the timeout elapses before `done: true`;
 *   - `signal` aborts mid-wait.
 */
async function waitForOperation(
  ws: WorkspaceClient,
  op: Operation,
  signal?: AbortSignal,
): Promise<Operation> {
  if (op.done) {
    if (op.error) {
      throw operationFailed(op.name ?? "unknown", op.error);
    }
    return op;
  }
  const opName = op.name;
  if (!opName) {
    throw ExecutionError.missingData("operation name");
  }
  const start = Date.now();
  for (let attempt = 0; Date.now() - start < OPERATION_TIMEOUT_MS; attempt++) {
    await pollDelay(attempt, OPERATION_POLL_MS, signal);
    const current = await getJson(ws, `${API_BASE}/${opName}`, operationSchema, signal);
    logger.debug("autopg: operation status", { op: opName, done: current.done });
    if (current.done) {
      if (current.error) {
        throw operationFailed(opName, current.error);
      }
      return current;
    }
  }
  throw new ExecutionError(`Lakebase operation did not complete: ${opName}`, {
    context: { operation: opName, timeoutMs: OPERATION_TIMEOUT_MS },
  });
}

/**
 * Poll `getEndpoint` until the compute reports a usable
 * `status.current_state`. `READY` and `IDLE` are both acceptable -
 * `IDLE` just means the compute has scaled to zero but a connection
 * will wake it. Returns the final endpoint payload (with `hosts.host`).
 */
async function waitEndpointReady(
  ws: WorkspaceClient,
  project: string,
  branch: string,
  endpointId: string,
  signal?: AbortSignal,
): Promise<Endpoint> {
  const start = Date.now();
  let last: Endpoint | null = null;
  for (let attempt = 0; Date.now() - start < ENDPOINT_READY_TIMEOUT_MS; attempt++) {
    last = await getEndpoint(ws, project, branch, endpointId, signal);
    const state = last.status?.current_state;
    if (state && CONNECTABLE_ENDPOINT_STATES.has(state)) return last;
    if (last.status?.hosts?.host && state !== INITIALIZING_ENDPOINT_STATE) {
      // Compute is in some other state (STARTING, etc.) but hostname is
      // already published - good enough to connect; lakebase's OAuth
      // token request will wake it.
      return last;
    }
    logger.debug("autopg: waiting for endpoint", { endpointId, state });
    await pollDelay(attempt, ENDPOINT_READY_POLL_MS, signal);
  }
  throw new ExecutionError(`Lakebase endpoint did not become ready: ${endpointId}`, {
    context: {
      project,
      branch,
      endpointId,
      timeoutMs: ENDPOINT_READY_TIMEOUT_MS,
      lastState: last?.status?.current_state ?? "unknown",
    },
  });
}

/**
 * Pick the default branch for a project. Prefers the branch flagged
 * `status.default: true` (server-side default, typically `production`
 * unless the project owner changed it). Falls back to the only branch
 * when there's exactly one. Otherwise throws with the candidate list.
 */
async function pickBranch(
  ws: WorkspaceClient,
  project: string,
  signal?: AbortSignal,
): Promise<string> {
  const branches = await listBranches(ws, project, signal);
  if (branches.length === 0) {
    throw ConfigurationError.resourceNotFound(
      `Lakebase branch in project '${project}'`,
      "The project has no branches; create one or set config.branch.",
    );
  }
  const flagged = branches.find((b) => b.status?.default === true);
  const choice =
    parseResourcePath(flagged?.name).branch ??
    (branches.length === 1 ? parseResourcePath(branches[0]!.name).branch : undefined);
  if (!choice) {
    const candidates = branches
      .map((b) => parseResourcePath(b.name).branch)
      .filter((id): id is string => Boolean(id))
      .join(", ");
    throw ConfigurationError.invalidConnection(
      "Lakebase",
      `Project '${project}' has multiple branches and none marked default; set config.branch or include the branch in LAKEBASE_ENDPOINT. Candidates: ${candidates}`,
    );
  }
  logger.debug("autopg: resolved branch", { project, branch: choice });
  return choice;
}

/**
 * Pick the primary endpoint for a (project, branch). Prefers
 * `status.endpoint_type === ENDPOINT_TYPE_READ_WRITE`; falls back to
 * the only endpoint when there's exactly one. Returns `{ name, host }`
 * so the caller can populate both `LAKEBASE_ENDPOINT` and `PGHOST`
 * from a single call.
 */
async function pickEndpoint(
  ws: WorkspaceClient,
  project: string,
  branch: string,
  signal?: AbortSignal,
): Promise<{ name: string; host?: string }> {
  const endpoints = await listEndpoints(ws, project, branch, signal);
  if (endpoints.length === 0) {
    throw ConfigurationError.resourceNotFound(
      `Lakebase endpoint in 'projects/${project}/branches/${branch}'`,
      "The branch has no endpoints; create one or set LAKEBASE_ENDPOINT.",
    );
  }
  const primary =
    endpoints.find((e) => e.status?.endpoint_type === READ_WRITE_ENDPOINT_TYPE) ??
    (endpoints.length === 1 ? endpoints[0] : undefined);
  if (!primary?.name) {
    const names = endpoints.map((e) => e.name).filter(Boolean);
    throw ConfigurationError.invalidConnection(
      "Lakebase",
      `Branch has no primary read-write endpoint; set LAKEBASE_ENDPOINT or config.endpoint. Candidates: ${names.join(", ")}`,
    );
  }
  const host = primary.status?.hosts?.host;
  logger.debug("autopg: resolved endpoint", { endpoint: primary.name, host });
  return { name: primary.name, host };
}

/**
 * Pick the default postgres database for a (project, branch). The
 * Postgres database NAME (`status.postgres_database`) is what
 * `PGDATABASE` needs - this differs from the resource id, which can
 * use a different separator (e.g. resource `databricks-postgres`
 * surfaces as database `databricks_postgres`). Prefers
 * `databricks_postgres` (the Lakebase default), otherwise the only
 * database.
 */
async function pickDatabase(
  ws: WorkspaceClient,
  project: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const databases = await listDatabases(ws, project, branch, signal);
  if (databases.length === 0) {
    throw ConfigurationError.resourceNotFound(
      `Lakebase database in 'projects/${project}/branches/${branch}'`,
      "The branch has no databases; create one or set PGDATABASE.",
    );
  }
  const names = databases
    .map((d) => d.status?.postgres_database)
    .filter((n): n is string => Boolean(n));
  const choice =
    names.find((n) => n === DEFAULT_DATABASE) ?? (names.length === 1 ? names[0] : undefined);
  if (!choice) {
    throw ConfigurationError.invalidConnection(
      "Lakebase",
      `Multiple databases and no '${DEFAULT_DATABASE}'; set PGDATABASE or config.database. Candidates: ${names.join(", ")}`,
    );
  }
  logger.debug("autopg: resolved database", { database: choice });
  return choice;
}
