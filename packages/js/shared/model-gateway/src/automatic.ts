/**
 * Browser-safe constants for the virtual automatic model and route metadata.
 *
 * @module
 */

/** Canonical virtual model id that invokes context-aware automatic routing. */
export const AUTOMATIC_MODEL_ID = "auto";

/** Concrete model selected for an automatic request. */
export const AUTOMATIC_SELECTED_MODEL_HEADER = "x-dbx-tools-selected-model";

/** Logical tier selected for an automatic request. */
export const AUTOMATIC_TIER_HEADER = "x-dbx-tools-auto-tier";

/** Generic reasoning effort selected for an automatic request. */
export const AUTOMATIC_REASONING_HEADER = "x-dbx-tools-auto-reasoning-effort";

/** Selector confidence attached to an automatic request. */
export const AUTOMATIC_CONFIDENCE_HEADER = "x-dbx-tools-auto-confidence";

/** Runtime decision source attached to an automatic request. */
export const AUTOMATIC_SOURCE_HEADER = "x-dbx-tools-auto-source";

/** Bounded selector reason code attached to an automatic request. */
export const AUTOMATIC_REASON_CODE_HEADER = "x-dbx-tools-auto-reason-code";

/** Whether an automatic request used degraded fallback policy. */
export const AUTOMATIC_DEGRADED_HEADER = "x-dbx-tools-auto-degraded";

/** Match the canonical automatic id with an optional dbx/databricks namespace. */
export function isAutomaticModelId(value: string | undefined): boolean {
  return (
    value
      ?.trim()
      .replace(/^(?:dbx|databricks)\//i, "")
      .toLowerCase() === AUTOMATIC_MODEL_ID
  );
}
