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

import { environmentUtils, json, log, object, stringUtils } from "@dbx-tools/shared-core";
import { feedback, thread } from "@dbx-tools/shared-mastra";
import { context, createContextKey, SpanKind, trace, type Span } from "@opentelemetry/api";
import { getRPCMetadata, RPCType } from "@opentelemetry/core";
import type express from "express";

import { USER_EMAIL_HEADER, USER_ID_HEADER } from "./identity.ts";
import {
  directMlflowTracingActive,
  updateActiveMlflowTrace,
  updateActiveMlflowTraceTags,
} from "./mlflow.ts";
import {
  MLFLOW_AGENT_TAG,
  MLFLOW_AGENT_TAG_ATTR,
  MLFLOW_GENIE_TAG,
  MLFLOW_GENIE_TAG_ATTR,
  MLFLOW_MODEL_TAG,
  MLFLOW_LOCAL_TAG,
  MLFLOW_OBO_AUTH_TAG,
  MLFLOW_SP_AUTH_TAG,
  MLFLOW_TRACE_TAG_PREFIX,
} from "./trace-attributes.ts";

export {
  MLFLOW_AGENT_TAG,
  MLFLOW_AGENT_TAG_ATTR,
  MLFLOW_GENIE_TAG,
  MLFLOW_GENIE_TAG_ATTR,
  MLFLOW_MODEL_TAG,
  MLFLOW_MODEL_TAG_ATTR,
  MLFLOW_LOCAL_TAG,
  MLFLOW_LOCAL_TAG_ATTR,
  MLFLOW_OBO_AUTH_TAG,
  MLFLOW_OBO_AUTH_TAG_ATTR,
  MLFLOW_SP_AUTH_TAG,
  MLFLOW_SP_AUTH_TAG_ATTR,
  MLFLOW_TRACE_TAG_PREFIX,
} from "./trace-attributes.ts";

const logger = log.logger("mastra/telemetry");

/** Cap on each payload copied onto a span, so one turn cannot bloat the export. */
export const TRACE_IO_LIMIT = 8_000;

/** Bound for a non-streaming body captured through `res.end` instead of `res.json`. */
const RESPONSE_BODY_LIMIT = TRACE_IO_LIMIT * 4;

/** Tracer scope used only when AppKit did not create a recording HTTP span. */
const CHAT_TURN_TRACER = "@dbx-tools/appkit-mastra/telemetry";

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
/** Full serialized request messages retained when the MLflow preview is plain text. */
export const CHAT_MESSAGES_ATTR = "appkit.mastra.chat.messages";
/** Full serialized response retained when the MLflow preview is plain text. */
export const CHAT_RESPONSE_ATTR = "appkit.mastra.chat.response";
/** Credential mode used by Databricks calls in this chat turn. */
export const CHAT_IDENTITY_ATTR = "appkit.mastra.identity.mode";
/** Whether the streamed turn emitted a Genie tool or progress event. */
export const CHAT_GENIE_USED_ATTR = "appkit.mastra.genie.used";
/**
 * MLflow span-type attribute. Databricks maps this (or `gen_ai.operation.name`)
 * onto the type chip in the experiment UI. Custom values such as `GENIE` are
 * allowed.
 */
export const MLFLOW_SPAN_TYPE_ATTR = "mlflow.spanType";
/** GenAI semantic-convention operation name, an alternate span-type source. */
export const GEN_AI_OPERATION_NAME_ATTR = "gen_ai.operation.name";
/**
 * Root-span user id the MLflow experiment UI's User column reads from OTel
 * traces. Prefer the forwarded email when present so the column is human.
 */
export const MLFLOW_USER_ATTR = "user.id";
/** Root-span session id that enables the MLflow Sessions tab. */
export const MLFLOW_SESSION_ATTR = "session.id";
/** Root-span type for a Mastra agent turn. */
export const MLFLOW_SPAN_TYPE_AGENT = "AGENT";
/** Span type for an `ask_genie` tool call. */
export const MLFLOW_SPAN_TYPE_GENIE = "GENIE";

/** Root-span metadata known before a chat request is dispatched. */
export interface ChatTurnTelemetryOptions {
  readonly identity?:
    "obo" | "service-principal" | ((request: express.Request) => "obo" | "service-principal");
}

interface TraceTarget {
  span: Span;
  owned: boolean;
}

interface ChatTraceState {
  readonly models: Set<string>;
  readonly tags: Map<string, string>;
  user?: string;
}

/** Values accepted by request-scoped trace-tag injection helpers. */
export type ChatTraceTagValue = string | number | boolean;

const CHAT_TRACE_STATE_KEY = createContextKey("@dbx-tools/appkit-mastra/chat-trace-state");

