/**
 * Foreground model-gateway server owned by the CLI package.
 *
 * @module
 */

import { createApp, server } from "@databricks/appkit";
import { modelGateway } from "@dbx-tools/appkit-model-gateway/plugin";
import { sendHealth } from "@dbx-tools/appkit-model-gateway/routes";
import { workspaceClient } from "@dbx-tools/databricks";
import {
  resolveModelGatewayOptions,
  type ModelGatewayOptions,
  type ResolvedModelGatewayOptions,
} from "@dbx-tools/shared-model-gateway/options";

type AppKitServerOptions = NonNullable<Parameters<typeof server>[0]>;

/** Resolve AppKit server settings for the loopback model gateway. */
export function modelGatewayServerOptions(options: ModelGatewayOptions = {}): AppKitServerOptions {
  return appKitServerOptions(resolveModelGatewayOptions(options));
}

function appKitServerOptions(options: ResolvedModelGatewayOptions): AppKitServerOptions {
  return {
    bodyLimit: options.bodyLimit,
    host: options.listen.host,
    port: options.listen.port,
  };
}

/** Start the foreground model gateway and keep its AppKit server active. */
export async function startModelGateway(options: ModelGatewayOptions = {}): Promise<void> {
  const resolved = resolveModelGatewayOptions(options);
  const client = await workspaceClient.createWorkspaceClient({
    ...(resolved.profile ? { profile: resolved.profile } : {}),
  });
  await createApp({
    client,
    plugins: [modelGateway(), server(appKitServerOptions(resolved))],
    onPluginsReady(appkit) {
      appkit.server.extend((application) => {
        application.get("/api/healthz", (_request, response) => {
          sendHealth(response);
        });
        application.get("/v1/models", (request, response) => {
          void appkit.modelGateway.models(request, response);
        });
        for (const [path, protocol] of [
          ["/v1/chat/completions", "openai-chat"],
          ["/v1/responses", "openai-responses"],
          ["/v1/messages", "anthropic-messages"],
          ["/v1/embeddings", "openai-embeddings"],
        ] as const) {
          application.post(path, (request, response) => {
            void appkit.modelGateway.inference(protocol, request, response);
          });
        }
      });
    },
  });
}
