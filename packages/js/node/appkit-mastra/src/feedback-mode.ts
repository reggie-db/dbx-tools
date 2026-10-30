/**
 * Feedback destination resolution.
 *
 * @module
 */

import { ConfigurationError } from "@databricks/appkit";
import type { FeedbackDestination, FeedbackModeOption } from "@dbx-tools/shared-mastra";

/** Runtime availability used by automatic feedback selection. */
export interface FeedbackAvailability {
  /** Genie Agent Mode has at least one configured space. */
  genie: boolean;
  /** MLflow tracing has a configured experiment and exporter. */
  mlflow: boolean;
}

/** Resolve available feedback destinations or fail an explicit unavailable choice. */
export function resolveFeedbackModes(
  configured: FeedbackModeOption | undefined,
  availability: FeedbackAvailability,
): FeedbackDestination[] {
  const mode = configured ?? "auto";
  if (mode === "none") return [];
  if (mode === "auto") {
    return [
      ...(availability.genie ? (["genie"] as const) : []),
      ...(availability.mlflow ? (["mlflow"] as const) : []),
    ];
  }
  if (availability[mode]) return [mode];
  throw new ConfigurationError(
    `mastra: feedbackMode "${mode}" is unavailable in this configuration`,
    { context: { feedbackMode: mode } },
  );
}
