/**
 * MLflow user-feedback logging: detect whether MLflow tracing is wired
 * for this deployment, and log a thumbs / comment as a trace
 * *assessment* via the Databricks MLflow REST API.
 *
 * Feedback attaches to a trace, and the plugin's spans reach MLflow
 * through the same OTel pipeline as every other AppKit span (see
 * `observability.ts`). On Databricks Apps that pipeline is the UC
 * sidecar injected by `telemetry_export_destinations`, not a direct
 * workspace OTLP URL. MLflow derives its trace id from the OpenTelemetry
 * trace id (`tr-<hex(otelTraceId)>`), so the server stamps the active
 * trace id on each turn's response and the client sends it back here.
 *
 * There is no MLflow JS SDK, so this posts to the assessments REST
 * endpoint directly using the OBO-scoped workspace client (the feedback
 * is thus attributed to the signed-in user). UC-backed Apps traces need
 * the experiment's table-prefix URI (`trace:/{catalog}.{schema}.{prefix}/{tr-hex}`)
 * rather than the experiment-store id the UI does not store. That prefix is
 * read from the experiment's `mlflow.experiment.databricksTraceDestinationPath`
 * tag (or the spans-table tag); `MLFLOW_UC_TRACE_PREFIX` remains an optional
 * override. Trace export is asynchronous, so the just-finished trace may not
 * exist in MLflow yet when the user reacts; the log call retries briefly on
 * "not found" before giving up softly.
 *
 * @module
 */

import { ConfigurationError } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { asyncUtils, errorUtils, log, object } from "@dbx-tools/shared-core";
import { feedback } from "@dbx-tools/shared-mastra";
import { z } from "zod";
import { databricksFetch, readResponseJson, readResponseText } from "./rest.ts";

const logger = log.logger("mastra/mlflow");

/** Workspace client carried on an AppKit execution context. */
type WorkspaceClient = appkit.WorkspaceClientLike;

/** Experiment tag Databricks stores as `catalog.schema.table_prefix`. */
const TRACE_DESTINATION_PATH_TAG = "mlflow.experiment.databricksTraceDestinationPath";
/** Experiment tag naming the OTel spans table (`catalog.schema.{prefix}_otel_spans`). */
const TRACE_SPAN_STORAGE_TABLE_TAG = "mlflow.experiment.databricksTraceSpanStorageTable";

/**
 * Cached UC table prefix resolved from the experiment. `loaded` distinguishes
 * "not fetched yet" from "fetched, experiment has no UC location". Network
 * failures are not cached so a later thumbs click can retry.
 */
let loadedUcPrefix: { prefix: string | undefined } | undefined;

/** Strip the `trace:/` URI wrapper and trailing slashes from a UC prefix. */
function normalizeUcPrefix(raw: string | undefined): string | undefined {
  const value = raw?.trim().replace(/^trace:\//, "").replace(/\/+$/, "");
  return value || undefined;
}

/**
 * Derive `catalog.schema.table_prefix` from a spans table name.
 * Databricks names the table `{prefix}_otel_spans`.
 */
function prefixFromSpanTable(table: string | undefined): string | undefined {
  const name = table?.trim();
  if (!name) return undefined;
  if (name.endsWith("_otel_spans")) return name.slice(0, -"_otel_spans".length);
  if (name.endsWith("_spans")) return name.slice(0, -"_spans".length);
  return undefined;
}

function experimentTagMap(raw: unknown): Map<string, string> {
  const tags = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const tag of raw) {
      if (!object.isRecord(tag) || typeof tag.key !== "string" || typeof tag.value !== "string") {
        continue;
      }
      tags.set(tag.key, tag.value);
    }
    return tags;
  }
  if (!object.isRecord(raw)) return tags;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") tags.set(key, value);
  }
  return tags;
}

/**
 * UC table prefix the assessments API needs, read from experiment tags.
 *
 * Prefers the three-part destination path Databricks writes when the
 * experiment is linked to a table-prefix location. Falls back to stripping
 * `_otel_spans` from the spans-table tag. Two-part schema-linked destinations
 * are ignored (they are not a table prefix).
 */
