import {
  Plugin,
  toPlugin,
  type BasePluginConfig,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";
import {
  DEBUG_CAPTURE_PLUGIN_NAME,
  DEBUG_CAPTURE_ROUTE,
  DEBUG_CAPTURE_DEFAULT_BASE_PATH,
  DebugCaptureAppendResponseSchema,
  DebugCaptureClientConfigSchema,
  DebugCaptureRequestSchema,
  DebugCaptureStartResponseSchema,
  DebugCaptureStopResponseSchema,
  type DebugCaptureClientConfig,
} from "@dbx-tools/shared-appkit/debug";

import { DebugCaptureStorage } from "./storage.ts";

/** Configuration for the AppKit browser debug-capture plugin. */
export interface DebugCapturePluginConfig extends BasePluginConfig {
  /** Directory where JSONL captures are written. */
  directory?: string;
}

/** Exports available when the debug-capture plugin is registered explicitly. */
export interface DebugCapturePluginExports {
  /** Directory containing capture JSONL files. */
  directory: string;
  /** Resolve a capture identifier to its JSONL file path. */
  path(captureId: string): string;
}

/** AppKit plugin that receives browser diagnostic event batches. */
export class DebugCapturePlugin extends Plugin<DebugCapturePluginConfig> {
  static manifest = {
    name: DEBUG_CAPTURE_PLUGIN_NAME,
    displayName: "Browser Debug Capture",
    description: "Records bounded browser, viewport, focus, input, and pointer diagnostics.",
    stability: "beta",
    hidden: true,
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<typeof DEBUG_CAPTURE_PLUGIN_NAME>;

  readonly #storage: DebugCaptureStorage;

  constructor(config: DebugCapturePluginConfig = {}) {
    super(config);
    this.#storage = new DebugCaptureStorage(config.directory);
  }

  private get basePath(): string {
    const endpoint = this.getEndpoints().captures;
    return endpoint?.endsWith(DEBUG_CAPTURE_ROUTE)
      ? endpoint.slice(0, -DEBUG_CAPTURE_ROUTE.length)
      : DEBUG_CAPTURE_DEFAULT_BASE_PATH;
  }

  override clientConfig(): DebugCaptureClientConfig {
    return DebugCaptureClientConfigSchema.parse({ basePath: this.basePath });
  }

  override exports(): DebugCapturePluginExports {
    return {
      directory: this.#storage.directory,
      path: (captureId) => this.#storage.path(captureId),
    };
  }

  override injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "captures",
      method: "post",
      path: DEBUG_CAPTURE_ROUTE,
      handler: async (request, response) => {
        response.setHeader("cache-control", "no-store");
        const parsed = DebugCaptureRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({ error: "Invalid debug capture request." });
          return;
        }

        if (parsed.data.action === "start") {
          const captureId = await this.#storage.start({
            ...parsed.data.metadata,
            userAgent: request.header("user-agent")?.slice(0, 500) ?? "unknown",
          });
          response.json(DebugCaptureStartResponseSchema.parse({ captureId }));
          return;
        }

        if (parsed.data.action === "append") {
          await this.#storage.append(parsed.data.captureId, parsed.data.events);
          response.json(DebugCaptureAppendResponseSchema.parse({ ok: true }));
          return;
        }

        await this.#storage.stop(parsed.data.captureId, parsed.data.events);
        response.json(
          DebugCaptureStopResponseSchema.parse({ captureId: parsed.data.captureId, ok: true }),
        );
      },
    });
  }
}

/** AppKit registration factory for {@link DebugCapturePlugin}. */
export const debugCapture = toPlugin(DebugCapturePlugin);
