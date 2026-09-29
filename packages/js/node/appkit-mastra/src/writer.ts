/**
 * Shared helper for publishing Genie progress through Mastra's native
 * `ctx.writer.custom()` data-part surface.
 *
 * Failures are logged at `warn` (a persistently-closed writer is
 * the most likely culprit when events go missing client-side) but
 * swallowed so a cancelled request or a client that navigated
 * away can't crash a tool mid-flight.
 *
 * @module
 */

import { error, log } from "@dbx-tools/shared-core";
import { GENIE_PROGRESS_PART_TYPE, type GenieWriterEvent } from "@dbx-tools/shared-mastra";
import type { ToolExecutionContext } from "@mastra/core/tools";

/**
 * Best-effort native custom progress write. No-op when the writer or owning
 * tool call id is unavailable;
 * caught errors are logged via `log.warn("writer:error", ...)`
 * along with any caller-supplied `context` fields (e.g. a
 * `chartId` or `messageId`) so the warning is greppable per
 * resource.
 *
 * Returns when the write resolves or rejects; never throws.
 */
export async function safeWriteProgress(
  log: log.Logger,
  writer: ToolExecutionContext["writer"],
  toolCallId: string | undefined,
  event: GenieWriterEvent,
  context: Record<string, unknown> = {},
): Promise<void> {
  if (!writer || !toolCallId) {
    log.debug("writer:no-writer", context);
    return;
  }
  try {
    await writer.custom({
      type: GENIE_PROGRESS_PART_TYPE,
      data: { toolCallId, event },
    });
    log.debug("writer:ok", context);
  } catch (err) {
    log.warn("writer:error", {
      ...context,
      error: error.errorMessage(err),
    });
  }
}
