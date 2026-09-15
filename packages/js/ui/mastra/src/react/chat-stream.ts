import { log } from "@dbx-tools/shared-core";
import { feedback } from "@dbx-tools/shared-mastra";
import type { UIMessage } from "ai";
import { useCallback } from "react";
import type { MastraStreamResponse } from "../support/mastra-stream.ts";
import type {
  ThreadMessageWriter,
  ThreadSessionReader,
  ThreadSessionUpdater,
} from "./chat-sessions.ts";
import type { ToolEvent, ToolProgress } from "./types.ts";

const logger = log.logger("ui-mastra/chat");

/** Read the MLflow trace id captured by the server on a stream response. */
const readMlflowTraceId = (stream: unknown): string | undefined => {
  const headers = (stream as { headers?: { get?: (name: string) => string | null } })?.headers;
  return headers?.get?.(feedback.MLFLOW_TRACE_ID_HEADER)?.trim() || undefined;
};

/** Narrow tool writer output to the progress envelope rendered by the UI. */
const isToolProgress = (value: unknown): value is ToolProgress =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

class StreamAborted extends Error {}

interface UseChatStreamOptions {
  getSession: ThreadSessionReader;
  updateSession: ThreadSessionUpdater;
  writeMessages: ThreadMessageWriter;
}

/** Translate one Mastra data stream into thread messages and tool state. */
export function useChatStream({ getSession, updateSession, writeMessages }: UseChatStreamOptions) {
  return useCallback(
    async (
      threadId: string,
      stream: MastraStreamResponse,
      assistantId: string,
      runIdRef: { current: string | null },
      signal: AbortSignal,
    ) => {
      const traceId = readMlflowTraceId(stream);
      if (traceId) {
        updateSession(threadId, (session) =>
          session.feedbackByMessage[assistantId]?.traceId === traceId
            ? session
            : {
                ...session,
                feedbackByMessage: {
                  ...session.feedbackByMessage,
                  [assistantId]: {
                    ...session.feedbackByMessage[assistantId],
                    traceId,
                  },
                },
              },
        );
      }
      const existing = getSession(threadId).messages.find((message) => message.id === assistantId);
      const textSegments: string[] = [];
      let assistantReasoning = "";
      if (existing) {
        for (const part of existing.parts) {
          if (part.type === "text") {
            textSegments.push(part.text);
          } else if (part.type === "reasoning") {
            assistantReasoning += (part as { text?: string }).text ?? "";
          }
        }
      }
      const appendText = (delta: string) => {
        if (textSegments.length === 0) textSegments.push("");
        textSegments[textSegments.length - 1] += delta;
      };

      const upsertAssistant = () => {
        const next = [...getSession(threadId).messages];
        const index = next.findIndex((message) => message.id === assistantId);
        const parts: UIMessage["parts"] = [];
        if (assistantReasoning) parts.push({ type: "reasoning", text: assistantReasoning });
        for (const segment of textSegments) {
          if (segment.length > 0) parts.push({ type: "text", text: segment });
        }
        const message: UIMessage = {
          id: assistantId,
          role: "assistant",
          parts: parts.length > 0 ? parts : [{ type: "text", text: "" }],
        };
        if (index === -1) next.push(message);
        else next[index] = message;
        writeMessages(threadId, next);
      };

      const patchToolEvents = (update: (list: ToolEvent[]) => ToolEvent[]) => {
        updateSession(threadId, (session) => ({
          ...session,
          toolEventsByMessage: {
            ...session.toolEventsByMessage,
            [assistantId]: update(session.toolEventsByMessage[assistantId] ?? []),
          },
        }));
      };

      let started = false;
      const markStreaming = () => {
        if (started) return;
        started = true;
        updateSession(threadId, (session) =>
          session.status === "streaming" ? session : { ...session, status: "streaming" },
        );
      };

      try {
        await stream.processDataStream({
          onChunk: async (chunk: { type: string; payload?: any; runId?: string }) => {
            if (signal.aborted) throw new StreamAborted();
            if (chunk.runId && !runIdRef.current) {
              runIdRef.current = chunk.runId;
              updateSession(threadId, (session) => ({ ...session, runId: chunk.runId! }));
            }
            switch (chunk.type) {
              case "text-start":
                textSegments.push("");
                break;
              case "text-delta":
                appendText(chunk.payload?.text ?? "");
                upsertAssistant();
                markStreaming();
                break;
              case "text-end":
                break;
              case "reasoning-delta":
                assistantReasoning += chunk.payload?.text ?? "";
                upsertAssistant();
                markStreaming();
                break;
              case "tool-call": {
                const { toolCallId, toolName } = chunk.payload ?? {};
                if (typeof toolCallId !== "string") break;
                patchToolEvents((list) => [
                  ...list,
                  { id: toolCallId, toolName, status: "running" },
                ]);
                upsertAssistant();
                markStreaming();
                break;
              }
              case "tool-call-approval": {
                const { toolCallId, toolName, args } = chunk.payload ?? {};
                const approvalRunId = chunk.runId ?? runIdRef.current;
                if (
                  typeof toolCallId !== "string" ||
                  typeof toolName !== "string" ||
                  !approvalRunId
                ) {
                  logger.warn("malformed tool-call-approval chunk", {
                    toolCallId,
                    toolName,
                    hasRunId: Boolean(approvalRunId),
                  });
                  break;
                }
                updateSession(threadId, (session) => {
                  const existingApprovals = session.pendingApprovalsByMessage[assistantId] ?? [];
                  if (existingApprovals.some((approval) => approval.toolCallId === toolCallId)) {
                    return session;
                  }
                  return {
                    ...session,
                    pendingApprovalsByMessage: {
                      ...session.pendingApprovalsByMessage,
                      [assistantId]: [
                        ...existingApprovals,
                        {
                          toolName,
                          toolCallId,
                          runId: approvalRunId,
                          input: args,
                        },
                      ],
                    },
                  };
                });
                upsertAssistant();
                markStreaming();
                break;
              }
              case "tool-result": {
                const toolCallId = chunk.payload?.toolCallId;
                if (typeof toolCallId !== "string") break;
                patchToolEvents((list) =>
                  list.map((event) =>
                    event.id === toolCallId ? { ...event, status: "done" } : event,
                  ),
                );
                break;
              }
              case "tool-error": {
                const toolCallId = chunk.payload?.toolCallId;
                if (typeof toolCallId !== "string") break;
                patchToolEvents((list) =>
                  list.map((event) =>
                    event.id === toolCallId ? { ...event, status: "error" } : event,
                  ),
                );
                break;
              }
              case "tool-output": {
                const { toolCallId, output } = chunk.payload ?? {};
                if (typeof toolCallId !== "string" || !isToolProgress(output)) break;
                patchToolEvents((list) =>
                  list.map((event) =>
                    event.id === toolCallId
                      ? { ...event, progress: [...(event.progress ?? []), output] }
                      : event,
                  ),
                );
                break;
              }
              case "error": {
                const detail = chunk.payload?.error ?? chunk.payload?.message;
                throw new Error(
                  typeof detail === "string" && detail
                    ? detail
                    : "The assistant stream reported an error.",
                );
              }
              default:
                break;
            }
          },
        });
      } catch (error) {
        if (error instanceof StreamAborted || signal.aborted) return;
        throw error;
      }
    },
    [getSession, updateSession, writeMessages],
  );
}
