import type { UIMessage } from "ai";
import type { MastraRequestContextSnapshot } from "./request-context.ts";
import type { ChatStatus, MessageFeedback, PendingApproval, QueuedSteer } from "../react/types.ts";

export type { QueuedSteer } from "../react/types.ts";

/** A queued steer plus the application context captured when it was submitted. */
export type SessionQueuedSteer = QueuedSteer & {
  requestContext?: MastraRequestContextSnapshot;
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
  historyLoaded: boolean;
  hasMoreHistory: boolean;
  historyPage: number;
  /** Context snapshot for the active run and approval continuation. */
  runRequestContext?: MastraRequestContextSnapshot;
  /** Context snapshot reused when regenerating the last turn. */
  lastRequestContext?: MastraRequestContextSnapshot;
  /** Steers submitted mid-turn, waiting to run (oldest first). */
  queuedSteers: SessionQueuedSteer[];
};

/** Map key for the classic single-thread chat (no explicit thread id). */
export const DEFAULT_THREAD_SESSION_KEY = "__session__";

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
    historyLoaded: false,
    hasMoreHistory: false,
    historyPage: 0,
    queuedSteers: [],
  };
}

export function isSessionRunning(session: ThreadSession): boolean {
  return session.status === "submitted" || session.status === "streaming";
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

export function sessionKey(activeThreadId: string | undefined): string {
  return activeThreadId ?? DEFAULT_THREAD_SESSION_KEY;
}
