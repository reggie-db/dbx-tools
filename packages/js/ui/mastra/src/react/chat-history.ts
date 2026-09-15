import { error as sharedError, log } from "@dbx-tools/shared-core";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MastraPluginClient } from "../support/mastra-client.ts";
import type {
  ThreadMessageWriter,
  ThreadSessionReader,
  ThreadSessionUpdater,
} from "./chat-sessions.ts";

const HISTORY_PAGE_SIZE = 20;
const logger = log.logger("ui-mastra/chat");

interface UseChatHistoryOptions {
  activeKey: string;
  activeThreadId: string | undefined;
  agentId: string;
  getSession: ThreadSessionReader;
  mastraClient: MastraPluginClient;
  updateSession: ThreadSessionUpdater;
  writeMessages: ThreadMessageWriter;
}

/** Hydrate and page the active thread while other thread sessions keep running. */
export function useChatHistory({
  activeKey,
  activeThreadId,
  agentId,
  getSession,
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
      .then((response) => {
        if (cancelled) return;
        updateSession(threadId, (current) => ({
          ...current,
          messages: response.uiMessages as unknown as UIMessage[],
          historyLoaded: true,
          hasMoreHistory: response.hasMore,
          historyPage: 1,
          toolEventsByMessage: {},
          pendingApprovalsByMessage: {},
          feedbackByMessage: {},
        }));
      })
      .catch((error: unknown) => {
        if (cancelled || (error as { name?: string }).name === "AbortError") return;
        logger.error("history load error", {
          error: sharedError.errorMessage(error),
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
  }, [activeKey, activeThreadId, agentId, getSession, mastraClient, updateSession]);

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
        const uiMessages = response.uiMessages as unknown as UIMessage[];
        if (uiMessages.length > 0) {
          writeMessages(threadId, [...uiMessages, ...getSession(threadId).messages]);
        }
        updateSession(threadId, (current) => ({
          ...current,
          hasMoreHistory: response.hasMore,
        }));
      })
      .catch((error: unknown) => {
        logger.error("history load-more error", {
          page,
          error: sharedError.errorMessage(error),
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
