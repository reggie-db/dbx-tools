import { convertMessages } from "@mastra/core/agent/message-list";
import type { ListMemoryThreadMessagesResponse } from "@mastra/client-js";
import type { UIMessage } from "ai";

/** Convert a newest-first native memory page to chronological AI SDK UI messages. */
export function toChronologicalUiMessages(response: ListMemoryThreadMessagesResponse): UIMessage[] {
  if (response.uiMessages) {
    return [...response.uiMessages].reverse() as UIMessage[];
  }
  return convertMessages(response.messages).to("AIV5.UI") as UIMessage[];
}
