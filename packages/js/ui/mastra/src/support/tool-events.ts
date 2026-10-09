import {
  GENIE_PROGRESS_PART_TYPE,
  GenieProgressPartDataSchema,
  TOOL_PROGRESS_PART_TYPE,
  ToolProgressPartDataSchema,
} from "@dbx-tools/shared-mastra/wire";
import { getToolOrDynamicToolName, isToolOrDynamicToolUIPart, type UIMessage } from "ai";
import type { ToolEvent } from "../react/types.ts";

/** Collapse one reasoning event into a compact paragraph. */
export function compactReasoningText(text: string): string {
  return stripMarkdownTables(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Collect Genie `thinking` events for the assistant Thoughts panel.
 *
 * Intermediate `text` attachments stay out: Agent Mode often puts query
 * result tables there, and those belong in tool progress / the final answer,
 * not in reasoning.
 */
export function genieReasoningText(events: ToolEvent[]): string {
  const sections: string[] = [];
  for (const event of events) {
    for (const progress of event.progress ?? []) {
      if (progress.type !== "thinking") continue;
      const text = compactReasoningText(progress.text);
      if (text) sections.push(text);
    }
  }
  return sections.join("\n\n");
}

/** Drop markdown table rows so query samples never land in Thoughts. */
function stripMarkdownTables(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*\|/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Project native AI SDK tool parts from persisted messages onto pill state. */
export function toolEventsFromParts(parts: UIMessage["parts"]): ToolEvent[] {
  const events = parts.filter(isToolOrDynamicToolUIPart).map<ToolEvent>((part) => {
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
  const byId = new Map(events.map((event) => [event.id, event]));
  for (const part of parts) {
    const progress =
      part.type === GENIE_PROGRESS_PART_TYPE
        ? GenieProgressPartDataSchema.safeParse(part.data)
        : part.type === TOOL_PROGRESS_PART_TYPE
          ? ToolProgressPartDataSchema.safeParse(part.data)
          : undefined;
    if (!progress) continue;
    if (!progress.success) continue;
    const event = byId.get(progress.data.toolCallId);
    if (!event) continue;
    event.progress = [...(event.progress ?? []), progress.data.event];
  }
  return events;
}

/** Merge persisted native parts with richer live progress by tool-call id. */
export function mergeToolEvents(
  persisted: ToolEvent[],
  live: ToolEvent[] | undefined,
  terminalError = false,
): ToolEvent[] {
  const merged = new Map(persisted.map((event) => [event.id, event]));
  for (const event of live ?? []) {
    const prior = merged.get(event.id);
    merged.set(event.id, prior ? { ...prior, ...event } : event);
  }
  const events = [...merged.values()];
  if (!terminalError) return events;
  return events.map((event) =>
    event.status === "running"
      ? {
          ...event,
          status: "error",
          output: { error: "The assistant stream ended before this tool returned." },
        }
      : event,
  );
}
