import { log, toError, urlBuilder } from "@dbx-tools/shared-core";
import { z } from "zod";

const LAKEBOX_ROOT = "/api/2.0/lakebox";
const LAKEBOXES_PATH = `${LAKEBOX_ROOT}/sandboxes`;
const SSH_KEYS_PATH = `${LAKEBOX_ROOT}/ssh-keys`;
const ORG_ID_HEADER = "X-Databricks-Org-Id";
const logger = log.logger("lakebox:rest");

export const LakeboxEntrySchema = z
  .object({
    sandboxId: z.string().describe("Lakebox identifier; also the SSH gateway username."),
    status: z.string().describe("Upstream lifecycle status, such as Running or Stopped."),
    gatewayHost: z.string().optional().describe("SSH gateway hostname."),
    name: z.string().optional().describe("Display label."),
    createTime: z.string().optional().describe("Creation time."),
    lastStartTime: z.string().optional().describe("Last start time."),
    idleTimeout: z.string().optional().describe("Platform idle timeout, such as 600s."),
    noAutostop: z.boolean().optional().describe("Whether idle auto-stop is disabled."),
  })
  .passthrough()
  .describe("Lakebox record returned by the Databricks Lakebox REST API.");
/** Lakebox record returned by the Databricks Lakebox REST API. */
export type LakeboxEntry = z.infer<typeof LakeboxEntrySchema>;

const LakeboxListSchema = z
  .object({
    sandboxes: z.array(LakeboxEntrySchema).default([]),
    nextPageToken: z.string().optional(),
  })
  .passthrough();

export const LakeboxSshKeySchema = z
  .object({
    keyHash: z.string().describe("Registered public key hash."),
    name: z.string().optional().describe("Key label."),
    gatewayHost: z.string().optional().describe("Gateway hostname for this key."),
  })
  .passthrough()
  .describe("Registered SSH key returned by the Databricks Lakebox REST API.");
/** Registered SSH key returned by the Databricks Lakebox REST API. */
export type LakeboxSshKey = z.infer<typeof LakeboxSshKeySchema>;

const LakeboxSshKeyListSchema = z
  .object({ sshKeys: z.array(LakeboxSshKeySchema).default([]) })
  .passthrough();

/**
 * Workspace credentials for Lakebox REST calls.
 *
 * The Databricks SDK and AppKit `WorkspaceClient.config` satisfy this shape, as
 * does a small adapter over `@dbx-tools/auth`. Lakebox lifecycle calls must use
 * the app service principal, never request-scoped OBO credentials.
 */
export interface LakeboxAuth {
  /** Workspace URL. */
  readonly host?: string;
  /** Numeric workspace identifier, when known. */
  readonly workspaceId?: string;
  /** Resolves lazy configuration before `host` is read. */
  ensureResolved?(): Promise<void>;
  /** Adds authentication headers to one request. */
  authenticate(headers: Headers): Promise<void>;
}

/** Error raised for a non-success Lakebox REST response. */
export class LakeboxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "LakeboxApiError";
  }
}

type RequestMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * REST client for Databricks Lakeboxes and registered SSH keys.
 *
 * Responses are validated before they reach callers. Diagnostics never include
 * tokens or request headers.
 */
export class LakeboxClient {
  /** Creates a client for one workspace credential. */
  constructor(private readonly auth: LakeboxAuth) {}

  /** Returns the workspace identifier, or the workspace origin when the identifier is unknown. */
  async workspaceScope(): Promise<string> {
    await this.auth.ensureResolved?.();
    return (
      process.env.DATABRICKS_WORKSPACE_ID?.trim() ||
      this.auth.workspaceId?.trim() ||
      urlBuilder(this.auth.host ?? "")?.origin ||
      "workspace"
    );
  }

  /** Lists every Lakebox visible to the caller, following pagination. */
  async list(signal?: AbortSignal): Promise<LakeboxEntry[]> {
    const entries: LakeboxEntry[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (pageToken) query.set("page_token", pageToken);
      const response = LakeboxListSchema.parse(
        await this.request("GET", `${LAKEBOXES_PATH}?${query}`, undefined, signal),
      );
      entries.push(...response.sandboxes);
      pageToken = response.nextPageToken || undefined;
    } while (pageToken);
    return entries;
  }

  /** Returns one Lakebox by ID. */
  async get(id: string, signal?: AbortSignal): Promise<LakeboxEntry> {
    return LakeboxEntrySchema.parse(await this.request("GET", lakeboxPath(id), undefined, signal));
  }

