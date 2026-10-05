/**
 * Foreground model-gateway server owned by the CLI package.
 *
 * @module
 */

import { createApp, server } from "@databricks/appkit";
import { modelGateway } from "@dbx-tools/appkit-model-gateway/plugin";
import { sendHealth } from "@dbx-tools/appkit-model-gateway/routes";
import { workspaceClient } from "@dbx-tools/databricks";

import { DEFAULT_HOST, DEFAULT_PORT } from "./defaults.ts";

export { DEFAULT_HOST, DEFAULT_PORT } from "./defaults.ts";

/** Foreground model-gateway server options. */
export interface StartModelGatewayOptions {
  readonly host?: string;
  readonly port?: number;
  readonly profile?: string;
}

/** Start the foreground model gateway and keep its AppKit server active. */
export async function startModelGateway(options: StartModelGatewayOptions = {}): Promise<void> {
  const client = await workspaceClient.createWorkspaceClient({
    ...(options.profile ? { profile: options.profile } : {}),
  });
  await createApp({
    client,
    plugins: [
      modelGateway(),
      server({
        host: options.host ?? DEFAULT_HOST,
        port: options.port ?? DEFAULT_PORT,
      }),
    ],
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
