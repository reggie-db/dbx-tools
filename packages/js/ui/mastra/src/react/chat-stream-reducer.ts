import { error as sharedError } from "@dbx-tools/shared-core";
import { GenieWriterEventSchema, type MastraStreamChunk } from "@dbx-tools/shared-mastra";
import type { UIMessage } from "ai";
import type { PendingApproval, ToolEvent } from "./types.ts";

/** Pure accumulated state for one assistant response stream. */
export type ChatStreamState = {
  textSegments: string[];
  reasoning: string;
  toolEvents: ToolEvent[];
  pendingApprovals: PendingApproval[];
  runId: string | null;
  streaming: boolean;
};

/** Session fields changed by one stream reduction. */
export type ChatStreamChanges = {
  runId: boolean;
  status: boolean;
  toolEvents: boolean;
  pendingApprovals: boolean;
};

/** Result of reducing one validated stream chunk. */
export type ChatStreamReduction = {
  state: ChatStreamState;
  changes: ChatStreamChanges;
  assistantChanged: boolean;
  error?: string;
};

/** Seed pure stream state from an existing assistant message and session data. */
export function createChatStreamState(options: {
  existing?: UIMessage;
  pendingApprovals: PendingApproval[];
  runId: string | null;
  toolEvents: ToolEvent[];
}): ChatStreamState {
  const textSegments: string[] = [];
  let reasoning = "";
  for (const part of options.existing?.parts ?? []) {
    if (part.type === "text") textSegments.push(part.text);
    else if (part.type === "reasoning") reasoning += (part as { text?: string }).text ?? "";
  }
  return {
    textSegments,
    reasoning,
    toolEvents: options.toolEvents,
    pendingApprovals: options.pendingApprovals,
    runId: options.runId,
    streaming: false,
  };
}

/** Materialize the assistant message represented by accumulated stream state. */
export function chatStreamAssistantMessage(assistantId: string, state: ChatStreamState): UIMessage {
  const parts: UIMessage["parts"] = [];
  if (state.reasoning) parts.push({ type: "reasoning", text: state.reasoning });
  for (const segment of state.textSegments) {
    if (segment.length > 0) parts.push({ type: "text", text: segment });
  }
  return {
    id: assistantId,
    role: "assistant",
    parts: parts.length > 0 ? parts : [{ type: "text", text: "" }],
  };
}

const withRunId = (
  state: ChatStreamState,
  chunk: MastraStreamChunk,
): { state: ChatStreamState; changed: boolean } => {
  if (!chunk.runId || state.runId) return { state, changed: false };
  return { state: { ...state, runId: chunk.runId }, changed: true };
};

const reduction = (
  state: ChatStreamState,
  options: {
    runIdChanged: boolean;
    assistantChanged?: boolean;
    statusChanged?: boolean;
    toolEventsChanged?: boolean;
    pendingApprovalsChanged?: boolean;
    error?: string;
  },
): ChatStreamReduction => ({
  state,
  changes: {
    runId: options.runIdChanged,
    status: options.statusChanged ?? false,
    toolEvents: options.toolEventsChanged ?? false,
    pendingApprovals: options.pendingApprovalsChanged ?? false,
  },
  assistantChanged: options.assistantChanged ?? false,
  ...(options.error ? { error: options.error } : {}),
});

/** Reduce one validated chunk into immutable assistant and session state. */
export function reduceChatStreamChunk(
  previous: ChatStreamState,
  chunk: MastraStreamChunk,
): ChatStreamReduction {
  const run = withRunId(previous, chunk);
  const state = run.state;
  const markStreaming = !state.streaming;

  switch (chunk.type) {
    case "unknown":
    case "text-start":
    case "text-end":
      return reduction(state, { runIdChanged: run.changed });

    case "text-delta": {
      const textSegments = state.textSegments.length > 0 ? [...state.textSegments] : [""];
      textSegments[textSegments.length - 1] += chunk.payload.text;
      return reduction(
        { ...state, textSegments, streaming: true },
        {
          runIdChanged: run.changed,
          assistantChanged: true,
          statusChanged: markStreaming,
        },
      );
    }

    case "reasoning-delta":
      return reduction(
        {
          ...state,
          reasoning: state.reasoning + chunk.payload.text,
          streaming: true,
        },
        {
          runIdChanged: run.changed,
          assistantChanged: true,
          statusChanged: markStreaming,
        },
      );

    case "tool-call":
      return reduction(
        {
          ...state,
          streaming: true,
          toolEvents: [
            ...state.toolEvents,
            {
              id: chunk.payload.toolCallId,
              toolName: chunk.payload.toolName,
              status: "running",
            },
          ],
        },
        {
          runIdChanged: run.changed,
          assistantChanged: true,
          statusChanged: markStreaming,
          toolEventsChanged: true,
        },
      );

    case "tool-call-approval": {
      const approvalRunId = chunk.runId ?? chunk.payload.runId ?? state.runId;
      if (!approvalRunId) {
        return reduction(state, { runIdChanged: run.changed });
      }
      const approval: PendingApproval = {
        toolName: chunk.payload.toolName,
        toolCallId: chunk.payload.toolCallId,
        runId: approvalRunId,
        input: chunk.payload.args,
      };
      const exists = state.pendingApprovals.some(
        (current) => current.toolCallId === approval.toolCallId,
      );
      return reduction(
        {
          ...state,
          streaming: true,
          pendingApprovals: exists ? state.pendingApprovals : [...state.pendingApprovals, approval],
        },
        {
          runIdChanged: run.changed,
          assistantChanged: true,
          statusChanged: markStreaming,
          pendingApprovalsChanged: !exists,
        },
      );
    }

    case "tool-result":
    case "tool-error":
      return reduction(
        {
          ...state,
          toolEvents: state.toolEvents.map((event) =>
            event.id === chunk.payload.toolCallId
              ? { ...event, status: chunk.type === "tool-result" ? "done" : "error" }
              : event,
          ),
        },
        {
          runIdChanged: run.changed,
          toolEventsChanged: true,
        },
      );

    case "tool-output": {
      const progress = GenieWriterEventSchema.safeParse(chunk.payload.output);
      if (!progress.success) return reduction(state, { runIdChanged: run.changed });
      return reduction(
        {
          ...state,
          toolEvents: state.toolEvents.map((event) =>
            event.id === chunk.payload.toolCallId
              ? { ...event, progress: [...(event.progress ?? []), progress.data] }
              : event,
          ),
        },
        {
          runIdChanged: run.changed,
          toolEventsChanged: true,
        },
      );
    }

    case "error": {
      const detail = chunk.payload?.error ?? chunk.payload?.message;
      return reduction(state, {
        runIdChanged: run.changed,
        error: detail
          ? sharedError.errorMessage(detail)
          : "The assistant stream reported an error.",
      });
    }

    default: {
      const exhaustive: never = chunk;
      return exhaustive;
    }
  }
}
