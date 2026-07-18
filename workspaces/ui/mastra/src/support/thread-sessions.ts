import type { UIMessage } from "ai";
import type {
  ChatStatus,
  MessageFeedback,
  PendingApproval,
  QueuedSteer,
  ToolEvent,
} from "../react/types";

export type { QueuedSteer } from "../react/types";

/** Session-scoped transcript + stream state for one conversation thread. */
export type ThreadSession = {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | null;
  toolEventsByMessage: Record<string, ToolEvent[]>;
  pendingApprovalsByMessage: Record<string, PendingApproval[]>;
  feedbackByMessage: Record<string, MessageFeedback>;
  abortController: AbortController | null;
  runToken: number;
  assistantId: string | null;
  runId: string | null;
  historyLoaded: boolean;
  hasMoreHistory: boolean;
  historyPage: number;
  lastUserText: string | null;
  /** Steers submitted mid-turn, waiting to run (oldest first). */
  queuedSteers: QueuedSteer[];
};

/** Map key for the classic single-thread chat (no explicit thread id). */
export const DEFAULT_THREAD_SESSION_KEY = "__session__";

export function createThreadSession(): ThreadSession {
  return {
    messages: [],
    status: "ready",
    error: null,
    toolEventsByMessage: {},
    pendingApprovalsByMessage: {},
    feedbackByMessage: {},
    abortController: null,
    runToken: 0,
    assistantId: null,
    runId: null,
    historyLoaded: false,
    hasMoreHistory: false,
    historyPage: 0,
    lastUserText: null,
    queuedSteers: [],
  };
}

export function isSessionRunning(session: ThreadSession): boolean {
  return session.status === "submitted" || session.status === "streaming";
}

/** Append a steer to the queue (oldest first). Returns a new array. */
export function enqueueSteer(
  queue: QueuedSteer[],
  steer: QueuedSteer,
): QueuedSteer[] {
  return [...queue, steer];
}

/** Remove the steer with `id` from the queue. Returns a new array. */
export function removeSteer(queue: QueuedSteer[], id: string): QueuedSteer[] {
  return queue.filter((steer) => steer.id !== id);
}

/**
 * Settle any tool-progress pills still marked `running` to `done`. A cancelled
 * or interrupted turn stops delivering the `tool-result` / `tool-error` chunks
 * that would otherwise close them, so without this a Genie / chart pill would
 * spin forever after the user hits stop. Returns the same map when nothing was
 * running so callers can skip a needless state update.
 */
export function terminateRunningToolEvents(
  toolEventsByMessage: Record<string, ToolEvent[]>,
): Record<string, ToolEvent[]> {
  let changed = false;
  const next: Record<string, ToolEvent[]> = {};
  for (const [messageId, events] of Object.entries(toolEventsByMessage)) {
    next[messageId] = events.map((event) => {
      if (event.status !== "running") return event;
      changed = true;
      return { ...event, status: "done" as const };
    });
  }
  return changed ? next : toolEventsByMessage;
}

export function sessionKey(activeThreadId: string | undefined): string {
  return activeThreadId ?? DEFAULT_THREAD_SESSION_KEY;
}
