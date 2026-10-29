import type { RequestContext } from "@mastra/client-js";
import type { UIMessage } from "ai";
import {
  isActiveChatStatus,
  type ChatStatus,
  type MessageFeedback,
  type PendingApproval,
  type QueuedSteer,
} from "../react/types.ts";

/** A queued steer plus the application context captured when it was submitted. */
export type SessionQueuedSteer = QueuedSteer & {
  requestContext?: RequestContext;
};

/** UI target and immutable application context captured for one Mastra run. */
export type SessionRun = {
  assistantId: string;
  requestContext?: RequestContext;
};

/** Session-scoped transcript + stream state for one conversation thread. */
export type ThreadSession = {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | null;
  pendingApprovalsByMessage: Record<string, PendingApproval[]>;
  feedbackByMessage: Record<string, MessageFeedback>;
  abortController: AbortController | null;
  runToken: number;
  assistantId: string | null;
  runId: string | null;
  /** Live runs retained by id so older approval cards resume their own context. */
  runs: Record<string, SessionRun>;
  historyLoaded: boolean;
  hasMoreHistory: boolean;
  historyPage: number;
  /** Context snapshot for the active run and approval continuation. */
  runRequestContext?: RequestContext;
  /** Context snapshot reused when regenerating the last turn. */
  lastRequestContext?: RequestContext;
  /** Steers submitted mid-turn, waiting to run (oldest first). */
  queuedSteers: SessionQueuedSteer[];
};

/** Map key for the classic single-thread chat (no explicit thread id). */
export const DEFAULT_THREAD_SESSION_KEY = "__session__";

/** Create the empty transcript and run state used for a new conversation thread. */
export function createThreadSession(): ThreadSession {
  return {
    messages: [],
    status: "ready",
    error: null,
    pendingApprovalsByMessage: {},
    feedbackByMessage: {},
    abortController: null,
    runToken: 0,
    assistantId: null,
    runId: null,
    runs: {},
    historyLoaded: false,
    hasMoreHistory: false,
    historyPage: 0,
    queuedSteers: [],
  };
}

/** Return whether a thread still owns an active run. */
export function isSessionRunning(session: ThreadSession): boolean {
  return isActiveChatStatus(session.status);
}

/** Return the newest user message in a transcript or turn. */
export function lastUserMessage(messages: readonly UIMessage[]): UIMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return undefined;
}

/** Build a replacement turn that retains the interrupted user request. */
export function interruptedTurnMessages(
  messages: UIMessage[],
  nextMessage: UIMessage,
): UIMessage[] {
  const interrupted = lastUserMessage(messages);
  if (!interrupted || interrupted.id === nextMessage.id) return [nextMessage];
  return [interrupted, nextMessage];
}

/** Append a steer to the queue (oldest first). Returns a new array. */
export function enqueueSteer<T extends QueuedSteer>(queue: T[], steer: T): T[] {
  return [...queue, steer];
}

/** Remove the steer with `id` from the queue. Returns a new array. */
export function removeSteer<T extends QueuedSteer>(queue: T[], id: string): T[] {
  return queue.filter((steer) => steer.id !== id);
}

/**
 * Reorder the queue to match `orderedIds` (a drag-reorder of the pending
 * steers). Ids not present are dropped and unknown ids ignored, so a stale
 * order can't duplicate or resurrect an item; any current steer missing from
 * `orderedIds` is appended in its existing relative order as a safety net.
 */
export function reorderSteers<T extends QueuedSteer>(queue: T[], orderedIds: string[]): T[] {
  const byId = new Map(queue.map((steer) => [steer.id, steer]));
  const seen = new Set<string>();
  const next: T[] = [];
  for (const id of orderedIds) {
    const steer = byId.get(id);
    if (steer && !seen.has(id)) {
      next.push(steer);
      seen.add(id);
    }
  }
  for (const steer of queue) {
    if (!seen.has(steer.id)) next.push(steer);
  }
  return next;
}

/** Resolve an explicit thread id or the shared key used by single-thread chat. */
export function sessionKey(activeThreadId: string | undefined): string {
  return activeThreadId ?? DEFAULT_THREAD_SESSION_KEY;
}
