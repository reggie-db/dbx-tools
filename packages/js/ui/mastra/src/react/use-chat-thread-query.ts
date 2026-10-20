import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import type { ThreadIdChangeReason } from "./mastra-chat.tsx";

const DEFAULT_THREAD_PARAMETER = "thread";

/** Bind Mastra's active thread to one URL search parameter. */
export function useChatThreadQuery(parameter = DEFAULT_THREAD_PARAMETER) {
  const [searchParams, setSearchParams] = useSearchParams();
  const threadId = searchParams.get(parameter)?.trim() || undefined;
  const onThreadIdChange = useCallback(
    (nextThreadId: string, reason: ThreadIdChangeReason) => {
      setSearchParams(
        (current) => {
          if (current.get(parameter) === nextThreadId) return current;
          const next = new URLSearchParams(current);
          next.set(parameter, nextThreadId);
          return next;
        },
        { replace: reason === "hydrate" || reason === "missing" || reason === "delete" },
      );
    },
    [parameter, setSearchParams],
  );

  return { threadId, onThreadIdChange };
}
