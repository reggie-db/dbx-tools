/**
 * AppKit model-gateway plugin.
 *
 * @module
 */

import {
  defineManifest,
  Plugin,
  toPlugin,
  type BasePluginConfig,
  type IAppRouter,
} from "@databricks/appkit";
import type { ClientProtocol } from "@dbx-tools/shared-model-gateway";
import type express from "express";

import { ModelGateway, type ModelGatewayOptions } from "./gateway.ts";
import manifest from "./manifest.json" with { type: "json" };
import { sendHealth, sendInference, sendModels } from "./routes.ts";

/** AppKit configuration for the model-gateway plugin. */
export interface ModelGatewayPluginConfig extends BasePluginConfig, ModelGatewayOptions {}

/** AppKit plugin exposing dynamic model discovery and compatibility routes. */
export class ModelGatewayPlugin extends Plugin<ModelGatewayPluginConfig> {
  static manifest = defineManifest<"modelGateway">(manifest);

  private readonly gateway: ModelGateway;

  constructor(config: ModelGatewayPluginConfig = {}) {
    super(config);
    this.gateway = new ModelGateway({
      ...(config.cacheTtlMs !== undefined ? { cacheTtlMs: config.cacheTtlMs } : {}),
      ...(config.overrides ? { overrides: config.overrides } : {}),
    });
  }

  override injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "health",
      method: "get",
      path: "/healthz",
      handler: async (_request, response) => sendHealth(response),
    });
    this.route(router, {
      name: "models",
      method: "get",
      path: "/v1/models",
      handler: (request, response) => this.models(request, response),
    });
    for (const [name, path, protocol] of [
      ["chatCompletions", "/v1/chat/completions", "openai-chat"],
      ["responses", "/v1/responses", "openai-responses"],
      ["messages", "/v1/messages", "anthropic-messages"],
      ["embeddings", "/v1/embeddings", "openai-embeddings"],
    ] as const) {
      this.route(router, {
        name,
        method: "post",
        path,
        handler: (request, response) => this.inference(protocol, request, response),
      });
    }
  }

  /** Send the active principal's model catalogue. */
  async models(request: express.Request, response: express.Response): Promise<void> {
    await sendModels(this.gateway, request, response);
  }

  /** Execute one compatibility request in the active AppKit identity scope. */
  async inference(
    protocol: ClientProtocol,
    request: express.Request,
    response: express.Response,
  ): Promise<void> {
    await sendInference(this.gateway, protocol, request, response);
  }

  /** Refresh the active principal's model catalogue. */
  async refresh(): Promise<void> {
    await this.gateway.refresh();
  }

  override exports() {
    return {
      models: this.models,
      inference: this.inference,
      refresh: this.refresh,
    };
  }
}

/** AppKit plugin factory for the Databricks model gateway. */
export const modelGateway = toPlugin(ModelGatewayPlugin);