export function ucTracePrefixFromExperimentTags(rawTags: unknown): string | undefined {
  const tags = experimentTagMap(rawTags);
  const destination = normalizeUcPrefix(tags.get(TRACE_DESTINATION_PATH_TAG));
  if (destination && destination.split(".").length >= 3) return destination;
  return prefixFromSpanTable(tags.get(TRACE_SPAN_STORAGE_TABLE_TAG));
}

/** Drop the in-process UC prefix cache (tests). */
export function resetUcTracePrefixCache(): void {
  loadedUcPrefix = undefined;
}

/**
 * Trace id the assessments REST API accepts for this deployment.
 *
 * Databricks Apps persist traces in Unity Catalog. The experiment UI lists
 * those rows, but `POST /api/3.0/mlflow/traces/{id}/assessments` looks up the
 * experiment store unless `{id}` is the UC URI `trace:/{catalog}.{schema}.{prefix}/{tr-hex}`.
 * A bare `tr-<hex>` 404s and the assessment never appears.
 */
export function mlflowAssessmentTraceId(traceId: string, prefix?: string): string {
  const resolved = normalizeUcPrefix(prefix);
  return resolved ? `trace:/${resolved}/${traceId}` : traceId;
}

async function resolveUcTracePrefix(client: WorkspaceClient): Promise<string | undefined> {
  const fromEnv = normalizeUcPrefix(process.env.MLFLOW_UC_TRACE_PREFIX);
  if (fromEnv) return fromEnv;
  if (loadedUcPrefix) return loadedUcPrefix.prefix;
  const experiment = await fetchExperiment(client);
  if (!experiment) return undefined;
  const prefix = ucTracePrefixFromExperimentTags(experiment.tags);
  loadedUcPrefix = { prefix };
  return prefix;
}

/** Assessments REST path for a trace. `3.0` is the current MLflow API version. */
const assessmentsPath = (traceId: string): string =>
  `/api/3.0/mlflow/traces/${encodeURIComponent(traceId)}/assessments`;

/** Number of times to retry a "trace not found" response before giving up. */
const NOT_FOUND_RETRIES = 3;
/** Base backoff between "trace not found" retries, in ms (grows linearly). */
const NOT_FOUND_BACKOFF_MS = 1200;

const MlflowExperimentResponseSchema = z
  .object({
    experiment: z
      .object({
        experiment_id: z.string().min(1).describe("Workspace MLflow experiment identifier."),
        tags: z.unknown().optional().describe("Experiment tags, including the UC trace location."),
      })
      .passthrough()
      .describe("Configured MLflow experiment."),
  })
  .passthrough()
  .describe("MLflow get-experiment response.");

const CurrentUserResponseSchema = z
  .object({
    userName: z.string().optional().describe("Current workspace user name."),
    applicationId: z.string().optional().describe("Current service principal application id."),
    displayName: z.string().optional().describe("Current principal display name."),
    groups: z
      .array(
        z
          .object({
            value: z.string().optional().describe("Workspace group identifier."),
            display: z.string().optional().describe("Workspace group display name."),
          })
          .passthrough(),
      )
      .optional()
      .describe("Groups assigned to the current principal."),
  })
  .passthrough()
  .describe("Databricks Current User API response.");

const ExperimentPermissionsResponseSchema = z
  .object({
    access_control_list: z
      .array(
        z
          .object({
            user_name: z.string().optional().describe("User principal name."),
            group_name: z.string().optional().describe("Group principal name."),
            service_principal_name: z
              .string()
              .optional()
              .describe("Service principal application id."),
            all_permissions: z
              .array(
                z
                  .object({
                    permission_level: z.string().describe("Effective experiment permission level."),
                  })
                  .passthrough(),
              )
              .optional()
              .describe("Direct and inherited permissions for this principal."),
          })
          .passthrough(),
      )
      .optional()
      .describe("Experiment access control entries."),
  })
  .passthrough()
  .describe("Databricks experiment permissions response.");

