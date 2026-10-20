/**
 * Optional Mastra output-processor attachment.
 *
 * Loaded only when the memory plugin finds a registered Mastra sibling.
 *
 * @module
 */

import { type PluginContextLike, instance } from "@dbx-tools/appkit";
import { log, toError, isRecord } from "@dbx-tools/shared-core";

import type { MemoryTurn } from "./_contracts.ts";

const logger = log.logger("memory/mastra");

interface MemoryMessage {
  readonly role: string;
  readonly content: { readonly parts: readonly unknown[] };
}

/** Attach a memory-owned turn saver through Mastra's generic processor extension. */
export async function attachMastraTurnSaver(
  context: PluginContextLike,
  saveTurn: (turn: MemoryTurn, signal?: AbortSignal) => Promise<void>,
): Promise<boolean> {
  const mastraModule = await import("@dbx-tools/appkit-mastra");
  const plugin = instance(context, mastraModule.mastra);
  if (!plugin) return false;
  plugin.exports().registerOutputProcessor((agentId) => ({
    id: `appkit_memory_${agentId}`,
    name: "AppKit memory turn saver",
    description: "Saves completed turns to the configured fallback memory backend.",
    processOutputResult: async ({ messageList, requestContext, abortSignal }) => {
      const scope = mastraModule.memory.requestMemoryScope(requestContext);
      if (!scope) return messageList;
      const actorId = typeof scope.resource === "string" ? scope.resource : undefined;
      const threadId = typeof scope.thread === "string" ? scope.thread : undefined;
      if (!actorId || !threadId) return messageList;
      const user = latestText(messageList.get.input.db(), "user");
      const assistant = latestText(messageList.get.response.db(), "assistant");
      if (!user || !assistant) return messageList;
      try {
        await saveTurn(
          {
            agentId,
            actorId,
            threadId,
            user,
            assistant,
          },
          abortSignal,
        );
      } catch (error) {
        logger.warn("turn save failed", { error: toError(error), agentId });
      }
      return messageList;
    },
  }));
  return true;
}

function latestText(
  messages: readonly MemoryMessage[],
  role: "user" | "assistant",
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== role) continue;
    const text = message.content.parts
      .flatMap((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
      )
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}