  /** Creates a Lakebox with a Databricks-assigned display name. */
  async create(signal?: AbortSignal): Promise<LakeboxEntry> {
    return LakeboxEntrySchema.parse(
      await this.request("POST", LAKEBOXES_PATH, { sandbox: {} }, signal),
    );
  }

  /** Sets the platform idle timeout that stops the Lakebox after inactivity. */
  async setIdleTimeout(id: string, seconds: number, signal?: AbortSignal): Promise<LakeboxEntry> {
    return LakeboxEntrySchema.parse(
      await this.request(
        "PATCH",
        lakeboxPath(id),
        { sandbox_id: id, idle_timeout: `${seconds}s` },
        signal,
      ),
    );
  }

  /** Permanently deletes one Lakebox and its persistent home. */
  async delete(id: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", lakeboxPath(id), undefined, signal);
  }

  /** Requests a start and returns the updated record. */
  async start(id: string, signal?: AbortSignal): Promise<LakeboxEntry> {
    return LakeboxEntrySchema.parse(
      await this.request("POST", `${lakeboxPath(id)}/start`, { sandbox_id: id }, signal),
    );
  }

  /** Requests a stop and returns the updated record. */
  async stop(id: string, signal?: AbortSignal): Promise<LakeboxEntry> {
    return LakeboxEntrySchema.parse(
      await this.request("POST", `${lakeboxPath(id)}/stop`, { sandbox_id: id }, signal),
    );
  }

  /** Lists SSH public keys registered by the caller. */
  async listKeys(signal?: AbortSignal): Promise<LakeboxSshKey[]> {
    return LakeboxSshKeyListSchema.parse(
      await this.request("GET", SSH_KEYS_PATH, undefined, signal),
    ).sshKeys;
  }

  /** Registers an SSH public key and returns the Databricks key record. */
  async registerKey(publicKey: string, name: string, signal?: AbortSignal): Promise<LakeboxSshKey> {
    return LakeboxSshKeySchema.parse(
      await this.request("POST", SSH_KEYS_PATH, { public_key: publicKey, name }, signal),
    );
  }

  private async request(
    method: RequestMethod,
    path: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.auth.ensureResolved?.();
    const host = this.auth.host?.replace(/\/+$/, "");
    if (!host) throw new Error("Lakebox REST requests require a Databricks workspace host");
    const headers = new Headers({ Accept: "application/json" });
    const workspaceId = this.auth.workspaceId;
    if (workspaceId && workspaceId !== "none") headers.set(ORG_ID_HEADER, workspaceId);
    if (payload !== undefined) headers.set("Content-Type", "application/json");
    await this.auth.authenticate(headers);
    const startedAt = Date.now();
    const metadata = { method, path: path.split("?")[0], hasPayload: payload !== undefined };
    logger.debug("lakebox REST request", metadata);
    let response: Response;
    try {
      response = await fetch(`${host}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      logger.warn("lakebox REST request failed", {
        ...metadata,
        durationMs: Date.now() - startedAt,
        error: toError(error),
      });
      throw error;
    }
    const text = await response.text();
    const body = parseBody(text);
    if (!response.ok) {
      const record = z
        .object({
          message: z.string().optional(),
          error_code: z.string().optional(),
          request_id: z.string().optional(),
        })
        .passthrough()
        .safeParse(body);
      const details = record.success ? record.data : {};
      const error = new LakeboxApiError(
        details.message || `Lakebox request failed (${response.status})`,
        response.status,
        details.error_code,
        details.request_id ?? response.headers.get("x-request-id") ?? undefined,
      );
      logger.warn("lakebox REST request failed", {
        ...metadata,
        durationMs: Date.now() - startedAt,
        status: error.status,
        errorCode: error.errorCode,
        requestId: error.requestId,
      });
      throw error;
    }
    logger.debug("lakebox REST response", { ...metadata, durationMs: Date.now() - startedAt });
    return body ?? {};
  }
}

/**
 * Returns whether an API error indicates that Lakeboxes are unavailable in the
 * workspace or region.
 */
export function isLakeboxUnavailable(error: unknown): boolean {
  if (!(error instanceof LakeboxApiError)) return false;
  return (
    error.status === 404 ||
    error.status === 503 ||
    /not available in your region/i.test(error.message)
  );
}

function lakeboxPath(id: string): string {
  return `${LAKEBOXES_PATH}/${encodeURIComponent(id)}`;
}

function parseBody(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 4_000) };
  }
}