function configuredExperiment(): { id?: string; name?: string } {
  const id = process.env.MLFLOW_EXPERIMENT_ID?.trim();
  const name = process.env.MLFLOW_EXPERIMENT_NAME?.trim();
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * Whether MLflow feedback logging is available for this deployment.
 *
 * Enabled when an OTLP exporter endpoint is configured (traces are
 * actually shipped somewhere) AND an MLflow experiment is named - the
 * two signals that the OTLP backend is MLflow and traces will
 * materialize there. Both are standard env vars, so no plugin config is
 * required; a deployment opts in simply by wiring MLflow tracing.
 */
export function mlflowEnabled(): boolean {
  const hasExporter = Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim(),
  );
  const hasExperiment = Boolean(
    process.env.MLFLOW_EXPERIMENT_ID?.trim() || process.env.MLFLOW_EXPERIMENT_NAME?.trim(),
  );
  return hasExporter && hasExperiment;
}

/**
 * Resolve whether user feedback is enabled from the plugin's optional
 * `config.feedback` override: the explicit boolean wins, otherwise fall
 * back to auto-detecting MLflow tracing ({@link mlflowEnabled}). Shared
 * by the plugin's client-config gate and the server's trace-id header so
 * the two never disagree.
 */
export function resolveFeedbackEnabled(explicit: boolean | undefined): boolean {
  return explicit ?? mlflowEnabled();
}

/**
 * Reject an explicitly enabled feedback surface when no MLflow experiment is
 * configured. Auto mode remains non-fatal and simply disables feedback.
 */
export function validateFeedbackConfig(explicit: boolean | undefined): void {
  if (explicit !== true) return;
  const experiment = configuredExperiment();
  if (experiment.id || experiment.name) return;
  throw new ConfigurationError(
    "mastra: feedback is enabled but no MLflow experiment is configured. " +
      "Set MLFLOW_EXPERIMENT_ID or MLFLOW_EXPERIMENT_NAME, use feedback: false, " +
      "or omit feedback to use automatic detection.",
  );
}

/**
 * Return the configured experiment URL only when the active Databricks
 * principal has effective `CAN_MANAGE` permission. Permission lookup is
 * intentionally best-effort so Apps environments that do not expose the
 * required APIs simply omit the debug affordance.
 */
export async function mlflowExperimentManagerUrl(
  client: WorkspaceClient,
): Promise<string | undefined> {
  try {
    return await resolveMlflowExperimentManagerUrl(client);
  } catch {
    return undefined;
  }
}

async function resolveMlflowExperimentManagerUrl(
  client: WorkspaceClient,
): Promise<string | undefined> {
  const experimentId = await resolveExperimentId(client);
  if (!experimentId) return undefined;

  const [currentResponse, permissionsResponse] = await Promise.all([
    databricksFetch(client, "/api/2.0/preview/scim/v2/Me", { method: "GET" }),
    databricksFetch(
      client,
      `/api/2.0/permissions/experiments/${encodeURIComponent(experimentId)}`,
      { method: "GET" },
    ),
  ]);
  if (!currentResponse.ok || !permissionsResponse.ok) return undefined;

  const current = CurrentUserResponseSchema.safeParse(await readResponseJson(currentResponse));
  const permissions = ExperimentPermissionsResponseSchema.safeParse(
    await readResponseJson(permissionsResponse),
  );
  if (!current.success || !permissions.success) return undefined;

  const userNames = new Set(
    [current.data.userName, current.data.applicationId, current.data.displayName].filter(
      (value): value is string => Boolean(value),
    ),
  );
  const groupNames = new Set(
    (current.data.groups ?? []).flatMap(({ value, display }) =>
      [value, display].filter((entry): entry is string => Boolean(entry)),
    ),
  );
  const canManage = (permissions.data.access_control_list ?? []).some((entry) => {
    const matches =
      (entry.user_name !== undefined && userNames.has(entry.user_name)) ||
      (entry.service_principal_name !== undefined && userNames.has(entry.service_principal_name)) ||
      (entry.group_name !== undefined && groupNames.has(entry.group_name));
    return (
      matches &&
      (entry.all_permissions ?? []).some(
        (permission) => permission.permission_level === "CAN_MANAGE",
      )
    );
  });
  if (!canManage) return undefined;

  const host = (await client.config.getHost()).toString();
  return new URL(`/ml/experiments/${encodeURIComponent(experimentId)}`, host).toString();
}

