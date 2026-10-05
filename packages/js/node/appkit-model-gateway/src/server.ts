/**
 * Foreground AppKit model-gateway startup API.
 *
 * @module
 */

import { createApp, server } from "@databricks/appkit";
import { workspaceClient } from "@dbx-tools/databricks";

import { modelGateway } from "./plugin.ts";
import { mountModelGatewayRoutes } from "./routes.ts";

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
        host: options.host ?? "127.0.0.1",
        port: options.port ?? 4400,
      }),
    ],
    onPluginsReady(appkit) {
      appkit.server.extend((application) => {
        mountModelGatewayRoutes(application, appkit.modelGateway);
      });
    },
  });
}
