/**
 * Feedback destination resolution.
 *
 * @module
 */

import { ConfigurationError } from "@databricks/appkit";
import type { FeedbackMode, FeedbackModeOption } from "@dbx-tools/shared-mastra";

/** Runtime availability used by automatic feedback selection. */
export interface FeedbackAvailability {
  /** Genie Agent Mode has at least one configured space. */
  genie: boolean;
  /** MLflow tracing has a configured experiment and exporter. */
  mlflow: boolean;
}

/** Resolve auto feedback or fail an explicitly unavailable destination. */
export function resolveFeedbackMode(
  configured: FeedbackModeOption | undefined,
  availability: FeedbackAvailability,
): FeedbackMode {
  const mode = configured ?? "auto";
  if (mode === "none") return "none";
  if (mode === "auto") {
    if (availability.genie) return "genie";
    if (availability.mlflow) return "mlflow";
    return "none";
  }
  if (availability[mode]) return mode;
  throw new ConfigurationError(
    `mastra: feedbackMode "${mode}" is unavailable in this configuration`,
    { context: { feedbackMode: mode } },
  );
}
