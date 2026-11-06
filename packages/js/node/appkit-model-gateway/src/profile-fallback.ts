/**
 * Ordered Databricks profile fallback for rate-limited model requests.
 *
 * @module
 */

import type { WorkspaceClient } from "@databricks/appkit";
import { log } from "@dbx-tools/shared-core";

import { fetchWorkspace } from "./transport.ts";

const logger = log.logger("appkit/model-gateway/profile-fallback");
const GENERIC_RATE_LIMIT_COOLDOWN_MS = 15_000;
const WORKSPACE_TOKEN_COOLDOWN_MS = 60_000;

/** One configured workspace identity in fallback order. */
export interface ModelGatewayProfile {
  readonly profile?: string;
  readonly workspace: string;
  readonly client: WorkspaceClient;
}

/** Parsed upstream rate-limit timing and diagnostic fields. */
export interface ModelGatewayRateLimit {
  readonly retryAfterMs: number;
  readonly source: "header" | "body" | "workspace-token-window" | "default";
  readonly errorCode?: string;
  readonly message?: string;
}

/** Injectable time and transport boundaries for profile-fallback tests. */
export interface ProfileFallbackDependencies {
  readonly now?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
}

/** Process-local ordered profile cooldowns keyed by workspace and model. */
export class ProfileFallback {
  private readonly cooldowns = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(
    readonly profiles: readonly ModelGatewayProfile[],
    dependencies: ProfileFallbackDependencies = {},
  ) {
    if (profiles.length < 2) {
      throw new TypeError("Profile fallback requires at least two profiles");
    }
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? abortableSleep;
    this.fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Primary profile used for discovery and workspace-scoped routing. */
  get primary(): ModelGatewayProfile {
    return this.profiles[0]!;
  }

  /** Execute against the first available profile and cool down HTTP 429 responders. */
  async request(
    model: string,
    signal: AbortSignal,
    send: (profile: ModelGatewayProfile) => Promise<Response>,
  ): Promise<Response> {
    const attempted = new Set<number>();
    let waitedForExistingCooldown = false;
    while (true) {
      const now = this.now();
      const profileIndex = this.availableProfile(model, attempted, now);
      if (profileIndex === undefined) {
        if (attempted.size > 0 || waitedForExistingCooldown) {
          throw new Error("Profile fallback exhausted without an upstream response");
        }
        const delayMs = this.nextCooldownDelay(model, now);
        if (delayMs === undefined) {
          throw new Error("Profile fallback has no available profile");
        }
        waitedForExistingCooldown = true;
        await this.sleep(delayMs, signal);
        continue;
      }

      attempted.add(profileIndex);
      const profile = this.profiles[profileIndex]!;
      const response = await send(profile);
      if (response.status !== 429) {
        this.cooldowns.delete(this.key(profile.workspace, model));
        if (profileIndex > 0) {
          logger.info("model request completed through fallback profile", {
            model,
            profile: profile.profile ?? "default",
            profileIndex,
          });
        }
        return response;
      }

      const rateLimit = await modelGatewayRateLimit(response, this.now());
      this.cooldowns.set(this.key(profile.workspace, model), this.now() + rateLimit.retryAfterMs);
      logger.warn("model profile rate limited", {
        errorCode: rateLimit.errorCode,
        message: rateLimit.message,
        model,
        profile: profile.profile ?? "default",
        profileIndex,
        retryAfterMs: rateLimit.retryAfterMs,
        retryAfterSource: rateLimit.source,
        workspace: profile.workspace,
      });

      if (this.availableProfile(model, attempted, this.now()) === undefined) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
    }
  }

  /** Build an AI SDK fetch that replays a request through the ordered profile pool. */
  createFetch(model: string): typeof globalThis.fetch {
    return (async (input, init) => {
      const request = new Request(input, init);
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      const originalUrl = new URL(request.url);
      const originalHeaders = new Headers(request.headers);
      return this.request(model, request.signal, async ({ client, workspace }) => {
        const url = new URL(`${originalUrl.pathname}${originalUrl.search}`, workspace);
        return fetchWorkspace(
          client,
          url,
          {
            method: request.method,
            headers: originalHeaders,
            body,
            signal: request.signal,
          },
          this.fetcher,
        );
      });
    }) as typeof globalThis.fetch;
  }

  private availableProfile(
    model: string,
    attempted: ReadonlySet<number>,
    now: number,
  ): number | undefined {
    for (let index = 0; index < this.profiles.length; index += 1) {
      if (attempted.has(index)) continue;
      const workspace = this.profiles[index]!.workspace;
      if ((this.cooldowns.get(this.key(workspace, model)) ?? 0) <= now) return index;
    }
    return undefined;
  }

  private nextCooldownDelay(model: string, now: number): number | undefined {
    const cooldowns = this.profiles
      .map((profile) => this.cooldowns.get(this.key(profile.workspace, model)))
      .filter((until): until is number => until !== undefined && until > now);
    if (cooldowns.length === 0) return undefined;
    return Math.max(0, Math.min(...cooldowns) - now);
  }

  private key(workspace: string, model: string): string {
    return `${normalizeWorkspace(workspace)}\0${model}`;
  }
}

function normalizeWorkspace(workspace: string): string {
  const url = new URL(workspace);
  return url.origin.toLowerCase();
}

/** Parse HTTP and Databricks JSON retry timing for a 429 response. */
export async function modelGatewayRateLimit(
  response: Response,
  now = Date.now(),
): Promise<ModelGatewayRateLimit> {
  const headerDelay = retryAfterHeaderMs(response.headers.get("retry-after"), now);
  const body = await response
    .clone()
    .json()
    .catch(() => undefined);
  const details = rateLimitBody(body);
  if (headerDelay !== undefined) {
    return { ...details, retryAfterMs: headerDelay, source: "header" };
  }
  if (details.retryAfterMs !== undefined) {
    return { ...details, retryAfterMs: details.retryAfterMs, source: "body" };
  }
  if (isWorkspaceTokenRateLimit(details.message)) {
    return {
      ...details,
      retryAfterMs: WORKSPACE_TOKEN_COOLDOWN_MS,
      source: "workspace-token-window",
    };
  }
  return {
    ...details,
    retryAfterMs: GENERIC_RATE_LIMIT_COOLDOWN_MS,
    source: "default",
  };
}

function rateLimitBody(value: unknown): {
  readonly retryAfterMs?: number;
  readonly errorCode?: string;
  readonly message?: string;
} {
  const root = record(value);
  const error = record(root?.error) ?? root;
  const retryAfter = integer(error?.retry_after ?? root?.retry_after);
  const errorCode = text(error?.error_code ?? root?.error_code);
  const message =
    text(error?.message ?? root?.message) ??
    (typeof root?.error === "string" ? text(root.error) : undefined);
  return {
    ...(retryAfter !== undefined ? { retryAfterMs: retryAfter * 1_000 } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(message ? { message } : {}),
  };
}

function retryAfterHeaderMs(value: string | null, now: number): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function isWorkspaceTokenRateLimit(message: string | undefined): boolean {
  return (
    message !== undefined && /exceeded workspace .*tokens per minute rate limit/i.test(message)
  );
}

function integer(value: unknown): number | undefined {
  const normalized = typeof value === "string" ? value.trim().replaceAll(",", "") : value;
  const parsed = typeof normalized === "number" ? normalized : Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(finish, delayMs);
    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timeout);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
