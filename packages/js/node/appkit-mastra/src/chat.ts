/**
 * Official Mastra AI SDK chat routes for browser-compatible UI streams.
 *
 * @module
 */

import { routes } from "@dbx-tools/shared-mastra";
import { chatRoute } from "@mastra/ai-sdk";

/** Register the official AI SDK chat stream plus its approval continuation. */
export function agentChatRoutes() {
  const path = `${routes.MASTRA_ROUTES.chat}/:agentId` as `${string}:agentId`;
  return [
    chatRoute({
      path,
      sendReasoning: true,
      sendSources: true,
    }),
  ];
}
