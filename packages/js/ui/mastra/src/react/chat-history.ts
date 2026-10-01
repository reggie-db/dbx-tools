import { errorUtils, log } from "@dbx-tools/shared-core";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { toChronologicalUiMessages } from "./_history-messages.ts";
import type {
  ThreadMessageWriter,
  ThreadSessionReader,
  ThreadSessionUpdater,
} from "./chat-sessions.ts";
import type { PendingApproval } from "./types.ts";
import type { MastraPluginClient } from "../support/mastra-client.ts";

const HISTORY_PAGE_SIZE = 20;
const logger = log.logger("ui-mastra/chat");

interface UseChatHistoryOptions {
  activeKey: string;
  activeThreadId: string;
  agentId: string;
  getSession: ThreadSessionReader;
  availability: "loading" | "present" | "missing";
  mastraClient: MastraPluginClient;
  updateSession: ThreadSessionUpdater;
  writeMessages: ThreadMessageWriter;
}

type SuspendedRuns = Awaited<ReturnType<MastraPluginClient["suspendedRuns"]>>["runs"];

/** Recover actionable approval cards from Mastra's persisted suspended runs. */
function pendingApprovals(
  messages: UIMessage[],
  runs: SuspendedRuns,
): Record<string, PendingApproval[]> {
  const approvals: Record<string, PendingApproval[]> = {};
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  for (const run of runs) {
    for (const toolCall of run.toolCalls) {
      if (!toolCall.requiresApproval || !toolCall.toolCallId || !toolCall.toolName) continue;
      const owner =
        [...assistantMessages]
          .reverse()
          .find((message) =>
            message.parts.some(
              (part) => (part as { toolCallId?: unknown }).toolCallId === toolCall.toolCallId,
            ),
          ) ?? assistantMessages.at(-1);
      if (!owner) continue;
      approvals[owner.id] = [
        ...(approvals[owner.id] ?? []),
        {
          runId: run.runId,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.args,
        },
      ];
    }
  }
  return approvals;
}

/** Hydrate and page the active thread while other thread sessions keep running. */
export function useChatHistory({
  activeKey,
  activeThreadId,
  agentId,
  getSession,
  availability,
  mastraClient,
  updateSession,
  writeMessages,
}: UseChatHistoryOptions) {
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [loadingMoreThreads, setLoadingMoreThreads] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const historyInFlightRef = useRef(new Set<string>());

  useEffect(() => {
    const threadId = activeKey;
    const session = getSession(threadId);
    if (session.historyLoaded) {
      setIsLoadingHistory(false);
      return;
    }
    if (availability === "loading") {
      setIsLoadingHistory(true);
      return;
    }
    if (availability === "missing") {
      updateSession(threadId, (current) => ({
        ...current,
        historyLoaded: true,
        hasMoreHistory: false,
      }));
      setIsLoadingHistory(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    historyInFlightRef.current.add(threadId);
    setIsLoadingHistory(true);
    mastraClient
      .history({
        agentId,
        threadId: activeThreadId,
        page: 0,
        perPage: HISTORY_PAGE_SIZE,
        signal: controller.signal,
      })
      .then(async (response) => {
        const suspended = await mastraClient
          .suspendedRuns(agentId, activeThreadId, controller.signal)
          .catch((error: unknown) => {
            if ((error as { name?: string }).name === "AbortError") throw error;
            logger.warn("suspended-run discovery error", {
              error: errorUtils.errorMessage(error),
            });
            return { runs: [], total: 0 };
          });
        return [response, suspended] as const;
      })
      .then(([response, suspended]) => {
        if (cancelled) return;
        const messages = toChronologicalUiMessages(response);
        updateSession(threadId, (current) => ({
          ...current,
          messages,
          historyLoaded: true,
          hasMoreHistory: response.hasMore ?? false,
          historyPage: 1,
          pendingApprovalsByMessage: pendingApprovals(messages, suspended.runs),
          feedbackByMessage: {},
        }));
      })
      .catch((error: unknown) => {
        if (cancelled || (error as { name?: string }).name === "AbortError") return;
        logger.error("history load error", {
          error: errorUtils.errorMessage(error),
        });
        updateSession(threadId, (current) => ({
          ...current,
          historyLoaded: true,
          hasMoreHistory: false,
        }));
      })
      .finally(() => {
        historyInFlightRef.current.delete(threadId);
        if (!cancelled) setIsLoadingHistory(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeKey, activeThreadId, agentId, availability, getSession, mastraClient, updateSession]);

  const loadOlderHistory = useCallback(() => {
    const threadId = activeKey;
    const session = getSession(threadId);
    if (historyInFlightRef.current.has(threadId) || !session.hasMoreHistory) return;
    historyInFlightRef.current.add(threadId);
    setLoadingMoreThreads((current) => new Set(current).add(threadId));
    const page = session.historyPage;
    updateSession(threadId, (current) => ({ ...current, historyPage: page + 1 }));
    mastraClient
      .history({ agentId, threadId: activeThreadId, page, perPage: HISTORY_PAGE_SIZE })
      .then((response) => {
        const uiMessages = toChronologicalUiMessages(response);
        if (uiMessages.length > 0) {
          writeMessages(threadId, [...uiMessages, ...getSession(threadId).messages]);
        }
        updateSession(threadId, (current) => ({
          ...current,
          hasMoreHistory: response.hasMore ?? false,
        }));
      })
      .catch((error: unknown) => {
        logger.error("history load-more error", {
          page,
          error: errorUtils.errorMessage(error),
        });
        updateSession(threadId, (current) => ({
          ...current,
          historyPage: page,
          hasMoreHistory: false,
        }));
      })
      .finally(() => {
        historyInFlightRef.current.delete(threadId);
        setLoadingMoreThreads((current) => {
          if (!current.has(threadId)) return current;
          const next = new Set(current);
          next.delete(threadId);
          return next;
        });
      });
  }, [activeKey, activeThreadId, agentId, getSession, mastraClient, updateSession, writeMessages]);

  return {
    isLoadingHistory,
    isLoadingMore: loadingMoreThreads.has(activeKey),
    loadOlderHistory,
  };
}
