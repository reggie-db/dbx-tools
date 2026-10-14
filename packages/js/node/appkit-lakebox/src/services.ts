import {
  createLakeboxServiceRequestSchema,
  lakeboxServiceKindSchema,
  lakeboxServiceStateSchema,
  type CreateLakeboxServiceRequest,
  type LakeboxBuiltInServiceName,
  type LakeboxService,
  type LakeboxUser,
} from "@dbx-tools/shared-lakebox";
import { lakeboxServicePath } from "@dbx-tools/shared-lakebox/client";
import { z } from "zod";
import { desktopEnvironment, desktopHtmlHead, desktopOpenUrl } from "./desktop.ts";
import { LAKEBOX_RUNTIME_ROOT, lakeboxServicePort } from "./user.ts";

const TTYD_CLIENT_OPTIONS = [
  "term=xterm-256color",
  "rendererType=webgl",
  "cursorStyle=bar",
  "copyOnSelect=true",
  "rightClickSelectsWord=true",
  "disableLeaveAlert=true",
  "disableResizeOverlay=true",
];

export const LakeboxControllerDefinitionSchema = z
  .object({
    name: z.string().describe("Service name."),
    kind: lakeboxServiceKindSchema,
    image: z.string().optional().describe("OCI image for image services."),
    pull: z.enum(["missing", "always"]).default("missing").describe("Image pull policy."),
    command: z
      .array(z.string())
      .optional()
      .describe("Argv; omitted to use the image entrypoint and command."),
    env: z
      .record(z.string(), z.string())
      .describe("Container environment, including injected values."),
    workingDirectory: z.string().optional().describe("Container working directory."),
    mounts: z
      .array(
        z
          .object({
            source: z
              .string()
              .startsWith("/")
              .describe("Absolute host path beneath the user's home."),
            target: z.string().startsWith("/").describe("Container path."),
            readOnly: z.boolean().describe("Read-only bind."),
          })
          .strict(),
      )
      .describe("Bind mounts."),
    port: z.number().int().describe("Derived loopback port."),
    readiness: z.enum(["tcp", "none"]).describe("Readiness check."),
    readySeconds: z.number().int().positive().describe("Maximum readiness wait."),
    autostart: z.boolean().describe("Whether the service restarts when the Lakebox starts."),
    route: z.boolean().describe("Whether AppKit routes the service."),
    stripPrefix: z.boolean().describe("Whether the route prefix is removed before forwarding."),
    openPath: z.string().optional().describe("Entry path appended to the route."),
  })
  .strict()
  .describe("Service definition persisted in the user's Lakebox home and read by the controller.");
/** Service definition persisted in the user's Lakebox home. */
export type LakeboxControllerDefinition = z.output<typeof LakeboxControllerDefinitionSchema>;

export const LakeboxControllerServiceSchema = z
  .object({
    name: z.string(),
    state: lakeboxServiceStateSchema,
    definition: LakeboxControllerDefinitionSchema,
    error: z.string().optional(),
    log: z.string().optional(),
  })
  .passthrough()
  .describe("One service as reported by the remote controller.");
/** One service as reported by the remote controller. */
export type LakeboxControllerService = z.infer<typeof LakeboxControllerServiceSchema>;

/** Routing behavior derived from a saved definition. */
export interface LakeboxServiceRoute {
  port: number;
  stripPrefix: boolean;
  redirectToSlash: boolean;
  htmlHead?: string;
}

