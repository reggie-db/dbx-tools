/**
 * Copy each Mastra chat turn's request/response onto its OTel root span
 * so Databricks-managed MLflow can display them.
 *
 * Why this exists: MLflow's UC `<target>_trace_unified` view picks the
 * one span whose `parent_span_id` is empty and reads request/response
 * from `mlflow.spanInputs` / `mlflow.spanOutputs` (or the `gen_ai.*`
 * equivalents) on THAT span only. Mastra records the turn on its
 * `invoke_agent` child under `mastra.agent_run.input` / `.output`, keys
 * the view never reads, so chat traces arrive with both columns null
 * even when the spans themselves look healthy.
 *
 * AppKit's HTTP instrumentation records the server span in OTel RPC metadata,
 * which remains available even when Express makes a middleware-layer child
 * active. When instrumentation is unavailable, this module creates one
 * request-lifetime server span and runs Mastra under it.
 *
 * @module
 */

import { StringDecoder } from "node:string_decoder";

import { json, log, object } from "@dbx-tools/shared-core";
import { context, SpanKind, trace, type Span } from "@opentelemetry/api";
import { getRPCMetadata, RPCType } from "@opentelemetry/core";
import type express from "express";

const logger = log.logger("mastra/trace-io");

/** Cap on each payload copied onto a span, so one turn cannot bloat the export. */
export const TRACE_IO_LIMIT = 8_000;

/** Bound for a non-streaming body captured through `res.end` instead of `res.json`. */
const RESPONSE_BODY_LIMIT = TRACE_IO_LIMIT * 4;

/** Tracer scope used only when AppKit did not create a recording HTTP span. */
const CHAT_TURN_TRACER = "@dbx-tools/appkit-mastra/trace-io";

/**
 * Mount-relative Mastra agent invoke paths that carry a chat turn body
 * (`messages`) and stream an assistant answer. Resume / approve verbs
 * are intentionally excluded: their bodies are tool decisions, not the
 * user prompt, and they rarely produce a fresh answer worth surfacing.
 */
const AGENT_TURN_ROUTE = /^(?:\/agents\/[^/]+\/(?:stream|generate)(?:\/|$)|\/chat\/[^/]+$)/i;

/** Attribute keys the MLflow UC `*_trace_unified` view reads from the root span. */
export const MLFLOW_SPAN_INPUTS_ATTR = "mlflow.spanInputs";
/** Root-span attribute consumed as chat output by MLflow unified trace views. */
export const MLFLOW_SPAN_OUTPUTS_ATTR = "mlflow.spanOutputs";

interface TraceTarget {
  span: Span;
  owned: boolean;
}

/** Return the assistant text from one SSE line, or an empty string. */
function assistantTextFromSseLine(line: string): string {
  if (!line.startsWith("data:")) return "";
  const frame = json.parse(line.slice(5));
  if (!object.isRecord(frame) || frame.type !== "text-delta") return "";
  const text =
    typeof frame.delta === "string"
      ? frame.delta
      : object.isRecord(frame.payload)
        ? frame.payload.text
        : undefined;
  return typeof text === "string" ? text : "";
}

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
    const text = assistantTextFromSseLine(line);
    if (text) parts.push(text);
  }
  return parts.join("").slice(0, TRACE_IO_LIMIT);
}

/** Read the final assistant text from a non-streaming Mastra response. */
export function assistantTextFromJson(body: unknown): string {
  if (!object.isRecord(body) || typeof body.text !== "string") return "";
  return body.text.slice(0, TRACE_IO_LIMIT);
}

/** Incrementally assemble UTF-8 SSE text while retaining a bounded JSON fallback. */
class AssistantResponseCollector {
  private readonly decoder = new StringDecoder("utf8");
  private answer = "";
  private body = "";
  private pendingLine = "";
  private finished = false;

  write(chunk: unknown): void {
    if (this.finished) return;
    if (typeof chunk === "string") {
      this.consume(chunk);
      return;
    }
    if (ArrayBuffer.isView(chunk)) {
      this.consume(
        this.decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
      );
    }
  }

  finish(): string {
    if (this.finished) return this.answer || this.jsonAnswer();
    this.finished = true;
    this.consume(this.decoder.end());
    this.consumeSseLine(this.pendingLine);
    this.pendingLine = "";
    return this.answer || this.jsonAnswer();
  }

