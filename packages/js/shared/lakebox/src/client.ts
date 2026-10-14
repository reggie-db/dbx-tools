import { z } from "zod";

/** AppKit plugin name used to publish and read the Lakebox browser client config. */
export const LAKEBOX_PLUGIN_NAME = "lakebox";

/** Default AppKit mount path for the Lakebox plugin API. */
export const LAKEBOX_DEFAULT_BASE_PATH = `/api/${LAKEBOX_PLUGIN_NAME}`;

/** Default AppKit root path for user-scoped Lakebox service routes. */
export const LAKEBOX_DEFAULT_ROUTE_PREFIX = "/lakebox";

/** Shared server route templates owned by the Lakebox plugin contract. */
export const LAKEBOX_ROUTES = {
  status: "/status",
  start: "/start",
  stop: "/stop",
  commands: "/commands",
  services: "/services",
  service: "/services/:name",
  serviceStart: "/services/:name/start",
  serviceStop: "/services/:name/stop",
  serviceLogs: "/services/:name/logs",
  metrics: "/metrics",
  metricsStream: "/metrics/stream",
} as const;

/** Browser-safe configuration published by the Lakebox AppKit plugin. */
export const LakeboxClientConfigSchema = z
  .object({
    basePath: z
      .string()
      .startsWith("/")
      .default(LAKEBOX_DEFAULT_BASE_PATH)
      .describe("AppKit mount path for Lakebox API routes."),
    routePrefix: z
      .string()
      .startsWith("/")
      .default(LAKEBOX_DEFAULT_ROUTE_PREFIX)
      .describe("AppKit root path beneath which each user's services are routed."),
  })
  .strict()
  .describe("Lakebox plugin browser client configuration.");
export type LakeboxClientConfig = z.infer<typeof LakeboxClientConfigSchema>;
export type LakeboxClientConfigInput = z.input<typeof LakeboxClientConfigSchema>;

/** Replace named route parameters with encoded browser-safe values. */
export const lakeboxRoute = (
  template: string,
  parameters: Readonly<Record<string, string>> = {},
): string =>
  Object.entries(parameters).reduce(
    (route, [name, value]) => route.replace(`:${name}`, encodeURIComponent(value)),
    template,
  );

/**
 * Returns the AppKit route for one user's service.
 *
 * The user hash is the only routing key: the server derives the service port
 * from the same hash and service name, so no path or port mapping is stored.
 */
export function lakeboxServicePath(routePrefix: string, userHash: string, name: string): string {
  return `${routePrefix.replace(/\/+$/, "")}/${userHash}/${name}`;
}
