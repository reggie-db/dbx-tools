/**
 * Genie space metadata helpers.
 *
 * Fetches a Genie space's definition (including the opt-in `serialized_space`
 * blob) and extracts the curated starter questions an author configured on the
 * space. The typed SDK `client.genie.getSpace` only returns the
 * directory-listing surface (`title` / `description` / `warehouse_id`); the
 * sample questions live inside `serialized_space`, which the REST API returns
 * only when `include_serialized_space=true`. We hit that endpoint through the
 * workspace client's raw `apiClient` since the typed request shape has no flag
 * for it.
 *
 * The serialized blob is also more privileged than the listing surface: the
 * workspace API requires `Can Edit` on the space to return it, while `Can Run`
 * is enough for title / description. A caller that only holds `Can Run` - an
 * app service principal granted just enough to ask questions is the common case
 * - would otherwise lose the whole space lookup to a `PERMISSION_DENIED` it
 * cannot act on, so the fetch degrades to the unserialized request instead of
 * failing (see {@link getGenieSpace}).
 *
 * @module
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { databricks } from "@dbx-tools/appkit";
import { error, json, log, object, string } from "@dbx-tools/shared-core";
import { genieModel, type GenieSpace } from "@dbx-tools/shared-genie";

const logger = log.logger("genie/space");

/** Options for {@link getGenieSpace}. */
export interface GetGenieSpaceOptions {
  /**
   * Explicit `WorkspaceClient`. Defaults to a fresh `new WorkspaceClient({})`
   * (env-var auth). Server callers should pass their OBO-scoped client so the
   * lookup runs as the user.
   */
  workspaceClient?: WorkspaceClient;
  /**
   * Request the `serialized_space` blob (catalogs, tables, sample questions,
   * prompts). Defaults to `true` - the only reason to skip it is when the
   * caller just needs title / description and wants the smaller payload.
   *
   * Requesting it is best-effort: the blob needs `Can Edit` on the space, so a
   * caller without it gets the unserialized space back rather than an error,
   * and {@link genieSampleQuestions} then reports no suggestions.
   */
  serialized?: boolean;
  /**
   * External cancellation. Accepts a WHATWG `AbortSignal` or a fully-built SDK
   * `Context` (see `databricks.ContextLike`).
   */
  context?: databricks.ContextLike;
}

/**
 * Fetch a Genie space by id, optionally including its serialized definition.
 * Hits `GET /api/2.0/genie/spaces/<id>` with `include_serialized_space=true`
 * through the raw `apiClient`, then validates the response against
 * {@link GenieSpaceSchema} (unknown fields like `etag` /
 * `parent_path` are stripped).
 *
 * When the serialized request is rejected for lack of permission (`403`, or a
 * `PERMISSION_DENIED` / `Can Edit` message - the workspace API gates the blob
 * behind `Can Edit`), it retries once without the flag so the caller still gets
 * the space. Any other failure, and a retry that fails too, is rethrown: a
 * cancelled request or a missing space must not look like an unserialized
 * space.
 */
export async function getGenieSpace(
  spaceId: string,
  options?: GetGenieSpaceOptions,
): Promise<GenieSpace> {
  const client = options?.workspaceClient ?? new WorkspaceClient({});
  const serialized = options?.serialized !== false;
  const ctx = options?.context ? databricks.toContext(options.context) : undefined;
  const request = (includeSerialized: boolean): Promise<unknown> =>
    client.apiClient.request(
      {
        path: `/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}`,
        method: "GET",
        query: includeSerialized ? { include_serialized_space: true } : {},
        headers: new Headers(),
        raw: false,
      },
      ctx,
    );

  let raw: unknown;
  try {
    raw = await request(serialized);
  } catch (err) {
    if (!serialized || !isSerializedSpaceForbidden(err)) throw err;
    logger.debug("serialized-space:forbidden", {
      spaceId,
      error: error.errorMessage(err),
    });
    raw = await request(false);
  }
  return genieModel.GenieSpaceSchema.parse(raw);
}

/**
 * True when a failed space request was rejected for lack of permission, the one
 * failure the unserialized retry can recover from. Matches on `403` and on the
 * `PERMISSION_DENIED` / `Can Edit` wording the workspace API returns, since the
 * SDK surfaces the error code without always carrying a status.
 */
function isSerializedSpaceForbidden(err: unknown): boolean {
  const context = error.errorContext(err);
  return (
    context.hasStatusCode(403) ||
    context.hasMessage("permission denied") ||
    context.hasMessage("can edit")
  );
}

/**
 * One entry in a serialized space's `config.sample_questions`. The
 * author-facing field is `question`, which the wire format models as a string
 * array (a single multi-line question is split across entries); we treat the
 * first non-empty entry as the displayable question text.
 */
interface SerializedSampleQuestion {
  question?: unknown;
}

/**
 * Extract the curated starter questions an author configured on a Genie space.
 * Reads `serialized_space -> config.sample_questions[*].question`. Returns `[]`
 * when the space carries no serialized blob, the blob is unparseable, or no
 * sample questions are configured - so a missing or misconfigured space
 * degrades to "no suggestions" rather than throwing. Order is preserved (the
 * author's ordering) and duplicates are dropped.
 */
export function genieSampleQuestions(space: GenieSpace): string[] {
  const serialized = space.serialized_space;
  if (!serialized) return [];
  const parsed = json.parse(serialized);
  if (parsed === undefined) {
    logger.warn("serialized-space:parse-error", { spaceId: space.space_id });
    return [];
  }
  const sampleQuestions = (parsed as { config?: { sample_questions?: unknown } } | null)?.config
    ?.sample_questions;
  if (!Array.isArray(sampleQuestions)) return [];

  return [
    ...object
      .sequence(sampleQuestions as SerializedSampleQuestion[])
      .map((entry) => string.firstNonEmpty(entry?.question))
      .nonNull()
      .distinct(),
  ];
}
