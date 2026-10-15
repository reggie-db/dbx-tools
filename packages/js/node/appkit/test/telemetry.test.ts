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
          };
          setConfig(config: Record<string, unknown>): void;
        };
      };
    };
    const instrumentation = loaded.instrumentations.http;
    const original = instrumentation.getConfig();
    try {
      await configureNativeHttpTelemetry({ exclude: ["/lakebox/*"] });
      const filter = instrumentation.getConfig().ignoreIncomingRequestHook;
      assert.ok(filter);
      assert.equal(filter(request("/health")), true);
      assert.equal(filter(request("/", "HEAD")), true);
      assert.equal(filter(request("/lakebox/user/service")), true);
      assert.equal(filter(request("/api/mastra/chat/support")), false);
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
