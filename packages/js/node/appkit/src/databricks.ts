/**
 * Databricks SDK glue for AppKit: create workspace clients backed by the
 * `@dbx-tools/auth` credential lifecycle and adapt WHATWG cancellation
 * (`AbortSignal` / `AbortController`) into the SDK's `Context` /
 * `CancellationToken` shapes so a single `AbortController` can drive every
 * in-flight SDK call.
 *
 * Server-only: leans on the Databricks SDK `Context`. Lives in node-appkit so
 * the browser-safe shared-core stays SDK-free.
 *
 * @module
 */

import {
  createWorkspaceClient as createAppKitWorkspaceClient,
  type WorkspaceClient,
} from "@databricks/appkit";
import type { CancellationToken } from "@databricks/sdk-experimental";
import { Context } from "@databricks/sdk-experimental";
import {
  type AuthClient,
  type DatabricksAuthOptions,
  createAuthClient,
} from "@dbx-tools/auth";
import { tieAbortSignal } from "@dbx-tools/shared-core";

const workspaceAuth = new WeakMap<WorkspaceClient, AuthClient>();

/**
 * Create an AppKit workspace client whose SDK credential visitor delegates to
 * `@dbx-tools/auth`.
 *
 * Auth resolves the selected profile, host, token lifecycle, interactive CLI
 * login, and unified-workspace header. The AppKit/Databricks SDK client remains
 * the owner of workspace APIs and request execution.
 */
export async function createWorkspaceClient(
  options: DatabricksAuthOptions = {},
): Promise<WorkspaceClient> {
  const auth = await createAuthClient(options);
  const client = createAppKitWorkspaceClient({ host: auth.host });
  client.config.credentials = {
    name: "pat",
    async configure() {
      return async (headers) => {
        for (const [name, value] of Object.entries(await auth.headers())) {
          headers.set(name, value);
        }
      };
    },
  };
  workspaceAuth.set(client, auth);
  return client;
}

/**
 * Refresh the dbx-tools credential lifecycle attached by
 * {@link createWorkspaceClient}. Returns `false` for clients whose credential
 * owner is external.
 */
export async function refreshWorkspaceClientAuthentication(
  client: WorkspaceClient,
): Promise<boolean> {
  const auth = workspaceAuth.get(client);
  if (!auth) return false;
  await auth.headers({ login: false, refresh: true });
  return true;
}

/** Either an SDK `Context` or a WHATWG `AbortSignal`. */
export type ContextLike = Context | AbortSignal;

/**
 * Wrap a `Context` (returned as-is) or `AbortSignal` (adapted) as an SDK `Context`.
 *
 * @example
 * import { databricks } from "@dbx-tools/appkit";
 * import { getWorkspaceClient } from "@databricks/appkit";
 *
 * await getWorkspaceClient({}).apiClient.request(
 *   { path: "/api/2.0/serving-endpoints", method: "GET", headers: new Headers(), raw: false },
 *   databricks.toContext(request.signal),
 * );
 */
export function toContext(input: ContextLike): Context;
/**
 * Derive an SDK `Context` from `controller.signal`, optionally tying `input`
 * into the controller so the controller becomes the single cancellation
 * source for downstream SDK calls:
 *
 *   - `AbortSignal`: aborting it propagates into `controller` (and from there
 *     into every SDK call you pass the returned context to).
 *   - `Context`: its `cancellationToken` is tied into `controller`, and its
 *     other fields (`logger`, `opName`, `rootClassName`, `rootFnName`, `opId`)
 *     are preserved in the returned `Context`. The returned context's
 *     `cancellationToken` is replaced with one backed by `controller.signal`.
 *
 * The tie is one-way (parent -> child): aborting `controller` directly does
 * NOT cancel `input`. So a request-level cancel (your loop's `try/finally {
 * controller.abort() }`) won't tear down a caller-supplied AbortSignal it
 * didn't own.
 */
export function toContext(controller: AbortController, input?: ContextLike): Context;
export function toContext(source: AbortController | ContextLike, input?: ContextLike): Context {
  if (!(source instanceof AbortController)) {
    if (source instanceof Context) return source;
    return new Context({ cancellationToken: signalToCancellationToken(source) });
  }
  if (input instanceof AbortSignal) {
    tieAbortSignal(source, input);
  } else if (input instanceof Context) {
    const token = input.cancellationToken;
    if (token) tieCancellationToken(source, token);
    const merged = input.copy();
    merged.setItems({ cancellationToken: signalToCancellationToken(source.signal) });
    return merged;
  }
  return new Context({ cancellationToken: signalToCancellationToken(source.signal) });
}

/**
 * Adapt a WHATWG `AbortSignal` to the Databricks SDK's `CancellationToken`
 * interface. The SDK's `api-client.ts` internally creates an `AbortController`
 * and wires `cancellationToken.onCancellationRequested` to it, so this adapter
 * is the one-line bridge from "platform-standard cancellation" to "the SDK
 * aborts the fetch on your behalf".
 */
function signalToCancellationToken(signal: AbortSignal): CancellationToken {
  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested(cb) {
      if (signal.aborted) {
        cb(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => cb(signal.reason), { once: true });
    },
  };
}

/**
 * Tie the SDK's `CancellationToken` interface back into an `AbortController`.
 * Mirrors `async.tieAbortSignal` but for the SDK's cancellation shape, used
 * when a caller hands us a pre-built `Context` whose token we want to fold into
 * our own controller.
 */
function tieCancellationToken(controller: AbortController, token: CancellationToken): void {
  if (token.isCancellationRequested) {
    controller.abort();
    return;
  }
  token.onCancellationRequested((reason) => controller.abort(reason));
}
