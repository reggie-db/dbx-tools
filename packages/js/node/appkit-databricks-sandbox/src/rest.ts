import type { WorkspaceClient } from "@databricks/appkit";
import { databricks } from "@dbx-tools/appkit";
import { log, net, object } from "@dbx-tools/shared-core";
import { z } from "zod";

const SANDBOX_ROOT = "/api/2.0/lakebox";
const SANDBOX_PATH = `${SANDBOX_ROOT}/sandboxes`;
const SSH_KEYS_PATH = `${SANDBOX_ROOT}/ssh-keys`;
const ORG_ID_HEADER = "X-Databricks-Org-Id";
const logger = log.logger("appkit-databricks-sandbox:rest");

const sandboxEntrySchema = z
  .object({
    sandboxId: z.string(),
    status: z.string(),
    gatewayHost: z.string().optional(),
    name: z.string().optional(),
    createTime: z.string().optional(),
    lastStartTime: z.string().optional(),
    idleTimeout: z.string().optional(),
    noAutostop: z.boolean().optional(),
  })
  .passthrough();
const sandboxCreateResponseSchema = z
  .object({
    sandboxId: z.string(),
    status: z.string(),
    gatewayHost: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();
const sandboxListSchema = z
  .object({
    sandboxes: z.array(sandboxEntrySchema).default([]),
    nextPageToken: z.string().optional(),
  })
  .passthrough();
const sshKeySchema = z
  .object({
    keyHash: z.string(),
    name: z.string().optional(),
    gatewayHost: z.string().optional(),
  })
  .passthrough();
const sshKeyListSchema = z.object({ sshKeys: z.array(sshKeySchema).default([]) }).passthrough();

/** Databricks Sandbox record returned by the Lakebox REST API. */
export type SandboxEntry = z.infer<typeof sandboxEntrySchema>;
/** Registered SSH key record returned by the Lakebox REST API. */
export type SshKeyEntry = z.infer<typeof sshKeySchema>;

type RequestMethod = "GET" | "POST" | "DELETE";

/** REST client for existing Databricks Sandboxes and their registered SSH keys. */
export class DatabricksSandboxClient {
  private readonly scope: string;

  constructor(private readonly client: WorkspaceClient) {
    const workspaceId = client.config.workspaceId || process.env.DATABRICKS_WORKSPACE_ID;
    const host = client.config.host || process.env.DATABRICKS_HOST;
    this.scope = workspaceId || net.urlBuilder(host)?.origin || "workspace";
  }

  workspaceScope(): string {
    return this.scope;
  }

  async list(signal?: AbortSignal): Promise<SandboxEntry[]> {
    const entries: SandboxEntry[] = [];
    let pageToken: string | undefined;
    do {
      const response = sandboxListSchema.parse(
        await this.request("GET", SANDBOX_PATH, {
          query: { page_size: "100", ...(pageToken ? { page_token: pageToken } : {}) },
          signal,
        }),
      );
      entries.push(...response.sandboxes);
      pageToken = response.nextPageToken || undefined;
    } while (pageToken);
    return entries;
  }

  async get(id: string, signal?: AbortSignal): Promise<SandboxEntry> {
    return sandboxEntrySchema.parse(
      await this.request("GET", `${SANDBOX_PATH}/${encodeURIComponent(id)}`, { signal }),
    );
  }

  async create(name?: string, signal?: AbortSignal): Promise<SandboxEntry> {
    return sandboxCreateResponseSchema.parse(
      await this.request("POST", SANDBOX_PATH, {
        payload: { sandbox: { ...(name ? { name } : {}) } },
        signal,
      }),
    );
  }

  async delete(id: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", `${SANDBOX_PATH}/${encodeURIComponent(id)}`, { signal });
  }

  async start(id: string, signal?: AbortSignal): Promise<SandboxEntry> {
    return sandboxEntrySchema.parse(
      await this.request("POST", `${SANDBOX_PATH}/${encodeURIComponent(id)}/start`, {
        payload: { sandbox_id: id },
        signal,
      }),
    );
  }

  async stop(id: string, signal?: AbortSignal): Promise<SandboxEntry> {
    return sandboxEntrySchema.parse(
      await this.request("POST", `${SANDBOX_PATH}/${encodeURIComponent(id)}/stop`, {
        payload: { sandbox_id: id },
        signal,
      }),
    );
  }

  async listKeys(signal?: AbortSignal): Promise<SshKeyEntry[]> {
    const response = sshKeyListSchema.parse(await this.request("GET", SSH_KEYS_PATH, { signal }));
    return response.sshKeys;
  }

  async registerKey(publicKey: string, name: string, signal?: AbortSignal): Promise<SshKeyEntry> {
    return sshKeySchema.parse(
      await this.request("POST", SSH_KEYS_PATH, {
        payload: { public_key: publicKey, name },
        signal,
      }),
    );
  }

  private async request(
    method: RequestMethod,
    path: string,
    options: { query?: Record<string, string>; payload?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const workspaceId = this.client.config.workspaceId;
    const headers = new Headers({ Accept: "application/json" });
    if (workspaceId && workspaceId !== "none") headers.set(ORG_ID_HEADER, workspaceId);
    if (options.payload !== undefined) headers.set("Content-Type", "application/json");
    const startedAt = Date.now();
    const config = this.client.config as typeof this.client.config & {
      authType?: string;
      clientId?: string;
    };
    const requestMetadata = {
      method,
      path,
      host: config.host,
      workspaceId: workspaceId || undefined,
      authType: config.authType || "runtime",
      hasClientId: Boolean(config.clientId),
      queryKeys: options.query ? Object.keys(options.query).sort() : [],
      hasPayload: options.payload !== undefined,
    };
    logger.warn("sandbox REST request", requestMetadata);
    try {
      const response = await this.client.apiClient.request(
        {
          path,
          method,
          headers,
          raw: false,
          ...(options.query ? { query: options.query } : {}),
          ...(options.payload === undefined ? {} : { payload: options.payload }),
        },
        options.signal ? databricks.toContext(options.signal) : undefined,
      );
      logger.warn("sandbox REST response", {
        ...requestMetadata,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      logger.warn("sandbox REST request failed", {
        ...requestMetadata,
        durationMs: Date.now() - startedAt,
        ...errorMetadata(error),
      });
      throw error;
    }
  }
}

/** Returns whether an API error indicates that Sandboxes are unavailable in the workspace. */
export function isSandboxUnavailable(error: unknown): boolean {
  const record = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
    message?: string;
  };
  const status = record?.status ?? record?.statusCode ?? record?.response?.status;
  return (
    status === 404 ||
    status === 503 ||
    /not available in your region|lakebox/i.test(record?.message ?? "")
  );
}

function errorMetadata(error: unknown): Record<string, unknown> {
  const record = object.isRecord(error) ? error : {};
  const response = object.isRecord(record.response) ? record.response : {};
  const body = record.body ?? response.body ?? response.data;
  return {
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : String(error),
    status: record.status ?? record.statusCode ?? response.status,
    statusText: response.statusText,
    errorCode: record.errorCode ?? record.error_code ?? bodyField(body, "error_code"),
    requestId: record.requestId ?? record.request_id ?? bodyField(body, "request_id"),
    responseBody: safeBody(body),
    cause: error instanceof Error && error.cause ? safeBody(error.cause) : undefined,
  };
}

function bodyField(value: unknown, key: string): unknown {
  return object.isRecord(value) ? value[key] : undefined;
}

function safeBody(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value, (key, entry) =>
      /authorization|cookie|secret|token|password|credential|headers|config|request/i.test(key)
        ? "[redacted]"
        : entry,
    );
    return serialized.length > 4_000 ? `${serialized.slice(0, 4_000)}…` : serialized;
  } catch {
    return String(value).slice(0, 4_000);
  }
}
