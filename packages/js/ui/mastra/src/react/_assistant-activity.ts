import { isToolUIPart, type UIMessage } from "ai";

import type { ToolEvent } from "./types.ts";
import { compactReasoningText } from "../support/tool-events.ts";

/** One ordered activity entry rendered before an assistant's answer text. */
export type AssistantActivityItem =
  { type: "tool"; key: string; event: ToolEvent } | { type: "thought"; key: string; text: string };

/** Preserve model reasoning and tool progress in the order they reached the message. */
export const assistantActivityItems = (
  parts: UIMessage["parts"],
  events: ToolEvent[],
): AssistantActivityItem[] => {
  const eventById = new Map(events.map((event) => [event.id, event]));
  const renderedEventIds = new Set<string>();
  const items: AssistantActivityItem[] = [];

  const appendTool = (event: ToolEvent) => {
    if (renderedEventIds.has(event.id)) return;
    renderedEventIds.add(event.id);
    items.push({ type: "tool", key: `tool-${event.id}`, event });
    for (const [index, progress] of (event.progress ?? []).entries()) {
      if (progress.type !== "thinking") continue;
      const text = compactReasoningText(progress.text);
      if (text) items.push({ type: "thought", key: `thought-${event.id}-${index}`, text });
    }
  };

  for (const [index, part] of parts.entries()) {
    if (part.type === "reasoning") {
      const text = compactReasoningText(part.text);
      if (text) items.push({ type: "thought", key: `reasoning-${index}`, text });
      continue;
    }
    if (!isToolUIPart(part)) continue;
    const event = eventById.get(part.toolCallId);
    if (event) appendTool(event);
  }

  for (const event of events) appendTool(event);
  return items;
};
