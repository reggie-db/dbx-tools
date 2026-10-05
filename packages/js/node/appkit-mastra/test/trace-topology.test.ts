import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

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
  chatTurnTraceIoMiddleware,
  MLFLOW_SPAN_INPUTS_ATTR,
  MLFLOW_SPAN_OUTPUTS_ATTR,
} from "../src/trace-io.ts";

const INCOMING_TRACE_ID = "0123456789abcdef0123456789abcdef";
const INCOMING_SPAN_ID = "0123456789abcdef";
const INCOMING_TRACEPARENT = `00-${INCOMING_TRACE_ID}-${INCOMING_SPAN_ID}-01`;
const ORIGINAL_PROPAGATORS = process.env.OTEL_PROPAGATORS;

interface TestResponse {
  write(chunk: unknown): boolean;
  end(chunk?: unknown): TestResponse;
  json(body?: unknown): TestResponse;
  once(event: string, listener: () => void): TestResponse;
}

function createResponse(): TestResponse {
  const closeListeners: (() => void)[] = [];
  const response: TestResponse = {
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

function request(path: string, messages: unknown): Record<string, unknown> {
  return {
    method: "POST",
    path,
    body: { messages },
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
    restorePropagator();
  });

  afterEach(() => {
    restorePropagatorsEnvironment();
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
    context.with(rpcContext, () => {
      chatTurnTraceIoMiddleware(
        request("/chat/support", [
          { role: "user", parts: [{ type: "text", text: "hello" }] },
        ]) as never,
        response as never,
        () => {
          assert.equal(trace.getActiveSpan(), root);
          endChildSpans(tracer, ["invoke_agent support", "model", "tool", "memory", "processor"]);
          response.write('data: {"type":"text-delta","delta":"root answer"}\n\n');
          response.end();
        },
      );
    });
    expressChild.end();
    root.end();

    const spans = exporter.getFinishedSpans();
    const exportedRoot = spans.find((span) => span.name === "POST /api/mastra/chat/support");
    assert.ok(exportedRoot);
    assert.equal(exportedRoot.attributes[MLFLOW_SPAN_OUTPUTS_ATTR], "root answer");
    assert.match(String(exportedRoot.attributes[MLFLOW_SPAN_INPUTS_ATTR]), /hello/);
    assert.equal(spans.filter((span) => span.parentSpanContext === undefined).length, 1);
    assert.equal(
      spans.some((span) => span.name === "mastra.chat_turn"),
      false,
    );
    assert.equal(
      spans.every((span) => span.spanContext().traceId === exportedRoot.spanContext().traceId),
      true,
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
      chatTurnTraceIoMiddleware(
        request("/agents/support/stream", [{ role: "user", content: "stream this" }]) as never,
        response as never,
        () => {
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
      );
    });

    const spans = exporter.getFinishedSpans();
    const roots = spans.filter((span) => span.parentSpanContext === undefined);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.name, "mastra.chat_turn");
    assert.equal(roots[0]?.attributes[MLFLOW_SPAN_OUTPUTS_ATTR], "Hello €");
    assert.match(String(roots[0]?.attributes[MLFLOW_SPAN_INPUTS_ATTR]), /stream this/);
    assert.equal(
      spans.every((span) => span.spanContext().traceId === roots[0]?.spanContext().traceId),
      true,
    );
    assert.deepEqual(downstream, {});
  });

  it("retains W3C parentage and injection when propagation is enabled", () => {
    assert.equal(configureOtelPropagation(), false);
    const extracted = propagation.extract(ROOT_CONTEXT, {
      traceparent: INCOMING_TRACEPARENT,
    });
    assert.equal(trace.getSpanContext(extracted)?.traceId, INCOMING_TRACE_ID);

    const response = createResponse();
    const downstream: Record<string, string> = {};
    context.with(extracted, () => {
      chatTurnTraceIoMiddleware(
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
    assert.match(String(span.attributes[MLFLOW_SPAN_INPUTS_ATTR]), /generate this/);
    assert.equal(exporter.getFinishedSpans().filter((item) => !item.parentSpanContext).length, 0);
    assert.match(downstream.traceparent ?? "", new RegExp(`^00-${INCOMING_TRACE_ID}-`));
  });
});
