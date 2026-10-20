import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import type { Span, TracerProvider } from "@opentelemetry/api";

import {
  configureNativeHttpTelemetry,
  deferredNativeTracerProvider,
  excludeHttpTelemetryRequest,
  excludeUnparentedOutgoingHttpTelemetry,
  stampHttpTraceUser,
  USER_TRACE_ATTRIBUTE,
} from "../src/telemetry.ts";

function request(url: string, method = "GET"): IncomingMessage {
  return { method, url } as IncomingMessage;
}

describe("AppKit HTTP telemetry", () => {
  it("excludes HEAD requests by default", () => {
    assert.equal(excludeHttpTelemetryRequest(request("/", "HEAD")), true);
    assert.equal(excludeHttpTelemetryRequest(request("/api/chat")), false);
  });

  it("supports exact and prefix exclusions without matching sibling paths", () => {
    const options = { exclude: ["/healthz", "/sandbox/*"] } as const;

    assert.equal(excludeHttpTelemetryRequest(request("/healthz?full=true"), options), true);
    assert.equal(excludeHttpTelemetryRequest(request("/sandbox/service/socket"), options), true);
    assert.equal(excludeHttpTelemetryRequest(request("/sandbox"), options), false);
    assert.equal(excludeHttpTelemetryRequest(request("/sandboxes/service"), options), false);
    assert.equal(excludeHttpTelemetryRequest(request("/api/chat"), options), false);
  });

  it("combines path exclusions with a caller-owned filter", () => {
    assert.equal(
      excludeHttpTelemetryRequest(request("/events"), {
        filter: (incoming) => incoming.headers?.upgrade === "websocket",
      }),
      false,
    );
    assert.equal(
      excludeHttpTelemetryRequest(
        { url: "/events", headers: { upgrade: "websocket" } } as IncomingMessage,
        { filter: (incoming) => incoming.headers.upgrade === "websocket" },
      ),
      true,
    );
  });

  it("stamps forwarded email or user id onto native request spans", () => {
    const attributes = new Map<string, unknown>();
    const span = {
      setAttribute(name: string, value: unknown) {
        attributes.set(name, value);
        return span;
      },
    } as Span;

    stampHttpTraceUser(span, {
      headers: {
        "x-forwarded-user": "user-1",
        "x-forwarded-email": "ada@example.com",
      },
    });
    assert.equal(attributes.get(USER_TRACE_ATTRIBUTE), "ada@example.com");

    attributes.clear();
    stampHttpTraceUser(span, { headers: { "x-forwarded-user": "user-1" } });
    assert.equal(attributes.get(USER_TRACE_ATTRIBUTE), "user-1");
  });

  it("excludes only outgoing requests without a recording parent span", () => {
    assert.equal(excludeUnparentedOutgoingHttpTelemetry(), true);
    const span = { isRecording: () => true } as Span;
    assert.equal(excludeUnparentedOutgoingHttpTelemetry(undefined, span), false);
  });

  it("extends AppKit's native filter without replacing its defaults", async () => {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve("@databricks/appkit/package.json"));
    const moduleUrl = pathToFileURL(
      path.join(packageRoot, "dist", "telemetry", "instrumentations.js"),
    ).href;
    const loaded = (await import(moduleUrl)) as {
      instrumentations: {
        http: {
          getConfig(): {
            ignoreIncomingRequestHook?: (incoming: IncomingMessage) => boolean;
            ignoreOutgoingRequestHook?: (outgoing: unknown) => boolean;
            applyCustomAttributesOnSpan?: (span: Span, request: unknown) => void;
          };
          setConfig(config: Record<string, unknown>): void;
        };
      };
    };
    const instrumentation = loaded.instrumentations.http;
    const original = instrumentation.getConfig();
    try {
      const attributes = new Map<string, unknown>();
      await configureNativeHttpTelemetry({
        exclude: ["/lakebox/*"],
        outgoingFilter: (outgoing) => (outgoing as { path?: string }).path === "/telemetry-ext",
        spanHook: (span) => span.setAttribute("test.user", "ada"),
      });
      const filter = instrumentation.getConfig().ignoreIncomingRequestHook;
      const outgoingFilter = instrumentation.getConfig().ignoreOutgoingRequestHook;
      const spanHook = instrumentation.getConfig().applyCustomAttributesOnSpan;
      assert.ok(filter);
      assert.ok(outgoingFilter);
      assert.ok(spanHook);
      assert.equal(filter(request("/health")), true);
      assert.equal(filter(request("/", "HEAD")), true);
      assert.equal(filter(request("/lakebox/user/service")), true);
      assert.equal(filter(request("/api/mastra/chat/support")), false);
      assert.equal(outgoingFilter({ path: "/telemetry-ext" }), true);
      assert.equal(outgoingFilter({ path: "/api/2.0/serving-endpoints" }), false);
      spanHook(
        {
          updateName() {
            return this;
          },
          setAttribute(name: string, value: unknown) {
            attributes.set(name, value);
            return this;
          },
        } as Span,
        request("/api/chat"),
      );
      assert.equal(attributes.get("test.user"), "ada");
    } finally {
      instrumentation.setConfig(original);
    }
  });

  it("resolves AppKit's tracer provider when a tracer method is invoked", async () => {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve("@databricks/appkit/package.json"));
    const moduleUrl = pathToFileURL(
      path.join(packageRoot, "dist", "telemetry", "telemetry-manager.js"),
    ).href;
    const loaded = (await import(moduleUrl)) as {
      TelemetryManager: {
        getInstance(): { tracerProvider?: TracerProvider };
      };
    };
    const manager = loaded.TelemetryManager.getInstance();
    const original = manager.tracerProvider;
    const expected = {} as Span;
    try {
      const provider = await deferredNativeTracerProvider();
      const tracer = provider.getTracer("test");
      manager.tracerProvider = {
        getTracer: () => ({ startSpan: () => expected }) as never,
      };
      assert.equal(tracer.startSpan("span"), expected);
    } finally {
      manager.tracerProvider = original;
    }
  });
});
