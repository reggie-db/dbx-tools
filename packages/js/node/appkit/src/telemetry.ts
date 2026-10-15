/** AppKit telemetry compatibility helpers. */

import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Tracer, TracerOptions, TracerProvider } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

type IncomingRequestFilter = (request: IncomingMessage) => boolean;

interface NativeHttpInstrumentationConfig {
  readonly enabled?: boolean;
  readonly ignoreIncomingRequestHook?: IncomingRequestFilter;
  readonly [key: string]: unknown;
}

interface NativeInstrumentation {
  setTracerProvider?(provider: TracerProvider): void;
}

interface NativeHttpInstrumentation extends NativeInstrumentation {
  getConfig(): NativeHttpInstrumentationConfig;
  setConfig(config: NativeHttpInstrumentationConfig): void;
}

interface NativeTelemetryManager {
  tracerProvider?: TracerProvider;
}

interface NativeTelemetryManagerClass {
  getInstance(): NativeTelemetryManager;
  registerSpanProcessor(processor: SpanProcessor): void;
}

/** Options for AppKit's native HTTP request tracing. */
export interface NativeHttpTelemetryOptions {
  /**
   * Request paths to exclude. A trailing `*` matches every path with that
   * prefix; other values are exact path matches. Query strings are ignored.
   */
  readonly exclude?: readonly string[];
  /** Additional caller-owned request filter. Returning `true` excludes the request. */
  readonly filter?: IncomingRequestFilter;
}

/** Return the request pathname without its query string. */
function requestPath(request: IncomingMessage): string {
  return request.url?.split("?", 1)[0] ?? "";
}

/** Whether one request matches the default or configured HTTP telemetry exclusions. */
export function excludeHttpTelemetryRequest(
  request: IncomingMessage,
  options: NativeHttpTelemetryOptions = {},
): boolean {
  if (request.method === "HEAD") return true;
  const pathname = requestPath(request);
  for (const pattern of options.exclude ?? []) {
    if (pattern.endsWith("*")) {
      if (pathname.startsWith(pattern.slice(0, -1))) return true;
    } else if (pathname === pattern) {
      return true;
    }
  }
  return options.filter?.(request) ?? false;
}

function appKitInternalModuleUrl(relativePath: string): string {
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(require.resolve("@databricks/appkit/package.json"));
  return pathToFileURL(path.join(packageRoot, "dist", ...relativePath.split("/"))).href;
}

function isNativeHttpInstrumentation(value: unknown): value is NativeHttpInstrumentation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NativeHttpInstrumentation>;
  return typeof candidate.getConfig === "function" && typeof candidate.setConfig === "function";
}

async function nativeInstrumentations(): Promise<Record<string, NativeInstrumentation>> {
  const loaded = (await import(appKitInternalModuleUrl("telemetry/instrumentations.js"))) as {
    instrumentations?: Record<string, NativeInstrumentation>;
  };
  if (!loaded.instrumentations) {
    throw new Error("@databricks/appkit no longer exposes its native instrumentations");
  }
  return loaded.instrumentations;
}

async function nativeHttpInstrumentation(): Promise<NativeHttpInstrumentation> {
  const instrumentation = (await nativeInstrumentations()).http;
  if (!isNativeHttpInstrumentation(instrumentation)) {
    throw new Error(
      "@databricks/appkit no longer exposes the expected native HTTP telemetry instrumentation",
    );
  }
  return instrumentation;
}

async function nativeTelemetryManagerClass(): Promise<NativeTelemetryManagerClass> {
  const loaded = (await import(appKitInternalModuleUrl("telemetry/telemetry-manager.js"))) as {
    TelemetryManager?: NativeTelemetryManagerClass;
  };
  if (!loaded.TelemetryManager) {
    throw new Error("@databricks/appkit no longer exposes its native telemetry manager");
  }
  return loaded.TelemetryManager;
}

async function nativeTelemetryManager(): Promise<NativeTelemetryManager> {
  return (await nativeTelemetryManagerClass()).getInstance();
}

function requireNativeTracerProvider(manager: NativeTelemetryManager): TracerProvider {
  if (!manager.tracerProvider) {
    throw new Error("AppKit's native tracer provider has not started");
  }
  return manager.tracerProvider;
}

/**
 * Extend AppKit's native HTTP request filter without registering a second HTTP
 * instrumentation. AppKit 0.81 owns the instrumentation but does not expose a
 * public filter option, so this compatibility hook mutates its existing
 * singleton before `createApp()` registers it.
 */
export async function configureNativeHttpTelemetry(
  options: NativeHttpTelemetryOptions = {},
): Promise<void> {
  const instrumentation = await nativeHttpInstrumentation();
  const config = instrumentation.getConfig();
  const appKitFilter = config.ignoreIncomingRequestHook;
  instrumentation.setConfig({
    ...config,
    ignoreIncomingRequestHook: (request) =>
      Boolean(appKitFilter?.(request)) || excludeHttpTelemetryRequest(request, options),
  });
}

/**
 * Bind AppKit's native instrumentations to the provider AppKit started. This is
 * called after AppKit's deferred `TelemetryManager.start()` phase so a runtime
 * that already occupied the global OTel slot cannot leave native spans no-op.
 */
export async function bindNativeTelemetryProvider(): Promise<boolean> {
  const manager = await nativeTelemetryManager();
  if (!manager.tracerProvider) return false;
  for (const instrumentation of Object.values(await nativeInstrumentations())) {
    instrumentation.setTracerProvider?.(manager.tracerProvider);
  }
  return true;
}

/** Contribute a processor before AppKit builds its native tracer provider. */
export async function registerNativeSpanProcessor(processor: SpanProcessor): Promise<void> {
  (await nativeTelemetryManagerClass()).registerSpanProcessor(processor);
}

/**
 * Return a tracer provider that resolves AppKit's provider when a tracer method
 * is invoked. AppKit starts its provider after plugin setup, while consumers
 * such as Mastra construct their OTel bridge during setup.
 */
export async function deferredNativeTracerProvider(): Promise<TracerProvider> {
  const manager = await nativeTelemetryManager();
  return {
    getTracer(name: string, version?: string, options?: TracerOptions): Tracer {
      return new Proxy({} as Tracer, {
        get(_target, property) {
          const tracer = requireNativeTracerProvider(manager).getTracer(name, version, options);
          const value = Reflect.get(tracer, property, tracer) as unknown;
          return typeof value === "function" ? value.bind(tracer) : value;
        },
      });
    },
  };
}
