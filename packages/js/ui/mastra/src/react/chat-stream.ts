import { log, toError, trimToUndefined } from "@dbx-tools/shared-core";
import {
  MLFLOW_TRACE_ID_HEADER,
  MLFLOW_TRACE_PART_TYPE,
  MlflowTracePartDataSchema,
  RESPONSE_COMPLETE_PART_TYPE,
  isStaleMastraResumeError,
} from "@dbx-tools/shared-mastra";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { useCallback } from "react";
import type {
  ThreadMessageWriter,
  ThreadSessionReader,
  ThreadSessionUpdater,
} from "./chat-sessions.ts";
import type { ChatStatus } from "./types.ts";
import type { MastraStreamResponse } from "../support/mastra-client.ts";

const logger = log.logger("ui-mastra/chat");

/** Read the MLflow trace id captured by the server on a stream response. */
const readMlflowTraceId = (stream: unknown): string | undefined => {
  const headers = (stream as { headers?: { get?: (name: string) => string | null } })?.headers;
  return trimToUndefined(headers?.get?.(MLFLOW_TRACE_ID_HEADER));
};

/** Read the trace-id fallback carried by one transient AI SDK data part. */
export const readMlflowTracePart = (chunk: UIMessageChunk): string | undefined => {
  if ((chunk as { type?: string }).type !== MLFLOW_TRACE_PART_TYPE) return undefined;
  const parsed = MlflowTracePartDataSchema.safeParse((chunk as { data?: unknown }).data);
  return parsed.success ? parsed.data.traceId : undefined;
};

/** Map lifecycle-only chunks onto the UI's active-turn state. */
export const chatStatusForChunk = (chunk: UIMessageChunk): ChatStatus | undefined => {
  if ((chunk as { type?: string }).type === RESPONSE_COMPLETE_PART_TYPE) return "finishing";
  if (chunk.type === "finish" || chunk.type === "abort") return "ready";
  return undefined;
};

class StreamAborted extends Error {}

/** Stop reading a background run once the AI SDK has delivered its terminal chunk. */
export function closeOnTerminalChunk(
  stream: ReadableStream<UIMessageChunk>,
  onTerminal?: () => void,
  onChunk?: (chunk: UIMessageChunk) => void,
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
            controller.error(new Error("Chat stream ended before a terminal AI SDK chunk"));
            return;
          }
          onChunk?.(value);
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

/** Drain a run observation until its terminal finish or abort chunk arrives. */
export async function waitForTerminalChunk(stream: ReadableStream<UIMessageChunk>): Promise<void> {
  const reader = closeOnTerminalChunk(stream).getReader();
  try {
    while (!(await reader.read()).done) {
      // Draining is the synchronization point; the replacement turn does not replay this output.
    }
  } finally {
    reader.releaseLock();
  }
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
      const recordTraceId = (traceId: string | undefined): void => {
        if (!traceId) return;
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
      };
      recordTraceId(readMlflowTraceId(stream));

      try {
        let terminalReceived = false;
        const existing = getSession(threadId).messages.find(
          (message) => message.id === assistantId,
        );
        for await (const message of readUIMessageStream({
          ...(existing ? { message: existing } : {}),
          stream: closeOnTerminalChunk(
            stream.stream,
            () => {
              terminalReceived = true;
            },
            (chunk) => {
              recordTraceId(readMlflowTracePart(chunk));
              const status = chatStatusForChunk(chunk);
              if (!status) return;
              updateSession(threadId, (current) => ({
                ...current,
                status,
              }));
            },
          ),
          terminateOnError: true,
        })) {
          if (signal.aborted) throw new StreamAborted();
          const assistant = message.id === assistantId ? message : { ...message, id: assistantId };
          writeMessages(threadId, upsertAssistant(getSession(threadId).messages, assistant));
          updateSession(threadId, (current) => ({
            ...current,
            runId: runIdRef.current,
            status:
              terminalReceived || current.status === "finishing"
                ? terminalReceived
                  ? "ready"
                  : "finishing"
                : "streaming",
          }));
        }
      } catch (error) {
        if (error instanceof StreamAborted || signal.aborted) return;
        if (isStaleMastraResumeError(error)) {
          logger.warn("ignored stale mastra resume", {
            error: toError(error),
          });
          return;
        }
        throw error;
      }
    },
    [getSession, updateSession, writeMessages],
  );
}
