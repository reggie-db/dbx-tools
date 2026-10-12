import type { ChatStatus } from "./types.ts";

/** Whether an assistant bubble should show the active-response pulse. */
export const shouldShowAssistantResponsePulse = (
  isLast: boolean,
  status: ChatStatus,
  hasVisibleResponse: boolean,
): boolean =>
  isLast && hasVisibleResponse && (status === "submitted" || status === "streaming");

/** Compact progress affordance shown beneath a partially rendered response. */
export const AssistantResponsePulse = () => (
  <div role="status" aria-live="polite" className="flex h-3 items-center">
    <span className="sr-only">Response in progress</span>
    <span
      aria-hidden="true"
      className="h-0.5 w-12 animate-pulse rounded-full bg-foreground/25 motion-reduce:animate-none"
    />
  </div>
);
