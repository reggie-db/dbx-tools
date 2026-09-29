import { getToolOrDynamicToolName, isToolOrDynamicToolUIPart, type UIMessage } from "ai";
import type { ToolEvent } from "../react/types.ts";

/** Project native AI SDK tool parts from persisted messages onto pill state. */
export function toolEventsFromParts(parts: UIMessage["parts"]): ToolEvent[] {
  return parts.filter(isToolOrDynamicToolUIPart).map((part) => {
    const error = part.state === "output-error";
    const done = part.state === "output-available";
    return {
      id: part.toolCallId,
      toolName: getToolOrDynamicToolName(part),
      status: error ? "error" : done ? "done" : "running",
      input: part.input,
      ...(done ? { output: part.output } : error ? { output: { error: part.errorText } } : {}),
    };
  });
}

/** Merge persisted native parts with richer live progress by tool-call id. */
export function mergeToolEvents(
  persisted: ToolEvent[],
  live: ToolEvent[] | undefined,
): ToolEvent[] {
  const merged = new Map(persisted.map((event) => [event.id, event]));
  for (const event of live ?? []) {
    const prior = merged.get(event.id);
    merged.set(event.id, prior ? { ...prior, ...event } : event);
  }
  return [...merged.values()];
}
