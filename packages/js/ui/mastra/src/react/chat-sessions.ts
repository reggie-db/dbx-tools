import type { UIMessage } from "ai";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  createThreadSession,
  DEFAULT_THREAD_SESSION_KEY,
  isSessionRunning,
  sessionKey,
  type ThreadSession,
} from "../support/thread-sessions.ts";

export type ThreadSessionReader = (threadId: string) => ThreadSession;

export type ThreadSessionUpdater = (
  threadId: string,
  updater: (session: ThreadSession) => ThreadSession,
) => void;

export type ThreadMessageWriter = (threadId: string, messages: UIMessage[]) => void;

/** Own the mutable per-thread session registry behind the public chat hook. */
export function useChatSessions(activeThreadId: string | undefined) {
  const [revision, setRevision] = useState(0);
  const sessionsRef = useRef<Map<string, ThreadSession>>(new Map());
  const getSession = useCallback<ThreadSessionReader>((threadId) => {
    let session = sessionsRef.current.get(threadId);
    if (!session) {
      session = createThreadSession();
      sessionsRef.current.set(threadId, session);
    }
    return session;
  }, []);
  const updateSession = useCallback<ThreadSessionUpdater>(
    (threadId, updater) => {
      sessionsRef.current.set(threadId, updater(getSession(threadId)));
      setRevision((current) => current + 1);
    },
    [getSession],
  );
  const writeMessages = useCallback<ThreadMessageWriter>(
    (threadId, messages) => {
      updateSession(threadId, (session) => ({ ...session, messages }));
    },
    [updateSession],
  );
  const resetSession = useCallback((threadId: string, historyLoaded = false) => {
    sessionsRef.current.get(threadId)?.abortController?.abort();
    sessionsRef.current.set(threadId, { ...createThreadSession(), historyLoaded });
    setRevision((current) => current + 1);
  }, []);
  const removeSession = useCallback((threadId: string) => {
    sessionsRef.current.get(threadId)?.abortController?.abort();
    sessionsRef.current.delete(threadId);
    setRevision((current) => current + 1);
  }, []);
  const activeKey = sessionKey(activeThreadId);
  const activeSession = useMemo(() => getSession(activeKey), [activeKey, getSession, revision]);
  const streamingThreadIds = useMemo(() => {
    const ids: string[] = [];
    for (const [id, session] of sessionsRef.current.entries()) {
      if (id === DEFAULT_THREAD_SESSION_KEY) continue;
      if (isSessionRunning(session)) ids.push(id);
    }
    return ids;
  }, [revision]);

  return {
    activeKey,
    activeSession,
    getSession,
    removeSession,
    resetSession,
    streamingThreadIds,
    updateSession,
    writeMessages,
  };
}