async function fetchExperiment(
  client: WorkspaceClient,
): Promise<{ experiment_id: string; tags?: unknown } | undefined> {
  const experiment = configuredExperiment();
  const path = experiment.id
    ? `/api/2.0/mlflow/experiments/get?experiment_id=${encodeURIComponent(experiment.id)}`
    : experiment.name
      ? `/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(
          experiment.name,
        )}`
      : undefined;
  if (!path) return undefined;
  const response = await databricksFetch(client, path, { method: "GET" });
  if (!response.ok) return undefined;
  const parsed = MlflowExperimentResponseSchema.safeParse(await readResponseJson(response));
  return parsed.success ? parsed.data.experiment : undefined;
}

async function resolveExperimentId(client: WorkspaceClient): Promise<string | undefined> {
  const configured = configuredExperiment();
  if (configured.id) return configured.id;
  return (await fetchExperiment(client))?.experiment_id;
}

/** Parameters for {@link logFeedback}. */
export interface LogFeedbackParams {
  /** MLflow trace id the assessment attaches to (`tr-<hex>`). */
  traceId: string;
  /** Assessment name; defaults per whether a value or a comment is sent. */
  name?: string;
  /** Thumbs / rating / label value. Omit for a comment-only submission. */
  value?: boolean | number | string;
  /** Freeform comment: the rationale alongside a value, or the value itself when none. */
  comment?: string;
  /** Identity the feedback is attributed to (user email / id). */
  sourceId?: string;
}

/**
 * Log a HUMAN feedback assessment to a trace. Returns the created
 * assessment id on success, or `undefined` when the trace can't be
 * found (even after retrying for export lag) or the request otherwise
 * fails - callers surface that as a soft "not recorded" rather than an
 * error, keeping the chat usable.
 */
export async function logFeedback(
  client: WorkspaceClient,
  params: LogFeedbackParams,
): Promise<string | undefined> {
  // A comment with no thumbs value is logged as text feedback; a value
  // (with an optional comment as the rationale) is the thumbs path.
  const hasValue = params.value !== undefined;
  const name =
    params.name?.trim() ||
    (hasValue ? feedback.DEFAULT_FEEDBACK_NAME : feedback.DEFAULT_COMMENT_NAME);
  const value = hasValue ? params.value : params.comment;
  const assessmentTraceId = mlflowAssessmentTraceId(
    params.traceId,
    await resolveUcTracePrefix(client),
  );
  const assessment: Record<string, unknown> = {
    trace_id: assessmentTraceId,
    assessment_name: name,
    source: {
      source_type: "HUMAN",
      source_id: params.sourceId?.trim() || "user",
    },
    feedback: { value },
    ...(hasValue && params.comment?.trim() ? { rationale: params.comment } : {}),
  };
  const body = { assessment };

  for (let attempt = 0; attempt <= NOT_FOUND_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await databricksFetch(client, assessmentsPath(assessmentTraceId), {
        method: "POST",
        body,
      });
    } catch (err) {
      logger.warn("feedback request failed", {
        traceId: params.traceId,
        assessmentTraceId,
        error: errorUtils.errorMessage(err),
      });
      return undefined;
    }
    if (res.ok) {
      const parsed = await readResponseJson(res);
      const assessmentId =
        (parsed as { assessment?: { assessment_id?: unknown } })?.assessment?.assessment_id ??
        (parsed as { assessment_id?: unknown })?.assessment_id;
      return typeof assessmentId === "string" ? assessmentId : "";
    }
    // Trace export is async; a fresh trace may not exist yet. Retry a
    // few times with a short backoff before giving up softly.
    if (res.status === 404 && attempt < NOT_FOUND_RETRIES) {
      await asyncUtils.sleep(NOT_FOUND_BACKOFF_MS * (attempt + 1));
      continue;
    }
    logger.warn("feedback not recorded", {
      traceId: params.traceId,
      assessmentTraceId,
      status: res.status,
      body: await readResponseText(res),
    });
    return undefined;
  }
  return undefined;
}
