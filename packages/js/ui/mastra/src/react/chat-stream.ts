import { stringUtils } from "@dbx-tools/shared-core";
import { feedback } from "@dbx-tools/shared-mastra";
import { readUIMessageStream, type UIMessage } from "ai";
import { useCallback } from "react";
import type {
  ThreadMessageWriter,
  ThreadSessionReader,
  ThreadSessionUpdater,
} from "./chat-sessions.ts";
import type { MastraStreamResponse } from "../support/mastra-client.ts";

/** Read the MLflow trace id captured by the server on a stream response. */
const readMlflowTraceId = (stream: unknown): string | undefined => {
  const headers = (stream as { headers?: { get?: (name: string) => string | null } })?.headers;
  return stringUtils.trimToUndefined(headers?.get?.(feedback.MLFLOW_TRACE_ID_HEADER));
};

class StreamAborted extends Error {}

/** Replace or append one assistant message without disturbing the transcript. */
function upsertAssistant(messages: UIMessage[], assistant: UIMessage): UIMessage[] {
  const next = [...messages];
  const index = next.findIndex((message) => message.id === assistant.id);
  if (index === -1) next.push(assistant);
  else next[index] = assistant;
  return next;
}

interface UseChatStreamOptions {
  getSession: ThreadSessionReader;
  updateSession: ThreadSessionUpdater;
  writeMessages: ThreadMessageWriter;
}

/** Project one Mastra stream through the native AI SDK UI message converter. */
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

      try {
        const existing = getSession(threadId).messages.find(
          (message) => message.id === assistantId,
        );
        for await (const message of readUIMessageStream({
          ...(existing ? { message: existing } : {}),
          stream: stream.stream,
          terminateOnError: true,
        })) {
          if (signal.aborted) throw new StreamAborted();
          const assistant = message.id === assistantId ? message : { ...message, id: assistantId };
          writeMessages(threadId, upsertAssistant(getSession(threadId).messages, assistant));
          updateSession(threadId, (current) => ({
            ...current,
            runId: runIdRef.current,
            status: "streaming",
          }));
        }
      } catch (error) {
        if (error instanceof StreamAborted || signal.aborted) return;
        throw error;
      }
    },
    [getSession, updateSession, writeMessages],
  );
}
