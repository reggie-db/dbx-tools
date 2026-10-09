/**
 * Official Mastra AI SDK chat routes for browser-compatible UI streams.
 *
 * @module
 */

import { errorUtils, log } from "@dbx-tools/shared-core";
import { routes } from "@dbx-tools/shared-mastra";
import {
  isStaleMastraResumeError,
  STALE_MASTRA_RESUME_STREAM_TEXT,
} from "@dbx-tools/shared-mastra/resume";
import { chatRoute } from "@mastra/ai-sdk";

const logger = log.logger("mastra/chat");

/** Register the official AI SDK chat stream plus its approval continuation. */
export function agentChatRoutes() {
  const path = `${routes.MASTRA_ROUTES.chat}/:agentId` as `${string}:agentId`;
  return [
    chatRoute({
      path,
      sendReasoning: true,
      sendSources: true,
      onError: serializeChatStreamError,
    }),
  ];
}

/**
 * Keep a late or duplicate resume from failing the UI stream. Mastra's
 * `chatRoute` already swallows a couple of resume ids on the v6 approval
 * path; this covers the generic workflow errors `consumeStream` still
 * surfaces on v5.
 */
function serializeChatStreamError(error: unknown): string {
  if (isStaleMastraResumeError(error)) {
    logger.warn("ignored stale mastra resume", {
      error: errorUtils.errorMessage(error),
    });
    return STALE_MASTRA_RESUME_STREAM_TEXT;
  }
  return errorUtils.errorMessage(error);
}