/** OpenTelemetry's sentinel for "no valid trace" - 32 zero hex chars. */
const INVALID_TRACE_ID = "0".repeat(32);

/**
 * Mark the active span as a Genie call so the experiment UI types it `GENIE`
 * and tags the trace `genie=true`. Safe no-op when no recording span is active.
 */
export function stampGenieToolSpan(span: Span | undefined = trace.getActiveSpan()): void {
  if (!span?.isRecording()) return;
  span.setAttribute(MLFLOW_SPAN_TYPE_ATTR, MLFLOW_SPAN_TYPE_GENIE);
  span.setAttribute(GEN_AI_OPERATION_NAME_ATTR, "execute_tool");
  span.setAttribute(MLFLOW_GENIE_TAG_ATTR, "true");
}

function requestHeader(req: express.Request, name: string): string | undefined {
  const fromMethod =
    typeof req.header === "function" ? stringUtils.trimToNull(req.header(name)) : undefined;
  if (fromMethod) return fromMethod;
  const raw = req.headers?.[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return stringUtils.trimToNull(typeof value === "string" ? value : undefined) ?? undefined;
}

function requestQuery(req: express.Request, name: string): string | undefined {
  const raw = req.query?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return stringUtils.trimToNull(typeof value === "string" ? value : undefined) ?? undefined;
}

function stampMlflowActor(span: Span, req: express.Request): string | undefined {
  const user = requestHeader(req, USER_EMAIL_HEADER) ?? requestHeader(req, USER_ID_HEADER);
  if (user) span.setAttribute(MLFLOW_USER_ATTR, user);
  const session =
    requestHeader(req, thread.THREAD_ID_HEADER) ?? requestQuery(req, thread.THREAD_ID_QUERY);
  if (session) span.setAttribute(MLFLOW_SESSION_ATTR, session);
  return user;
}

function traceId(span: Span | undefined = trace.getActiveSpan()): string | undefined {
  const value = span?.spanContext().traceId;
  return value && value !== INVALID_TRACE_ID ? value : undefined;
}

function activeChatTraceState(): ChatTraceState | undefined {
  return context.active().getValue(CHAT_TRACE_STATE_KEY) as ChatTraceState | undefined;
}

function setChatTraceTag(
  state: ChatTraceState,
  name: string,
  value: ChatTraceTagValue,
): void {
  const tag = stringUtils.trimToNull(name);
  if (!tag) return;
  state.tags.set(tag, String(value));
}

/** Inject one MLflow trace tag into the active chat request. */
export function recordActiveTraceTag(
  name: string,
  value: ChatTraceTagValue = true,
): void {
  const state = activeChatTraceState();
  if (state) setChatTraceTag(state, name, value);
}

/** Inject multiple MLflow trace tags into the active chat request. */
export function recordActiveTraceTags(
  tags: Readonly<Record<string, ChatTraceTagValue | undefined>>,
): void {
  const state = activeChatTraceState();
  if (!state) return;
  for (const [name, value] of Object.entries(tags)) {
    if (value !== undefined) setChatTraceTag(state, name, value);
  }
}

/** Record a selected model on the active chat trace, preserving first-use order. */
export function recordActiveTraceModel(modelId: string): void {
  const value = stringUtils.trimToNull(modelId);
  if (!value) return;
  activeChatTraceState()?.models.add(value);
}

/** Record the best resolved user identifier on the active chat trace. */
export function recordActiveTraceUser(user: string | undefined): void {
  const value = stringUtils.trimToNull(user);
  if (!value) return;
  const state = activeChatTraceState();
  if (state) state.user = value;
}

/** Record one Databricks authentication mode used during the active chat trace. */
export function recordActiveTraceAuth(auth: "obo" | "service-principal"): void {
  recordActiveTraceTag(auth === "obo" ? MLFLOW_OBO_AUTH_TAG : MLFLOW_SP_AUTH_TAG);
}

/** Serialize model tags as a scalar or an ordered JSON array for multiple values. */
export function modelTraceTag(models: Iterable<string>): string | undefined {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const value = stringUtils.trimToNull(model);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : JSON.stringify(values);
}

/** Publish the turn's MLflow trace id before the handler writes the body. */
function stampMlflowTraceId(res: express.Response, span: Span): void {
  if (res.headersSent) return;
  const traceId = span.spanContext().traceId;
  if (!traceId || traceId === INVALID_TRACE_ID) return;
  res.setHeader(feedback.MLFLOW_TRACE_ID_HEADER, `tr-${traceId}`);
}

/** Return one raw prompt when the request is exactly one text-only user message. */
export function textOnlyChatInput(messages: unknown): string | undefined {
  if (typeof messages === "string") return messages || undefined;
  if (!Array.isArray(messages) || messages.length !== 1) return undefined;
  const message = messages[0];
  if (!object.isRecord(message) || message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content || undefined;
  return textFromParts(message.parts) ?? textFromParts(message.content);
}

function textFromParts(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const text: string[] = [];
  for (const part of value) {
    if (!object.isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      return undefined;
    }
    text.push(part.text);
  }
  const joined = text.join("");
  return joined || undefined;
}

function serialized(value: unknown, limit = TRACE_IO_LIMIT): string {
  return JSON.stringify(value)?.slice(0, limit) ?? String(value).slice(0, limit);
}

function sseFrame(line: string): unknown {
  if (!line.startsWith("data:")) return undefined;
  return json.parse(line.slice(5));
}

function valueUsesGenie(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (Array.isArray(value)) return value.some((item) => valueUsesGenie(item, depth + 1));
  if (!object.isRecord(value)) return false;
  if (
    value.type === "data-genie-progress" ||
    value.type === "ask_genie_done" ||
    value.toolName === "ask_genie" ||
    value.tool_name === "ask_genie" ||
    value.name === "ask_genie"
  ) {
    return true;
  }
  return ["data", "event", "payload"].some((key) => valueUsesGenie(value[key], depth + 1));
}

/** Return the assistant text from one SSE line, or an empty string. */
function assistantTextFromSseLine(line: string): string {
  return assistantTextFromSseFrame(sseFrame(line));
}

function assistantTextFromSseFrame(frame: unknown): string {
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
  private genie = false;

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

  rawBody(): string {
    return this.body.slice(0, TRACE_IO_LIMIT);
  }

  usedGenie(): boolean {
    return this.genie;
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
    const frame = sseFrame(line);
    this.genie ||= valueUsesGenie(frame);
    if (this.answer.length >= TRACE_IO_LIMIT) return;
    const text = assistantTextFromSseFrame(frame);
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
  if (directMlflowTracingActive()) {
    const span = trace
      .getTracer(CHAT_TURN_TRACER)
      .startSpan(
        "mastra.chat_turn",
        {
          kind: SpanKind.SERVER,
          attributes: {
            [MLFLOW_AGENT_TAG_ATTR]: "true",
            [MLFLOW_SPAN_TYPE_ATTR]: MLFLOW_SPAN_TYPE_AGENT,
            [GEN_AI_OPERATION_NAME_ATTR]: "invoke_agent",
          },
        },
        trace.deleteSpan(activeContext),
      );
    if (!span.isRecording()) {
      span.end();
      return undefined;
    }
    return { span, owned: true };
  }

  const rpc = getRPCMetadata(activeContext);
  if (rpc?.type === RPCType.HTTP && rpc.span.isRecording()) {
    return { span: rpc.span, owned: false };
  }

  const active = trace.getActiveSpan();
  if (active?.isRecording()) return { span: active, owned: false };

  const span = trace
    .getTracer(CHAT_TURN_TRACER)
    .startSpan(
      "mastra.chat_turn",
      {
        kind: SpanKind.SERVER,
        attributes: {
          [MLFLOW_AGENT_TAG_ATTR]: "true",
          [MLFLOW_SPAN_TYPE_ATTR]: MLFLOW_SPAN_TYPE_AGENT,
          [GEN_AI_OPERATION_NAME_ATTR]: "invoke_agent",
        },
      },
      activeContext,
    );
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
export function chatTurnTelemetryMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
  options: ChatTurnTelemetryOptions = {},
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
  const targetTraceId = traceId(target.span);
  if (!targetTraceId) {
    if (target.owned) target.span.end();
    next();
    return;
  }
  const traceState: ChatTraceState = { models: new Set(), tags: new Map() };
  setChatTraceTag(traceState, MLFLOW_AGENT_TAG, true);
  if (!environmentUtils.isDatabricksAppEnv()) {
    setChatTraceTag(traceState, MLFLOW_LOCAL_TAG, true);
  }
  stampMlflowTraceId(res, target.span);
  traceState.user = stampMlflowActor(target.span, req);
  target.span.setAttribute(MLFLOW_SPAN_TYPE_ATTR, MLFLOW_SPAN_TYPE_AGENT);
  target.span.setAttribute(GEN_AI_OPERATION_NAME_ATTR, "invoke_agent");
  target.span.setAttribute(MLFLOW_AGENT_TAG_ATTR, "true");
  const identity =
    typeof options.identity === "function" ? options.identity(req) : options.identity;
  if (identity) {
    target.span.setAttribute(CHAT_IDENTITY_ATTR, identity);
    setChatTraceTag(
      traceState,
      identity === "obo" ? MLFLOW_OBO_AUTH_TAG : MLFLOW_SP_AUTH_TAG,
      true,
    );
  }
  target.span.setAttribute(CHAT_GENIE_USED_ATTR, false);

  const messages = (req.body as { messages?: unknown } | undefined)?.messages;
  if (messages !== undefined) {
    const fullInput = serialized(messages);
    target.span.setAttribute(CHAT_MESSAGES_ATTR, fullInput);
    target.span.setAttribute(
      MLFLOW_SPAN_INPUTS_ATTR,
      (textOnlyChatInput(messages) ?? fullInput).slice(0, TRACE_IO_LIMIT),
    );
  }

  const collector = new AssistantResponseCollector();
  let outputRecorded = false;
  let fullOutputRecorded = false;
  let genieRecorded = false;
  let ownedSpanEnded = false;
  let traceFinalized = false;
  const passThroughWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
  const passThroughEnd = res.end.bind(res) as (...args: unknown[]) => unknown;
  const passThroughJson = res.json.bind(res) as (body?: unknown) => express.Response;
  const recordOutput = (answer: string): void => {
    if (outputRecorded || !answer) return;
    target.span.setAttribute(MLFLOW_SPAN_OUTPUTS_ATTR, answer.slice(0, TRACE_IO_LIMIT));
    outputRecorded = true;
  };
  const recordFullOutput = (response: string): void => {
    if (fullOutputRecorded || !response) return;
    target.span.setAttribute(CHAT_RESPONSE_ATTR, response.slice(0, TRACE_IO_LIMIT));
    fullOutputRecorded = true;
  };
  const recordGenie = (used: boolean): void => {
    if (!used || genieRecorded) return;
    genieRecorded = true;
    target.span.setAttribute(CHAT_GENIE_USED_ATTR, true);
    target.span.setAttribute(MLFLOW_GENIE_TAG_ATTR, "true");
    setChatTraceTag(traceState, MLFLOW_GENIE_TAG, true);
    context.with(trace.setSpan(context.active(), target.span), () => {
      updateActiveMlflowTraceTags({ [MLFLOW_GENIE_TAG]: "true" });
    });
  };
  const finalizeTrace = (): void => {
    if (traceFinalized) return;
    traceFinalized = true;
    const model = modelTraceTag(traceState.models);
    if (model) setChatTraceTag(traceState, MLFLOW_MODEL_TAG, model);
    const tags = Object.fromEntries(traceState.tags);
    for (const [name, value] of traceState.tags) {
      target.span.setAttribute(`${MLFLOW_TRACE_TAG_PREFIX}${name}`, value);
    }
    if (traceState.user) target.span.setAttribute(MLFLOW_USER_ATTR, traceState.user);
    context.with(trace.setSpan(context.active(), target.span), () => {
      updateActiveMlflowTrace({
        ...(Object.keys(tags).length > 0 ? { tags } : {}),
        ...(traceState.user ? { user: traceState.user } : {}),
      });
    });
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
    recordFullOutput(serialized(body));
    recordGenie(valueUsesGenie(body));
    recordOutput(assistantTextFromJson(body));
    return passThroughJson(body);
  }) as typeof res.json;

  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    collector.write(chunk);
    recordOutput(collector.finish());
    recordFullOutput(collector.rawBody());
    recordGenie(collector.usedGenie());
    finalizeTrace();
    try {
      return passThroughEnd(chunk, ...rest);
    } finally {
      endOwnedSpan();
    }
  }) as typeof res.end;

  res.once("close", () => {
    recordOutput(collector.finish());
    recordFullOutput(collector.rawBody());
    recordGenie(collector.usedGenie());
    finalizeTrace();
    endOwnedSpan();
  });

  const chatContext = trace
    .setSpan(context.active(), target.span)
    .setValue(CHAT_TRACE_STATE_KEY, traceState);
  context.with(chatContext, () => {
    updateActiveMlflowTraceTags({ [MLFLOW_AGENT_TAG]: "true" });
    next();
  });
}

/**
 * Install {@link chatTurnTelemetryMiddleware} on a Mastra Express sub-app.
 *
 * Call before `MastraServer.init()` so the layer sits ahead of the agent
 * routes. Safe to call unconditionally: when no recording tracer is registered,
 * the middleware is a no-op.
 */
export function attachChatTurnTelemetry(
  app: express.Express,
  options: ChatTurnTelemetryOptions = {},
): void {
  app.use((req, res, next) => chatTurnTelemetryMiddleware(req, res, next, options));
  logger.info("chat turn telemetry middleware attached", options);
}
