/**
 * Classify Mastra resume failures that are already resolved.
 *
 * A second approve, a reconnect, or an internal `consumeStream` can call
 * `resume()` after the workflow left `suspended`. Mastra still throws for
 * that; the chat client should treat it as the turn already moving on.
 *
 * @module
 */

/** Mastra error ids that mean the run is no longer waiting for resume. */
export const STALE_MASTRA_RESUME_IDS = [
  "AGENT_RESUME_NO_SNAPSHOT_FOUND",
  "AGENT_RESUME_TOOL_CALL_NOT_SUSPENDED",
  "WORKFLOW_RESUME_ALREADY_CLAIMED",
] as const;

/**
 * Marker `chatRoute.onError` writes instead of the raw workflow throw so
 * the UI stream can finish without a user-visible failure.
 */
export const STALE_MASTRA_RESUME_STREAM_TEXT = "mastra-resume-already-settled";

const STALE_MASTRA_RESUME_ID_SET = new Set<string>(STALE_MASTRA_RESUME_IDS);

const STALE_MASTRA_RESUME_PATTERNS = [
  /workflow run was not suspended/i,
  /no snapshot found for this workflow run/i,
  /no suspended steps found/i,
  /could not find a suspended/i,
  /already resumed by another caller/i,
];

/** True when retrying resume would not change run state. */
export function isStaleMastraResumeError(error: unknown): boolean {
  if (error == null) return false;
  if (typeof error === "object" && "id" in error) {
    const id = (error as { id: unknown }).id;
    if (typeof id === "string" && STALE_MASTRA_RESUME_ID_SET.has(id)) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === STALE_MASTRA_RESUME_STREAM_TEXT) return true;
  return STALE_MASTRA_RESUME_PATTERNS.some((pattern) => pattern.test(message));
}
