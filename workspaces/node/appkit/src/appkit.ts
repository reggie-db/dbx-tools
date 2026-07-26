/**
 * Generic AppKit runtime glue: the per-request execution context and the types
 * derived from it. Not plugin-specific - that lives in `./plugin`.
 *
 * `getExecutionContext()` is AppKit's own accessor for the OBO-scoped workspace
 * client + request metadata; the wrappers here make it safe to call outside a
 * request scope ({@link tryGetExecutionContext}) and to lazily boot a bare app
 * ({@link ensureInitialized}), and re-export the derived types so add-on
 * packages can type a context / client without re-deriving them inline.
 *
 * @module
 */

import { createApp, getExecutionContext, InitializationError } from "@databricks/appkit";
import { log } from "@dbx-tools/shared-core";

const logger = log.logger("appkit");

/**
 * The AppKit per-request execution context returned by `getExecutionContext()`
 * - the OBO-scoped workspace client plus the surrounding request metadata.
 * Derived from AppKit's own return type so it tracks the installed version, and
 * re-exported here so add-on packages can type a context parameter without each
 * re-deriving the same `ReturnType<typeof getExecutionContext>` inline.
 */
export type ExecutionContextLike = ReturnType<typeof getExecutionContext>;

/**
 * The auth-scoped Databricks workspace client carried on an
 * `ExecutionContextLike` (`getExecutionContext().client`). Typed structurally
 * off AppKit so consumers don't take a direct `@databricks/sdk-experimental`
 * dependency - the dep flows in transitively through `@databricks/appkit`.
 */
export type WorkspaceClientLike = ExecutionContextLike["client"];

/**
 * The current AppKit execution context, or `undefined` when AppKit isn't
 * initialized (outside a request scope). Swallows AppKit's
 * {@link InitializationError}; any other error propagates.
 *
 * @example
 * import { appkit } from "@dbx-tools/appkit";
 * import { WorkspaceClient } from "@databricks/sdk-experimental";
 *
 * // OBO-scoped inside a request, service principal from a CLI or script.
 * const client = appkit.tryGetExecutionContext()?.client ?? new WorkspaceClient({});
 */
export function tryGetExecutionContext(): ExecutionContextLike | undefined {
  try {
    const ctx = getExecutionContext();
    if (ctx?.client) {
      return ctx;
    }
  } catch (error) {
    if (!(error instanceof InitializationError)) {
      throw error;
    }
  }
  return undefined;
}

/**
 * Initialize a bare AppKit app (no plugins) when none is running yet.
 *
 * @example
 * import { appkit } from "@dbx-tools/appkit";
 *
 * await appkit.ensureInitialized();
 * const client = appkit.tryGetExecutionContext()?.client;
 */
export async function ensureInitialized(): Promise<void> {
  if (!tryGetExecutionContext()) {
    logger.debug("initializing a bare AppKit app");
    await createApp({ plugins: [] });
  }
}
