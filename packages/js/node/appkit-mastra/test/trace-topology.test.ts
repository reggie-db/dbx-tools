import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { feedback } from "@dbx-tools/shared-mastra";
import { injectRequestTags } from "@dbx-tools/appkit/request-tags";
import { context, propagation, ROOT_CONTEXT, trace, type Tracer } from "@opentelemetry/api";
import {
  getRPCMetadata,
  RPCType,
  setRPCMetadata,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { configureOtelPropagation } from "../src/observability.ts";
import {
  CHAT_GENIE_USED_ATTR,
  CHAT_IDENTITY_ATTR,
  CHAT_MESSAGES_ATTR,
  CHAT_RESPONSE_ATTR,
  chatTurnTelemetryMiddleware,
  GEN_AI_OPERATION_NAME_ATTR,
  MLFLOW_AGENT_TAG_ATTR,
  MLFLOW_GENIE_TAG_ATTR,
  MLFLOW_LOCAL_TAG_ATTR,
  MLFLOW_MODEL_TAG_ATTR,
  MLFLOW_OBO_AUTH_TAG_ATTR,
  MLFLOW_SESSION_ATTR,
  MLFLOW_SPAN_INPUTS_ATTR,
  MLFLOW_SPAN_OUTPUTS_ATTR,
  MLFLOW_SPAN_TYPE_AGENT,
  MLFLOW_SPAN_TYPE_ATTR,
  MLFLOW_SPAN_TYPE_GENIE,
  MLFLOW_SP_AUTH_TAG_ATTR,
  MLFLOW_USER_ATTR,
  recordActiveTraceAuth,
  recordActiveTraceModel,
  recordActiveTraceTag,
  recordActiveTraceTags,
  recordActiveTraceUser,
  stampGenieToolSpan,
} from "../src/telemetry.ts";

const INCOMING_TRACE_ID = "0123456789abcdef0123456789abcdef";
const INCOMING_SPAN_ID = "0123456789abcdef";
const INCOMING_TRACEPARENT = `00-${INCOMING_TRACE_ID}-${INCOMING_SPAN_ID}-01`;
const ORIGINAL_PROPAGATORS = process.env.OTEL_PROPAGATORS;
const ORIGINAL_APP_ENV = process.env.DBX_TOOLS_DATABRICKS_APP_ENV;

interface TestResponse {
  headers: Record<string, string>;
  headersSent: boolean;
  setHeader(name: string, value: string): void;
  write(chunk: unknown): boolean;
  end(chunk?: unknown): TestResponse;
  json(body?: unknown): TestResponse;
  once(event: string, listener: () => void): TestResponse;
}

function createResponse(): TestResponse {
  const closeListeners: (() => void)[] = [];
  const headers: Record<string, string> = {};
  const response: TestResponse = {
    headers,
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    write() {
      return true;
    },
    end() {
      for (const listener of closeListeners) listener();
      return response;
    },
    json(body?: unknown) {
      return response.end(JSON.stringify(body));
    },
    once(event: string, listener: () => void) {
      if (event === "close") closeListeners.push(listener);
      return response;
    },
  };
  return response;
}

function request(
  path: string,
  messages: unknown,
  extras: { headers?: Record<string, string>; query?: Record<string, string> } = {},
): Record<string, unknown> {
  const headers = extras.headers ?? {};
  return {
    method: "POST",
    path,
    body: { messages },
    headers,
    query: extras.query ?? {},
    header(name: string) {
      return headers[name] ?? headers[name.toLowerCase()];
    },
  };
}

function endChildSpans(tracer: Tracer, names: readonly string[]): void {
  for (const name of names) {
    tracer.startSpan(name, undefined, context.active()).end();
  }
}

function restorePropagator(): void {
  propagation.disable();
  assert.equal(propagation.setGlobalPropagator(new W3CTraceContextPropagator()), true);
}

function restorePropagatorsEnvironment(): void {
  if (ORIGINAL_PROPAGATORS === undefined) delete process.env.OTEL_PROPAGATORS;
  else process.env.OTEL_PROPAGATORS = ORIGINAL_PROPAGATORS;
}

function restoreAppEnvironment(): void {
  if (ORIGINAL_APP_ENV === undefined) delete process.env.DBX_TOOLS_DATABRICKS_APP_ENV;
  else process.env.DBX_TOOLS_DATABRICKS_APP_ENV = ORIGINAL_APP_ENV;
}

describe("chat trace topology", () => {
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider;
  let tracer: Tracer;

  before(() => {
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    tracer = provider.getTracer("appkit-mastra-trace-test");
  });

  beforeEach(() => {
    exporter.reset();
    delete process.env.OTEL_PROPAGATORS;
    process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "false";
    restorePropagator();
  });

  afterEach(() => {
    restorePropagatorsEnvironment();
    restoreAppEnvironment();
  });

  after(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
    restorePropagatorsEnvironment();
  });

  it("uses the HTTP RPC span instead of an active Express child", () => {
    const root = tracer.startSpan("POST /api/mastra/chat/support");
    const rootContext = trace.setSpan(ROOT_CONTEXT, root);
    const expressChild = tracer.startSpan("express middleware", undefined, rootContext);
    const rpcContext = setRPCMetadata(trace.setSpan(rootContext, expressChild), {
      type: RPCType.HTTP,
      span: root,
    });
    assert.equal(getRPCMetadata(rpcContext)?.span, root);

    const response = createResponse();
    const chatRequest = request(
      "/chat/support",
      [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      {
        headers: {
          "x-forwarded-email": "ada@example.com",
          "x-mastra-thread-id": "thread-1",
        },
      },
    );
    injectRequestTags(chatRequest, { tunnel: "portr", tunnel_subdomain: "demo" });
    context.with(rpcContext, () => {
      chatTurnTelemetryMiddleware(
        chatRequest as never,
        response as never,
        () => {
          assert.equal(trace.getActiveSpan(), root);
          recordActiveTraceModel("model-a");
          recordActiveTraceModel("model-a");
          recordActiveTraceModel("model-b");
          recordActiveTraceAuth("obo");
          recordActiveTraceTag("custom_tag", "custom-value");
          recordActiveTraceTags({ numeric_tag: 2, boolean_tag: true, skipped_tag: undefined });
          const genieSpan = tracer.startSpan("ask_genie", undefined, context.active());
          stampGenieToolSpan(genieSpan);
          genieSpan.end();
          endChildSpans(tracer, ["invoke_agent support", "model", "tool", "memory", "processor"]);
          response.write(
            'data: {"type":"data-genie-progress","data":{"event":{"type":"started"}}}\n\n',
          );
          response.write('data: {"type":"text-delta","delta":"root answer"}\n\n');
          response.end();
        },
        { identity: () => "service-principal" },
      );
    });
    expressChild.end();
    root.end();

    const spans = exporter.getFinishedSpans();
    const exportedRoot = spans.find((span) => span.name === "POST /api/mastra/chat/support");
    assert.ok(exportedRoot);
    assert.equal(exportedRoot.attributes[MLFLOW_SPAN_OUTPUTS_ATTR], "root answer");
    assert.equal(exportedRoot.attributes[MLFLOW_SPAN_INPUTS_ATTR], "hello");
    assert.match(String(exportedRoot.attributes[CHAT_MESSAGES_ATTR]), /hello/);
    assert.match(String(exportedRoot.attributes[CHAT_RESPONSE_ATTR]), /root answer/);
    assert.equal(exportedRoot.attributes[CHAT_IDENTITY_ATTR], "service-principal");
    assert.equal(exportedRoot.attributes[CHAT_GENIE_USED_ATTR], true);
    assert.equal(exportedRoot.attributes[MLFLOW_USER_ATTR], "ada@example.com");
    assert.equal(exportedRoot.attributes[MLFLOW_SESSION_ATTR], "thread-1");
    assert.equal(exportedRoot.attributes[MLFLOW_SPAN_TYPE_ATTR], MLFLOW_SPAN_TYPE_AGENT);
    assert.equal(exportedRoot.attributes[GEN_AI_OPERATION_NAME_ATTR], "invoke_agent");
    assert.equal(exportedRoot.attributes[MLFLOW_AGENT_TAG_ATTR], "true");
    assert.equal(exportedRoot.attributes[MLFLOW_GENIE_TAG_ATTR], "true");
    assert.equal(exportedRoot.attributes[MLFLOW_MODEL_TAG_ATTR], '["model-a","model-b"]');
    assert.equal(exportedRoot.attributes[MLFLOW_OBO_AUTH_TAG_ATTR], "true");
    assert.equal(exportedRoot.attributes[MLFLOW_SP_AUTH_TAG_ATTR], "true");
    assert.equal(exportedRoot.attributes[MLFLOW_LOCAL_TAG_ATTR], "true");
    assert.equal(exportedRoot.attributes["mlflow.traceTag.custom_tag"], "custom-value");
    assert.equal(exportedRoot.attributes["mlflow.traceTag.numeric_tag"], "2");
    assert.equal(exportedRoot.attributes["mlflow.traceTag.boolean_tag"], "true");
    assert.equal(exportedRoot.attributes["mlflow.traceTag.skipped_tag"], undefined);
    assert.equal(exportedRoot.attributes["mlflow.traceTag.tunnel"], "portr");
    assert.equal(exportedRoot.attributes["mlflow.traceTag.tunnel_subdomain"], "demo");
    const exportedGenie = spans.find((span) => span.name === "ask_genie");
    assert.ok(exportedGenie);
    assert.equal(exportedGenie.attributes[MLFLOW_SPAN_TYPE_ATTR], MLFLOW_SPAN_TYPE_GENIE);
    assert.equal(exportedGenie.attributes[MLFLOW_GENIE_TAG_ATTR], "true");
    assert.equal(spans.filter((span) => span.parentSpanContext === undefined).length, 1);
    assert.equal(
      spans.some((span) => span.name === "mastra.chat_turn"),
      false,
    );
    assert.equal(
      spans.every((span) => span.spanContext().traceId === exportedRoot.spanContext().traceId),
      true,
    );
    assert.equal(
      response.headers[feedback.MLFLOW_TRACE_ID_HEADER],
      `tr-${exportedRoot.spanContext().traceId}`,
    );
  });

  it("creates one local root and blocks propagation when configured with none", () => {
    process.env.OTEL_PROPAGATORS = " NoNe ";
    assert.equal(configureOtelPropagation(), true);
    const extracted = propagation.extract(ROOT_CONTEXT, {
      traceparent: INCOMING_TRACEPARENT,
    });
    assert.equal(trace.getSpanContext(extracted), undefined);

    const response = createResponse();
    const downstream: Record<string, string> = {};
    context.with(extracted, () => {
      chatTurnTelemetryMiddleware(
        request("/agents/support/stream", [{ role: "user", content: "stream this" }]) as never,
        response as never,
        () => {
          recordActiveTraceModel("model-local");
          recordActiveTraceUser("local-user@example.com");
          endChildSpans(tracer, ["invoke_agent support", "model", "tool", "memory", "processor"]);
          propagation.inject(context.active(), downstream);
          const payload = Buffer.from(
            [
              'data: {"type":"text-delta","payload":{"text":"Hello "}}',
              'data: {"type":"text-delta","delta":"€"}',
              "",
            ].join("\n"),
          );
          const split = payload.indexOf(Buffer.from("€")) + 1;
          response.write(payload.subarray(0, split));
          response.write(payload.subarray(split));
          response.end();
        },
        { identity: "obo" },
      );
    });

    const spans = exporter.getFinishedSpans();
    const roots = spans.filter((span) => span.parentSpanContext === undefined);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.name, "mastra.chat_turn");
    assert.equal(roots[0]?.attributes[MLFLOW_SPAN_OUTPUTS_ATTR], "Hello €");
    assert.equal(roots[0]?.attributes[MLFLOW_SPAN_INPUTS_ATTR], "stream this");
    assert.match(String(roots[0]?.attributes[CHAT_MESSAGES_ATTR]), /stream this/);
    assert.match(String(roots[0]?.attributes[CHAT_RESPONSE_ATTR]), /Hello/);
    assert.equal(roots[0]?.attributes[CHAT_IDENTITY_ATTR], "obo");
    assert.equal(roots[0]?.attributes[CHAT_GENIE_USED_ATTR], false);
    assert.equal(roots[0]?.attributes[MLFLOW_GENIE_TAG_ATTR], undefined);
    assert.equal(roots[0]?.attributes[MLFLOW_USER_ATTR], "local-user@example.com");
    assert.equal(roots[0]?.attributes[MLFLOW_MODEL_TAG_ATTR], "model-local");
    assert.equal(roots[0]?.attributes[MLFLOW_OBO_AUTH_TAG_ATTR], "true");
    assert.equal(roots[0]?.attributes[MLFLOW_SP_AUTH_TAG_ATTR], undefined);
    assert.equal(roots[0]?.attributes[MLFLOW_LOCAL_TAG_ATTR], "true");
    assert.equal(roots[0]?.attributes[MLFLOW_SPAN_TYPE_ATTR], MLFLOW_SPAN_TYPE_AGENT);
    assert.equal(roots[0]?.attributes[MLFLOW_AGENT_TAG_ATTR], "true");
    assert.equal(
      spans.every((span) => span.spanContext().traceId === roots[0]?.spanContext().traceId),
      true,
    );
    assert.deepEqual(downstream, {});
    assert.equal(
      response.headers[feedback.MLFLOW_TRACE_ID_HEADER],
      `tr-${roots[0]?.spanContext().traceId}`,
    );
  });

  it("retains W3C parentage and injection when propagation is enabled", () => {
    process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "true";
    assert.equal(configureOtelPropagation(), false);
    const extracted = propagation.extract(ROOT_CONTEXT, {
      traceparent: INCOMING_TRACEPARENT,
    });
    assert.equal(trace.getSpanContext(extracted)?.traceId, INCOMING_TRACE_ID);

    const response = createResponse();
    const downstream: Record<string, string> = {};
    context.with(extracted, () => {
      chatTurnTelemetryMiddleware(
        request("/agents/support/generate", [{ role: "user", content: "generate this" }]) as never,
        response as never,
        () => {
          propagation.inject(context.active(), downstream);
          response.json({ text: "generated answer" });
        },
      );
    });

    const [span] = exporter.getFinishedSpans();
    assert.ok(span);
    assert.equal(span.name, "mastra.chat_turn");
    assert.equal(span.spanContext().traceId, INCOMING_TRACE_ID);
    assert.equal(span.parentSpanContext?.spanId, INCOMING_SPAN_ID);
    assert.equal(span.attributes[MLFLOW_SPAN_OUTPUTS_ATTR], "generated answer");
    assert.equal(span.attributes[MLFLOW_SPAN_INPUTS_ATTR], "generate this");
    assert.equal(span.attributes[MLFLOW_LOCAL_TAG_ATTR], undefined);
    assert.match(String(span.attributes[CHAT_MESSAGES_ATTR]), /generate this/);
    assert.match(String(span.attributes[CHAT_RESPONSE_ATTR]), /generated answer/);
    assert.equal(exporter.getFinishedSpans().filter((item) => !item.parentSpanContext).length, 0);
    assert.match(downstream.traceparent ?? "", new RegExp(`^00-${INCOMING_TRACE_ID}-`));
  });
});
