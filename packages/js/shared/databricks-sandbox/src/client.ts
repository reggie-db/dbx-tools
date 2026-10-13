import { z } from "zod";

/** AppKit plugin name used to publish and read the Sandbox browser client config. */
export const SSH_PLUGIN_NAME = "databricks-sandbox";

/** Default AppKit mount path for the Sandbox plugin. */
export const SSH_DEFAULT_BASE_PATH = `/api/${SSH_PLUGIN_NAME}`;

/** Shared server route templates owned by the Sandbox plugin contract. */
export const SSH_ROUTES = {
  machines: "/machines",
  machine: "/machines/:machineId",
  machineStart: "/machines/:machineId/start",
  machineStop: "/machines/:machineId/stop",
  machineCommands: "/machines/:machineId/commands",
  machineServiceLogs: "/machines/:machineId/services/:service/logs",
  machineServiceStart: "/machines/:machineId/services/:service/start",
  projects: "/projects",
  project: "/projects/:projectId",
  projectTerminal: "/projects/:projectId/terminal",
  projectReset: "/projects/:projectId/reset",
} as const;

/** Browser-safe configuration published by the Sandbox AppKit plugin. */
export const SshClientConfigSchema = z
  .object({
    basePath: z
      .string()
      .startsWith("/")
      .default(SSH_DEFAULT_BASE_PATH)
      .describe("AppKit mount path for Sandbox API routes."),
    routePrefix: z.string().startsWith("/").describe("Owner-scoped prefix for routed services."),
  })
  .strict()
  .describe("Sandbox plugin browser client configuration.");
export type SshClientConfig = z.infer<typeof SshClientConfigSchema>;
export type SshClientConfigInput = z.input<typeof SshClientConfigSchema>;

/** Replace one named route parameter with an encoded browser-safe value. */
export const sshRoute = (
  template: string,
  parameters: Readonly<Record<string, string>> = {},
): string =>
  Object.entries(parameters).reduce(
    (route, [name, value]) => route.replace(`:${name}`, encodeURIComponent(value)),
    template,
  );
