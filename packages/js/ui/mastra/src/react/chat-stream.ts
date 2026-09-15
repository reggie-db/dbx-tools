import { feedback } from "@dbx-tools/shared-mastra";
import { useCallback } from "react";
import type { MastraStreamResponse } from "../support/mastra-stream.ts";
import type {
  ThreadMessageWriter,
  ThreadSessionReader,
  ThreadSessionUpdater,
} from "./chat-sessions.ts";
import {
  chatStreamAssistantMessage,
  createChatStreamState,
  reduceChatStreamChunk,
} from "./chat-stream-reducer.ts";

/** Read the MLflow trace id captured by the server on a stream response. */
const readMlflowTraceId = (stream: unknown): string | undefined => {
  const headers = (stream as { headers?: { get?: (name: string) => string | null } })?.headers;
  return headers?.get?.(feedback.MLFLOW_TRACE_ID_HEADER)?.trim() || undefined;
};

class StreamAborted extends Error {}

interface UseChatStreamOptions {
  getSession: ThreadSessionReader;
  updateSession: ThreadSessionUpdater;
  writeMessages: ThreadMessageWriter;
}

/** Translate one validated Mastra data stream into thread messages and tool state. */
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

      const session = getSession(threadId);
      const existing = session.messages.find((message) => message.id === assistantId);
      let state = createChatStreamState({
        ...(existing ? { existing } : {}),
        pendingApprovals: session.pendingApprovalsByMessage[assistantId] ?? [],
        runId: runIdRef.current,
        toolEvents: session.toolEventsByMessage[assistantId] ?? [],
      });

      const upsertAssistant = () => {
        const next = [...getSession(threadId).messages];
        const index = next.findIndex((message) => message.id === assistantId);
        const message = chatStreamAssistantMessage(assistantId, state);
        if (index === -1) next.push(message);
        else next[index] = message;
        writeMessages(threadId, next);
      };

      try {
        await stream.processDataStream({
          onChunk: async (chunk) => {
            if (signal.aborted) throw new StreamAborted();
            const next = reduceChatStreamChunk(state, chunk);
            state = next.state;
            runIdRef.current = state.runId;

            if (Object.values(next.changes).some(Boolean)) {
              updateSession(threadId, (current) => ({
                ...current,
                ...(next.changes.runId ? { runId: state.runId } : {}),
                ...(next.changes.status ? { status: "streaming" as const } : {}),
                ...(next.changes.toolEvents
                  ? {
                      toolEventsByMessage: {
                        ...current.toolEventsByMessage,
                        [assistantId]: state.toolEvents,
                      },
                    }
                  : {}),
                ...(next.changes.pendingApprovals
                  ? {
                      pendingApprovalsByMessage: {
                        ...current.pendingApprovalsByMessage,
                        [assistantId]: state.pendingApprovals,
                      },
                    }
                  : {}),
              }));
            }
            if (next.assistantChanged) upsertAssistant();
            if (next.error) throw new Error(next.error);
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