  private consume(text: string): void {
    if (!text) return;
    if (this.body.length < RESPONSE_BODY_LIMIT) {
      this.body += text.slice(0, RESPONSE_BODY_LIMIT - this.body.length);
    }
    this.pendingLine += text;
    let newline = this.pendingLine.indexOf("\n");
    while (newline >= 0) {
      this.consumeSseLine(this.pendingLine.slice(0, newline).replace(/\r$/, ""));
      this.pendingLine = this.pendingLine.slice(newline + 1);
      newline = this.pendingLine.indexOf("\n");
    }
    if (this.pendingLine.length > RESPONSE_BODY_LIMIT) {
      this.pendingLine = this.pendingLine.slice(-RESPONSE_BODY_LIMIT);
    }
  }

  private consumeSseLine(line: string): void {
    if (this.answer.length >= TRACE_IO_LIMIT) return;
    const text = assistantTextFromSseLine(line);
    this.answer += text.slice(0, TRACE_IO_LIMIT - this.answer.length);
  }

  private jsonAnswer(): string {
    return assistantTextFromJson(json.parse(this.body));
  }
}

/**
 * Select the span MLflow treats as the request root.
 *
 * OTel HTTP instrumentation stores its server span in RPC metadata. That span
 * wins over an active Express child. If no recording local span exists, create
 * one under the current context so enabled W3C propagation remains intact.
 */
function resolveTraceTarget(): TraceTarget | undefined {
  const activeContext = context.active();
  const rpc = getRPCMetadata(activeContext);
  if (rpc?.type === RPCType.HTTP && rpc.span.isRecording()) {
    return { span: rpc.span, owned: false };
  }

  const active = trace.getActiveSpan();
  if (active?.isRecording()) return { span: active, owned: false };

  const span = trace
    .getTracer(CHAT_TURN_TRACER)
    .startSpan("mastra.chat_turn", { kind: SpanKind.SERVER }, activeContext);
  if (!span.isRecording()) {
    span.end();
    return undefined;
  }
  return { span, owned: true };
}

/**
 * Express middleware that stamps chat turn I/O onto the exported OTel root.
 *
 * Tee `res.write`, `res.json`, and `res.end` instead of listening for `finish`:
 * HTTP instrumentation ends its server span on finish, and attributes set
 * after a span ends never reach the exporter.
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
  const target = resolveTraceTarget();
  if (!target) {
    next();
    return;
  }

  const messages = (req.body as { messages?: unknown } | undefined)?.messages;
  if (messages !== undefined) {
    target.span.setAttribute(
      MLFLOW_SPAN_INPUTS_ATTR,
      JSON.stringify(messages).slice(0, TRACE_IO_LIMIT),
    );
  }

  const collector = new AssistantResponseCollector();
  let outputRecorded = false;
  let ownedSpanEnded = false;
  const passThroughWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
  const passThroughEnd = res.end.bind(res) as (...args: unknown[]) => unknown;
  const passThroughJson = res.json.bind(res) as (body?: unknown) => express.Response;
  const recordOutput = (answer: string): void => {
    if (outputRecorded || !answer) return;
    target.span.setAttribute(MLFLOW_SPAN_OUTPUTS_ATTR, answer.slice(0, TRACE_IO_LIMIT));
    outputRecorded = true;
  };
  const endOwnedSpan = (): void => {
    if (!target.owned || ownedSpanEnded) return;
    ownedSpanEnded = true;
    target.span.end();
  };

  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    collector.write(chunk);
    return passThroughWrite(chunk, ...rest);
  }) as typeof res.write;

  res.json = ((body?: unknown) => {
    recordOutput(assistantTextFromJson(body));
    return passThroughJson(body);
  }) as typeof res.json;

  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    collector.write(chunk);
    recordOutput(collector.finish());
    try {
      return passThroughEnd(chunk, ...rest);
    } finally {
      endOwnedSpan();
    }
  }) as typeof res.end;

  res.once("close", () => {
    recordOutput(collector.finish());
    endOwnedSpan();
  });

  context.with(trace.setSpan(context.active(), target.span), next);
}

/**
 * Install {@link chatTurnTraceIoMiddleware} on a Mastra Express sub-app.
 *
 * Call before `MastraServer.init()` so the layer sits ahead of the agent
 * routes. Safe to call unconditionally: when no recording tracer is registered,
 * the middleware is a no-op.
 */
export function attachChatTurnTraceIo(app: express.Express): void {
  app.use(chatTurnTraceIoMiddleware);
  logger.info("chat turn I/O middleware attached");
}
