/**
 * Copy each Mastra chat turn's request/response onto the active OTel
 * root span so Databricks-managed MLflow can display them.
 *
 * Why this exists: MLflow's UC `<target>_trace_unified` view picks the
 * one span whose `parent_span_id` is empty and reads request/response
 * from `mlflow.spanInputs` / `mlflow.spanOutputs` (or the `gen_ai.*`
 * equivalents) on THAT span only. Mastra records the turn on its
 * `invoke_agent` child under `mastra.agent_run.input` / `.output`, keys
 * the view never reads, so chat traces arrive with both columns null
 * even when the spans themselves look healthy.
 *
 * The active span inside the Mastra sub-app is still AppKit's HTTP
 * server span (OTel context is async-local). With `OTEL_PROPAGATORS=none`
 * that span is the trace root - see the package README's observability
 * section for why Apps ingress `traceparent` otherwise hides every turn.
 *
 * @module
 */

import { json, log, object } from "@dbx-tools/shared-core";
import { trace } from "@opentelemetry/api";
import type express from "express";

const logger = log.logger("mastra/trace-io");

/** Cap on each payload copied onto a span, so one turn cannot bloat the export. */
export const TRACE_IO_LIMIT = 8_000;

/**
 * Mount-relative Mastra agent invoke paths that carry a chat turn body
 * (`messages`) and stream an assistant answer. Resume / approve verbs
 * are intentionally excluded: their bodies are tool decisions, not the
 * user prompt, and they rarely produce a fresh answer worth surfacing.
 */
const AGENT_TURN_ROUTE = /^\/agents\/[^/]+\/(stream|generate)(\/|$)/i;

/** Attribute keys the MLflow UC `*_trace_unified` view reads from the root span. */
export const MLFLOW_SPAN_INPUTS_ATTR = "mlflow.spanInputs";
export const MLFLOW_SPAN_OUTPUTS_ATTR = "mlflow.spanOutputs";

/**
 * Concatenate the assistant's answer out of an AI SDK SSE transcript.
 *
 * The agent streams its reply as `text-delta` frames
 * (`data: {"type":"text-delta","payload":{"text":"..."}}`), so the full
 * answer only ever exists as deltas on the wire and has to be
 * reassembled here.
 */
export function assistantTextFromSse(body: string): string {
  const parts: string[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    // SSE carries comment/keepalive lines that are not JSON; they never hold
    // assistant text, so skipping them is the intended path rather than an error.
    const frame = json.parse(line.slice(5));
    if (!object.isRecord(frame) || frame.type !== "text-delta") continue;
    const text = object.isRecord(frame.payload) ? frame.payload.text : undefined;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("");
}

/**
 * Express middleware that stamps chat turn I/O onto the active OTel span.
 *
 * Tee `res.write` / `res.end` instead of listening for `finish`: the HTTP
 * instrumentation ends the root span on finish, and an attribute set after
 * a span ends never reaches the exporter.
 *
 * `path` is mount-relative (what the Mastra sub-app sees), e.g.
 * `/agents/support/stream`.
 */
export function chatTurnTraceIoMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (req.method !== "POST" || !AGENT_TURN_ROUTE.test(req.path)) {
    next();
    return;
  }
  const span = trace.getActiveSpan();
  if (!span) {
    next();
    return;
  }

  const messages = (req.body as { messages?: unknown } | undefined)?.messages;
  if (messages !== undefined) {
    span.setAttribute(MLFLOW_SPAN_INPUTS_ATTR, JSON.stringify(messages).slice(0, TRACE_IO_LIMIT));
  }

  const chunks: string[] = [];
  const passThroughWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
  const passThroughEnd = res.end.bind(res) as (...args: unknown[]) => unknown;
  const collect = (chunk: unknown): void => {
    if (typeof chunk === "string") chunks.push(chunk);
    else if (Buffer.isBuffer(chunk)) chunks.push(chunk.toString("utf8"));
  };

  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    collect(chunk);
    return passThroughWrite(chunk, ...rest);
  }) as typeof res.write;

  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    collect(chunk);
    const answer = assistantTextFromSse(chunks.join(""));
    if (answer) {
      span.setAttribute(MLFLOW_SPAN_OUTPUTS_ATTR, answer.slice(0, TRACE_IO_LIMIT));
    }
    return passThroughEnd(chunk, ...rest);
  }) as typeof res.end;

  next();
}

/**
 * Install {@link chatTurnTraceIoMiddleware} on a Mastra Express sub-app.
 *
 * Call before `MastraServer.init()` so the layer sits ahead of the agent
 * routes. Safe to call unconditionally: with no active span (local, no
 * OTLP) the middleware is a no-op.
 */
export function attachChatTurnTraceIo(app: express.Express): void {
  app.use(chatTurnTraceIoMiddleware);
  logger.info("chat turn I/O middleware attached");
}
