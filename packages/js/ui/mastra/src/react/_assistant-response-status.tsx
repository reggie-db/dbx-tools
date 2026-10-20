import { Spinner } from "@databricks/appkit-ui/react";

import type { ChatStatus } from "./types.ts";

/** Whether an assistant bubble should show its active-response status. */
export const shouldShowAssistantResponseStatus = (
  isLast: boolean,
  status: ChatStatus,
  hasVisibleResponse: boolean,
): boolean => isLast && hasVisibleResponse && (status === "submitted" || status === "streaming");

/** Compact progress affordance for an active assistant response. */
export const AssistantResponseSpinner = () => (
  <span role="status" aria-live="polite" className="inline-flex items-center">
    <Spinner className="size-3" />
    <span className="sr-only">Response in progress</span>
  </span>
);
