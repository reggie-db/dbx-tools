/**
 * Wire-format contracts for the Mastra plugin's user-feedback surface:
 * automatic destination selection, Genie Agent message feedback, and MLflow
 * trace assessments through `MASTRA_ROUTES.feedback`.
 *
 * Feedback is logged to MLflow as a trace *assessment* (thumbs up/down
 * as a boolean, or a freeform comment as text), so it must be tied to a
 * trace. The plugin stamps the active OTel trace id of each turn on the
 * response as {@link MLFLOW_TRACE_ID_HEADER} (`tr-<hex>`) and streams the same
 * value as {@link MLFLOW_TRACE_PART_TYPE} when an ingress proxy removes custom
 * response headers. The client captures it per assistant message and sends it
 * back here when the user reacts.
 *
 * @module
 */

import { z } from "zod";

/**
 * Response header carrying the turn's MLflow trace id (`tr-<hex>`),
 * derived from the active OpenTelemetry trace id. Present only when
 * MLflow logging is enabled and a trace was active for the request.
 * The chat client reads it off the stream response and pairs it with
 * the assistant message so a later thumbs / comment attaches to the
 * right trace.
 */
export const MLFLOW_TRACE_ID_HEADER = "x-mlflow-trace-id";

/** Transient AI SDK data-part carrying the turn's MLflow trace id. */
export const MLFLOW_TRACE_PART_TYPE = "data-mlflow-trace" as const;

/** Data attached to {@link MLFLOW_TRACE_PART_TYPE}. */
export const MlflowTracePartDataSchema = z.object({
  traceId: z.string().regex(/^tr-[0-9a-f]{32}$/),
});

/** Validated payload carrying one MLflow trace id through the chat stream. */
export type MlflowTracePartData = z.infer<typeof MlflowTracePartDataSchema>;

/** Assessment name used for thumbs feedback when the caller omits one. */
export const DEFAULT_FEEDBACK_NAME = "user_feedback";

/** Assessment name used for a freeform comment when no explicit value is sent. */
export const DEFAULT_COMMENT_NAME = "user_comment";

/**
 * Feedback value the assessment records. Boolean for thumbs up/down,
 * number for a rating scale, string for a short categorical label.
 * A freeform comment travels in `comment` instead (or as the value
 * when no thumbs value is present).
 */
export const MastraFeedbackValueSchema = z.union([z.boolean(), z.number(), z.string()]);
/** Value recorded on the MLflow assessment for a Mastra turn. */
export type MastraFeedbackValue = z.infer<typeof MastraFeedbackValueSchema>;

/** One feedback destination available for an assistant message. */
export const FeedbackDestinationSchema = z.enum(["mlflow", "genie"]);

/** One feedback destination available for an assistant message. */
export type FeedbackDestination = z.infer<typeof FeedbackDestinationSchema>;

/** Feedback destination selected by AppKit-Mastra configuration. */
export const FeedbackModeSchema = z.enum(["none", ...FeedbackDestinationSchema.options]);

/** Feedback destination selected by AppKit-Mastra configuration. */
export type FeedbackMode = z.infer<typeof FeedbackModeSchema>;

/** Feedback destinations available to the browser client. */
export const FeedbackDestinationsSchema = z.array(FeedbackDestinationSchema);

/** Feedback destinations available to the browser client. */
export type FeedbackDestinations = z.infer<typeof FeedbackDestinationsSchema>;

/** Configurable feedback mode with automatic destination selection. */
export const FeedbackModeOptionSchema = z.enum(["auto", "none", "mlflow", "genie"]);

/** Configurable feedback mode with automatic destination selection. */
export type FeedbackModeOption = z.infer<typeof FeedbackModeOptionSchema>;

/**
 * Request body for `POST ${basePath}/route/feedback`.
 *
 * Fields:
 *   - `traceId`: MLflow trace id the feedback attaches to (the
 *     `tr-<hex>` value the server sent via {@link MLFLOW_TRACE_ID_HEADER}).
 *   - `name`: assessment name. Defaults to {@link DEFAULT_FEEDBACK_NAME}
 *     for a value, {@link DEFAULT_COMMENT_NAME} for a comment-only submit.
 *   - `value`: the thumbs / rating value (omit for a comment-only submit).
 *   - `comment`: freeform rationale. Logged as the assessment value when
 *     `value` is absent, or as the rationale alongside a `value`.
 *
 * Refined so an empty submission (neither a value nor a non-empty
 * comment) is rejected rather than logging a meaningless assessment.
 */
export const MlflowFeedbackRequestSchema = z
  .object({
    mode: z.literal("mlflow"),
    traceId: z.string().min(1),
    name: z.string().optional(),
    value: MastraFeedbackValueSchema.optional(),
    comment: z.string().optional(),
  })
  .refine((v) => v.value !== undefined || (v.comment?.trim().length ?? 0) > 0, {
    message: "feedback requires a value or a non-empty comment",
  });

/** MLflow trace-assessment feedback request. */
export type MlflowFeedbackRequest = z.infer<typeof MlflowFeedbackRequestSchema>;

/** Feedback submitted directly to one Genie Agent message. */
export const GenieFeedbackRequestSchema = z
  .object({
    mode: z.literal("genie"),
    spaceId: z.string().trim().min(1),
    conversationId: z.string().trim().min(1),
    messageId: z.string().trim().min(1),
    rating: z.enum(["POSITIVE", "NEGATIVE"]),
    request: z.string().trim().min(1).max(10_000),
    comment: z.string().trim().max(5_000).optional(),
  })
  .strict()
  .describe("Rating, request, and optional comment for one Genie Agent message.");

/** Feedback submitted directly to one Genie Agent message. */
export type GenieFeedbackRequest = z.infer<typeof GenieFeedbackRequestSchema>;

/** Feedback route request for the configured MLflow or Genie destination. */
export const MastraFeedbackRequestSchema = z.discriminatedUnion("mode", [
  MlflowFeedbackRequestSchema,
  GenieFeedbackRequestSchema,
]);
/** Validated request body accepted by the Mastra feedback route. */
export type MastraFeedbackRequest = z.infer<typeof MastraFeedbackRequestSchema>;

/**
 * Response from `POST ${basePath}/route/feedback`.
 *
 * `ok` is `true` when the assessment was recorded. It can be `false`
 * (with `ok: false`) without the call throwing - most commonly because
 * the trace hasn't finished exporting to MLflow yet (trace export is
 * asynchronous); the client surfaces a soft "try again" hint rather
 * than an error. `assessmentId` is the created assessment's id on
 * success.
 */
export const MastraFeedbackResponseSchema = z.object({
  ok: z.boolean(),
  assessmentId: z.string().optional(),
});
/** Feedback-route result, including the assessment id when MLflow accepted it. */
export type MastraFeedbackResponse = z.infer<typeof MastraFeedbackResponseSchema>;

/**
 * Per-viewer MLflow experiment link returned by the plugin.
 *
 * `url` is present only when the active user can view the configured
 * experiment. A null value keeps permission lookup failures and users without
 * experiment access from affecting chat startup.
 */
export const MastraMlflowExperimentResponseSchema = z
  .object({
    url: z
      .string()
      .url()
      .nullable()
      .describe("Experiment URL when the active viewer can read it, otherwise null."),
    tracePrefix: z
      .string()
      .nullable()
      .describe("Unity Catalog trace table prefix used to build direct trace links."),
  })
  .describe("Per-viewer link to the configured MLflow experiment.");

/** Per-viewer MLflow experiment debug-link response. */
export type MastraMlflowExperimentResponse = z.infer<typeof MastraMlflowExperimentResponseSchema>;
