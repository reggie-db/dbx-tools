import { errorUtils, log, stringUtils } from "@dbx-tools/shared-core";
import { feedback } from "@dbx-tools/shared-mastra";
import { isStaleMastraResumeError } from "@dbx-tools/shared-mastra/resume";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { useCallback } from "react";
import type {
  ThreadMessageWriter,
  ThreadSessionReader,
  ThreadSessionUpdater,
} from "./chat-sessions.ts";
import type { MastraStreamResponse } from "../support/mastra-client.ts";

const logger = log.logger("ui-mastra/chat");

/** Read the MLflow trace id captured by the server on a stream response. */
const readMlflowTraceId = (stream: unknown): string | undefined => {
  const headers = (stream as { headers?: { get?: (name: string) => string | null } })?.headers;
  return stringUtils.trimToUndefined(headers?.get?.(feedback.MLFLOW_TRACE_ID_HEADER));
};

class StreamAborted extends Error {}

/** Stop reading a background run once the AI SDK has delivered its terminal chunk. */
export function closeOnTerminalChunk(
  stream: ReadableStream<UIMessageChunk>,
  onTerminal?: () => void,
): ReadableStream<UIMessageChunk> {
  let reader: ReadableStreamDefaultReader<UIMessageChunk> | undefined;
  let cancelled = false;
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
          if (value.type === "finish" || value.type === "abort") {
            onTerminal?.();
            controller.close();
            await reader.cancel("terminal AI SDK chunk received").catch(() => undefined);
            return;
          }
        }
      } catch (error) {
        if (!cancelled) controller.error(error);
      } finally {
        reader.releaseLock();
        reader = undefined;
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader?.cancel(reason);
    },
  });
}

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
        let terminalReceived = false;
        const existing = getSession(threadId).messages.find(
          (message) => message.id === assistantId,
        );
        for await (const message of readUIMessageStream({
          ...(existing ? { message: existing } : {}),
          stream: closeOnTerminalChunk(stream.stream, () => {
            terminalReceived = true;
          }),
          terminateOnError: true,
        })) {
          if (signal.aborted) throw new StreamAborted();
          const assistant = message.id === assistantId ? message : { ...message, id: assistantId };
          writeMessages(threadId, upsertAssistant(getSession(threadId).messages, assistant));
          updateSession(threadId, (current) => ({
            ...current,
            runId: runIdRef.current,
            status: terminalReceived ? "ready" : "streaming",
          }));
        }
      } catch (error) {
        if (error instanceof StreamAborted || signal.aborted) return;
        if (isStaleMastraResumeError(error)) {
          logger.warn("ignored stale mastra resume", {
            error: errorUtils.errorMessage(error),
          });
          return;
        }
        throw error;
      }
    },
    [getSession, updateSession, writeMessages],
  );
}