/** Builds the package-owned definition for a built-in service. */
export function builtInDefinition(
  name: LakeboxBuiltInServiceName,
  user: LakeboxUser,
): LakeboxControllerDefinition {
  const port = lakeboxServicePort(user.hash, name);
  const common = {
    name,
    kind: name,
    pull: "missing" as const,
    mounts: [],
    port,
    readiness: "tcp" as const,
    autostart: false,
    route: true,
    stripPrefix: true,
  };
  if (name === "terminal") {
    return {
      ...common,
      readySeconds: 60,
      env: injectedEnvironment(user, name, port),
      command: [
        `${LAKEBOX_RUNTIME_ROOT}/bin/ttyd`,
        "--interface",
        "127.0.0.1",
        "--port",
        String(port),
        "--writable",
        ...TTYD_CLIENT_OPTIONS.flatMap((option) => ["--client-option", option]),
        "/bin/bash",
        "-l",
      ],
    };
  }
  return {
    ...common,
    readySeconds: 180,
    env: { ...desktopEnvironment(), ...injectedEnvironment(user, name, port) },
    command: ["/bin/sh", `${LAKEBOX_RUNTIME_ROOT}/bin/desktop-session`],
  };
}

/**
 * Validates an agent or REST service request and resolves it to a persisted
 * definition with injected variables and home-relative mounts.
 */
export function imageDefinition(
  input: CreateLakeboxServiceRequest,
  user: LakeboxUser,
): LakeboxControllerDefinition {
  const request = createLakeboxServiceRequestSchema.parse(input);
  const port = lakeboxServicePort(user.hash, request.name);
  return {
    name: request.name,
    kind: "image",
    image: request.image,
    pull: request.pull,
    ...(request.command ? { command: request.command } : {}),
    env: { ...request.env, ...injectedEnvironment(user, request.name, port, request.route) },
    ...(request.workingDirectory ? { workingDirectory: request.workingDirectory } : {}),
    mounts: request.mounts.map((mount) => ({
      source: `${user.home}/${mount.source.replace(/^\.\/+|\/+$/g, "")}`,
      target: mount.target,
      readOnly: mount.readOnly,
    })),
    port,
    readiness: request.route ? "tcp" : "none",
    readySeconds: 300,
    autostart: true,
    route: request.route,
    stripPrefix: request.stripPrefix,
    ...(request.openPath ? { openPath: request.openPath.replace(/^\/+/, "") } : {}),
  };
}

/** Returns route behavior for a saved definition. */
export function serviceRoute(definition: LakeboxControllerDefinition): LakeboxServiceRoute {
  return {
    port: definition.port,
    stripPrefix: definition.stripPrefix,
    redirectToSlash: true,
    ...(definition.kind === "desktop" ? { htmlHead: desktopHtmlHead } : {}),
  };
}

/** Maps a controller report to the shared service shape. */
export function toLakeboxService(
  service: LakeboxControllerService,
  user: LakeboxUser,
  routePrefix: string,
): LakeboxService {
  const { definition } = service;
  const path = lakeboxServicePath(routePrefix, user.hash, definition.name);
  return {
    name: definition.name,
    kind: definition.kind,
    ...(definition.image ? { image: definition.image } : {}),
    state: service.state,
    port: definition.port,
    route: definition.route,
    path,
    ...(definition.route ? { openUrl: openUrl(definition, path) } : {}),
    ...(service.error ? { error: service.error } : {}),
    ...(service.log !== undefined ? { log: service.log } : {}),
  };
}

/** Returns the stopped placeholder for a built-in service that has never started. */
export function idleBuiltInService(
  name: LakeboxBuiltInServiceName,
  user: LakeboxUser,
  routePrefix: string,
): LakeboxService {
  return toLakeboxService(
    { name, state: "stopped", definition: builtInDefinition(name, user) },
    user,
    routePrefix,
  );
}

function openUrl(definition: LakeboxControllerDefinition, path: string): string {
  if (definition.kind === "desktop") return desktopOpenUrl(path);
  return `${path}/${definition.openPath ?? ""}`;
}

function injectedEnvironment(
  user: LakeboxUser,
  name: string,
  port: number,
  route = true,
): Record<string, string> {
  const value = String(port);
  return {
    SERVICE_NAME: name,
    SERVICE_PATH: route ? `${user.routePrefix}/${name}` : "",
    SERVICE_PORT: value,
    PORT: value,
  };
}
