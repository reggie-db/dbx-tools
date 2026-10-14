/** AppKit telemetry helpers and custom instrumentation registration. */

import type { IncomingMessage } from "node:http";

import {
  Plugin,
  toPlugin,
  type BasePluginConfig,
  type PluginManifest,
  type TelemetryConfig,
} from "@databricks/appkit";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";

type AppKitInstrumentation = NonNullable<TelemetryConfig["instrumentations"]>[number];

/** Options for AppKit HTTP request tracing. */
export interface HttpTelemetryOptions {
  /**
   * Request paths to exclude. A trailing `*` matches every path with that
   * prefix; other values are exact path matches. Query strings are ignored.
   */
  readonly exclude?: readonly string[];
  /** Additional caller-owned request filter. Returning `true` excludes the request. */
  readonly filter?: (request: IncomingMessage) => boolean;
}

/** Return the request pathname without its query string. */
function requestPath(request: IncomingMessage): string {
  return request.url?.split("?", 1)[0] ?? "";
}

/** Whether one request matches the configured HTTP telemetry exclusions. */
export function excludeHttpTelemetryRequest(
  request: IncomingMessage,
  options: HttpTelemetryOptions = {},
): boolean {
  const path = requestPath(request);
  for (const pattern of options.exclude ?? []) {
    if (pattern.endsWith("*")) {
      if (path.startsWith(pattern.slice(0, -1))) return true;
    } else if (path === pattern) {
      return true;
    }
  }
  return options.filter?.(request) ?? false;
}

/**
 * Build HTTP instrumentation that exports through AppKit's global telemetry
 * provider while allowing application-specific request exclusions.
 *
 * Set `server({ telemetry: false })` when using this helper so AppKit's fixed
 * HTTP instrumentation is not registered in parallel.
 */
export function httpTelemetryInstrumentations(
  options: HttpTelemetryOptions = {},
): AppKitInstrumentation[] {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) => excludeHttpTelemetryRequest(request, options),
    }),
  ];
}

/** Internal configuration for the custom instrumentation bridge plugin. */
export interface TelemetryInstrumentationBridgeConfig extends BasePluginConfig {
  readonly instrumentations?: readonly AppKitInstrumentation[];
}

/** Registers `createApp({ telemetry: { instrumentations } })` with AppKit. */
export class TelemetryInstrumentationBridgePlugin extends Plugin<TelemetryInstrumentationBridgeConfig> {
  static manifest = {
    name: "dbxToolsTelemetryInstrumentationBridge",
    displayName: "Telemetry Instrumentation Bridge",
    description: "Registers application-provided OpenTelemetry instrumentations.",
    stability: "beta",
    hidden: true,
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"dbxToolsTelemetryInstrumentationBridge">;

  override async setup(): Promise<void> {
    if (this.config.instrumentations?.length) {
      this.telemetry.registerInstrumentations([...this.config.instrumentations]);
    }
  }
}

/** Factory for the injected telemetry instrumentation bridge. */
export const telemetryInstrumentationBridge = toPlugin(TelemetryInstrumentationBridgePlugin);
