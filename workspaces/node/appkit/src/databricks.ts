/**
 * Generic Databricks SDK glue (no AppKit): adapt WHATWG cancellation
 * (`AbortSignal` / `AbortController`) into the SDK's `Context` /
 * `CancellationToken` shapes so a single `AbortController` can drive every
 * in-flight SDK call, plus Databricks runtime-environment detection.
 *
 * Server-only: leans on the Databricks SDK `Context`. Lives in node-appkit so
 * the browser-safe shared-core stays SDK-free.
 */

import { async } from "@dbx-tools/shared-core";
import type { CancellationToken } from "@databricks/sdk-experimental";
import { Context } from "@databricks/sdk-experimental";

/**
 * Detect the Databricks App runtime from environment shape: requires a
 * non-empty `DATABRICKS_APP_NAME`, a `DATABRICKS_HOST` that parses as an
 * `http`/`https` URL, and a `DATABRICKS_APP_PORT` that is a valid TCP port.
 * Reads `process.env` when no `env` is passed.
 */
export function isAppEnv(env: Record<string, string | undefined> = process.env): boolean {
  const appName = env.DATABRICKS_APP_NAME?.trim();
  const host = env.DATABRICKS_HOST?.trim();
  const port = env.DATABRICKS_APP_PORT?.trim();

  if (!appName || !host || !port) {
    return false;
  }

  try {
    const url = new URL(host);
    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }
  } catch {
    return false;
  }

  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return false;
  }

  return true;
}

/** Either an SDK `Context` or a WHATWG `AbortSignal`. */
export type ContextLike = Context | AbortSignal;

/** Wrap a `Context` (returned as-is) or `AbortSignal` (adapted) as an SDK `Context`. */
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
    async.tieAbortSignal(source, input);
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
