import { z } from "zod";

export const lakeboxStatusSchema = z
  .enum(["missing", "unknown", "starting", "running", "stopping", "stopped", "error"])
  .describe(
    "Normalized Lakebox lifecycle state. missing means the app Lakebox has not been created yet; it is created on first use.",
  );
export type LakeboxStatus = z.infer<typeof lakeboxStatusSchema>;

export const lakeboxUserSchema = z
  .object({
    hash: z
      .string()
      .regex(/^[0-9a-z]+$/)
      .describe("FNV-1a hash of the authenticated identity; the only user routing key."),
    name: z.string().min(1).describe("Locked, non-sudo Linux account that runs the user's work."),
    uid: z.number().int().min(1).max(65535).describe("Deterministic Linux UID of the account."),
    home: z.string().startsWith("/").describe("Stable home path, a symlink to persistent storage."),
    routePrefix: z
      .string()
      .startsWith("/")
      .describe("AppKit route prefix beneath which this user's services are exposed."),
  })
  .strict()
  .describe("The Lakebox account derived from the current authenticated user.");
export type LakeboxUser = z.infer<typeof lakeboxUserSchema>;

/** Built-in services every user can start without a definition. */
export const LAKEBOX_BUILT_IN_SERVICES = [
  { name: "terminal", label: "Terminal" },
  { name: "desktop", label: "Desktop" },
] as const;

export const lakeboxBuiltInServiceNameSchema = z
  .enum(["terminal", "desktop"])
  .describe("Built-in user service backed by a package-owned definition.");
export type LakeboxBuiltInServiceName = z.infer<typeof lakeboxBuiltInServiceNameSchema>;

/** Environment variables the runtime injects into every service. */
export const LAKEBOX_RESERVED_SERVICE_ENV = [
  "SERVICE_NAME",
  "SERVICE_PATH",
  "SERVICE_PORT",
  "PORT",
] as const;

export const lakeboxServiceNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,30}$/,
    "Use 1-31 lowercase letters, digits, or hyphens, starting with a letter.",
  )
  .describe(
    "Service name, unique per user. It is the route segment and, with the user hash, derives the service port.",
  );

export const lakeboxServiceStateSchema = z
  .enum(["stopped", "starting", "ready", "error"])
  .describe("Current service state.");
export type LakeboxServiceState = z.infer<typeof lakeboxServiceStateSchema>;

export const lakeboxServiceKindSchema = z
  .enum(["image", "terminal", "desktop"])
  .describe(
    "image runs an OCI image; terminal and desktop are built-in services that run the Lakebox host environment.",
  );
export type LakeboxServiceKind = z.infer<typeof lakeboxServiceKindSchema>;

export const lakeboxServiceSchema = z
  .object({
    name: lakeboxServiceNameSchema,
    kind: lakeboxServiceKindSchema,
    image: z.string().optional().describe("OCI image reference for image services."),
    openPath: z
      .string()
      .optional()
      .describe("Configured entry path appended to the service route."),
    state: lakeboxServiceStateSchema,
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .describe("Loopback port derived from the user hash and service name."),
    route: z
      .boolean()
      .describe("Whether AppKit exposes the service through an authenticated route."),
    path: z.string().startsWith("/").describe("AppKit route path for the service."),
    openUrl: z
      .union([z.string().startsWith("/"), z.httpUrl()])
      .optional()
      .describe(
        "AppKit URL that opens the service; REST responses use a path and agent tools resolve it against the browser app origin.",
      ),
    error: z.string().optional().describe("Latest start or readiness failure."),
    log: z
      .string()
      .optional()
      .describe("Bounded tail of the service log; omitted in agent listings."),
  })
  .strict()
  .describe("One user-scoped Lakebox service.");
export type LakeboxService = z.infer<typeof lakeboxServiceSchema>;

export const lakeboxSummarySchema = z
  .object({
    supported: z.boolean().describe("Whether the workspace exposes the Databricks Lakebox API."),
    auto: z
      .boolean()
      .describe("Whether commands, services, and routes start or create the Lakebox on demand."),
    status: lakeboxStatusSchema,
    id: z.string().optional().describe("Databricks Lakebox identifier, once created."),
    name: z.string().min(1).describe("Product display label; never the upstream machine name."),
    idleTimeoutSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Platform idle timeout after which the Lakebox stops."),
    user: lakeboxUserSchema,
    services: z.array(lakeboxServiceSchema).describe("The current user's services."),
    servicesStale: z
      .boolean()
      .describe(
        "True when services come from the last successful controller observation rather than live Lakebox state.",
      ),
    servicesObservedAt: z
      .string()
      .datetime()
      .optional()
      .describe("Time of the last successful live service observation."),
    canStart: z.boolean().describe("Whether the Lakebox can be started or created now."),
    canStop: z.boolean().describe("Whether the Lakebox can be stopped now."),
  })
  .strict()
  .describe("Secret-free summary of the app Lakebox for the current user.");
export type LakeboxSummary = z.infer<typeof lakeboxSummarySchema>;

const environmentSchema = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
  .describe("Environment variables.");

export const lakeboxCommandRequestSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .regex(/^\S+$/, 'Command must be one executable name; use command "sh" for shell syntax.')
      .describe(
        'Executable name only. Put arguments in args. For shell syntax, use command "sh" with args ["-lc", "<script>"].',
      ),
    args: z
      .array(z.string())
      .default([])
      .describe("Individual arguments. Never concatenate the executable and its arguments."),
    cwd: z
      .string()
      .optional()
      .describe("Working directory on the Lakebox host. Defaults to the user's home."),
    env: environmentSchema
      .optional()
      .describe(
        "Non-authentication environment overlay. Databricks credentials and SSH agent variables are rejected.",
      ),
    timeoutMs: z.number().int().positive().max(3_600_000).optional().describe("Command timeout."),
  })
  .strict()
  .superRefine((request, context) => rejectCredentialEnvKeys(request.env, context))
  .describe("Command executed as the current user's Lakebox account.");
export type LakeboxCommandRequest = z.input<typeof lakeboxCommandRequestSchema>;

export const lakeboxCommandResultSchema = z
  .object({
    success: z.boolean().describe("Whether the command exited successfully."),
    exitCode: z.number().int().describe("Remote exit code."),
    stdout: z.string().describe("Captured standard output."),
    stderr: z.string().describe("Captured standard error."),
    executionTimeMs: z.number().nonnegative().describe("Elapsed execution time."),
    timedOut: z.boolean().optional().describe("Whether timeout terminated the command."),
    command: z.string().describe("Executed command."),
    args: z.array(z.string()).describe("Executed arguments."),
  })
  .strict()
  .describe("Lakebox command execution result.");
export type LakeboxCommandResult = z.infer<typeof lakeboxCommandResultSchema>;

export const lakeboxServiceMountSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .describe(
        "Host directory relative to the user's home, such as data. It is created when missing. Absolute paths and parent traversal are rejected.",
      ),
    target: z
      .string()
      .startsWith("/")
      .describe("Absolute path inside the container, such as /example."),
    readOnly: z.boolean().default(false).describe("Mount read-only inside the container."),
  })
  .strict()
  .refine((mount) => !mount.source.startsWith("/") && !mount.source.split("/").includes(".."), {
    message: "Mount sources must stay inside the user's home.",
    path: ["source"],
  })
  .describe("Bind mount from the user's persistent home into the container.");
export type LakeboxServiceMount = z.input<typeof lakeboxServiceMountSchema>;

export const createLakeboxServiceRequestSchema = z
  .object({
    name: lakeboxServiceNameSchema,
    image: z
      .string()
      .min(1)
      .regex(/^\S+$/)
      .describe(
        "OCI image reference pulled anonymously, such as docker.io/library/python:3.12-alpine.",
      ),
    command: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Complete argv that replaces the image entrypoint and command. Tokens are passed literally; there is no shell parsing unless the first tokens are a shell such as ["sh", "-c", "..."]. Omit to run the image\'s own entrypoint and command.',
      ),
    env: environmentSchema
      .default({})
      .describe(
        "Container environment. SERVICE_NAME, SERVICE_PATH, SERVICE_PORT, and PORT are injected and reserved; Databricks credentials are rejected.",
      ),
    workingDirectory: z
      .string()
      .startsWith("/")
      .optional()
      .describe("Working directory inside the container. Defaults to the image working directory."),
    mounts: z
      .array(lakeboxServiceMountSchema)
      .default([])
      .describe("Bind mounts from the user's home. Host file permissions still apply."),
    route: z
      .boolean()
      .default(true)
      .describe(
        "Expose the service through the user's authenticated AppKit route. Routed services must listen on 127.0.0.1:$SERVICE_PORT; there is no Docker-style port publishing.",
      ),
    openPath: z
      .string()
      .optional()
      .describe("Entry path appended to the route, such as index.html?mode=1."),
    stripPrefix: z
      .boolean()
      .default(true)
      .describe(
        "Remove the route prefix before forwarding. Set false only when the server is configured for the full SERVICE_PATH base path.",
      ),
    pull: z
      .enum(["missing", "always"])
      .default("missing")
      .describe("Pull the image only when absent, or always before starting."),
  })
  .strict()
  .superRefine((request, context) => {
    rejectCredentialEnvKeys(request.env, context);
    for (const name of LAKEBOX_RESERVED_SERVICE_ENV) {
      if (name in request.env) {
        context.addIssue({
          code: "custom",
          path: ["env", name],
          message: `${name} is injected by the Lakebox runtime and cannot be set.`,
        });
      }
    }
    if (LAKEBOX_BUILT_IN_SERVICES.some((service) => service.name === request.name)) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: `${request.name} is a built-in service name.`,
      });
    }
  })
  .describe(
    "Create or replace a user service that runs an OCI image detached under the Lakebox runtime.",
  );
export type CreateLakeboxServiceRequest = z.input<typeof createLakeboxServiceRequestSchema>;
export type LakeboxServiceDefinition = z.output<typeof createLakeboxServiceRequestSchema>;

export const lakeboxServiceActionSchema = z
  .object({ name: lakeboxServiceNameSchema })
  .strict()
  .describe("Request that targets one of the current user's services.");
export type LakeboxServiceAction = z.infer<typeof lakeboxServiceActionSchema>;

/** Default number of service log lines returned by bounded log reads. */
export const LAKEBOX_LOG_DEFAULT_MAX_LINES = 200;
/** Default service log character cap returned by bounded log reads. */
export const LAKEBOX_LOG_DEFAULT_MAX_CHARS = 16_000;

export const lakeboxServiceLogsRequestSchema = lakeboxServiceActionSchema
  .extend({
    maxLines: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(LAKEBOX_LOG_DEFAULT_MAX_LINES)
      .describe("Maximum number of trailing log lines."),
    maxChars: z.coerce
      .number()
      .int()
      .min(1)
      .max(64_000)
      .default(LAKEBOX_LOG_DEFAULT_MAX_CHARS)
      .describe("Maximum number of trailing log characters."),
  })
  .strict()
  .describe("Bounded log request for one service.");
export type LakeboxServiceLogsRequest = z.input<typeof lakeboxServiceLogsRequestSchema>;

export const lakeboxServiceLogsResponseSchema = z
  .object({ log: z.string().describe("Bounded trailing service log, including image pulls.") })
  .strict()
  .describe("Bounded service log response.");
export type LakeboxServiceLogsResponse = z.infer<typeof lakeboxServiceLogsResponseSchema>;

export const lakeboxServicesResponseSchema = z
  .object({ services: z.array(lakeboxServiceSchema).describe("The current user's services.") })
  .strict()
  .describe("Service listing response.");
export type LakeboxServicesResponse = z.infer<typeof lakeboxServicesResponseSchema>;

export const lakeboxServiceResponseSchema = z
  .object({ service: lakeboxServiceSchema })
  .strict()
  .describe("Single service response.");
export type LakeboxServiceResponse = z.infer<typeof lakeboxServiceResponseSchema>;

export const removeLakeboxServiceResponseSchema = z
  .object({ removed: z.boolean().describe("Whether a saved service was removed.") })
  .strict()
  .describe("Service removal response.");
export type RemoveLakeboxServiceResponse = z.infer<typeof removeLakeboxServiceResponseSchema>;

export const lakeboxMetricsSnapshotSchema = z
  .object({
    at: z.string().datetime().describe("Sample time."),
    cpu: z
      .object({
        cores: z.number().int().positive().describe("Online CPU count."),
        usedPercent: z
          .number()
          .min(0)
          .max(100)
          .describe("CPU busy percentage since the last sample."),
        load1: z.number().nonnegative().describe("One-minute load average."),
      })
      .strict()
      .describe("CPU usage."),
    memory: z
      .object({
        totalBytes: z.number().nonnegative().describe("Total memory."),
        usedBytes: z.number().nonnegative().describe("Memory in use, excluding reclaimable cache."),
      })
      .strict()
      .describe("Memory usage."),
    storage: z
      .object({
        totalBytes: z.number().nonnegative().describe("Persistent home volume size."),
        usedBytes: z.number().nonnegative().describe("Persistent home volume usage."),
      })
      .strict()
      .describe("Persistent storage usage."),
    network: z
      .object({
        rxBytesPerSecond: z.number().nonnegative().describe("Inbound network throughput."),
        txBytesPerSecond: z.number().nonnegative().describe("Outbound network throughput."),
      })
      .strict()
      .describe("Network throughput on the primary interface."),
  })
  .strict()
  .describe("Machine-level Lakebox resource sample. Never includes process information.");
export type LakeboxMetricsSnapshot = z.infer<typeof lakeboxMetricsSnapshotSchema>;

export const lakeboxMetricsResponseSchema = z
  .object({
    status: lakeboxStatusSchema,
    series: z
      .array(lakeboxMetricsSnapshotSchema)
      .describe("Recent samples, oldest first. Empty while the Lakebox is not running."),
  })
  .strict()
  .describe("Lakebox metrics response.");
export type LakeboxMetricsResponse = z.infer<typeof lakeboxMetricsResponseSchema>;

const readTool = { appkitTool: { agentTool: true, effect: "read", requiresUserContext: true } };
const writeTool = { appkitTool: { agentTool: true, effect: "write", requiresUserContext: true } };

export const getLakeboxOperationSchema = z
  .object({})
  .strict()
  .describe(
    "Return the app Lakebox status, the current user's Lakebox account, and that user's services. This never creates the Lakebox.",
  )
  .meta(readTool);

export const executeLakeboxCommandOperationSchema = lakeboxCommandRequestSchema
  .describe(
    "Run a command on the Lakebox host as the current user's locked, non-sudo account, starting the Lakebox when needed. Use services, not background commands, for long-running servers.",
  )
  .meta(writeTool);

export const listLakeboxServicesOperationSchema = z
  .object({})
  .strict()
  .describe("List the current user's services with state, port, and route. Logs are omitted.")
  .meta(readTool);

export const createLakeboxServiceOperationSchema = createLakeboxServiceRequestSchema
  .describe(
    "Create or replace a user service from an OCI image, start it detached, and wait until it is ready or failed. This is a constrained container API, not the Docker CLI: there is no daemon, port publishing, privileged mode, or device access. Routed services listen on 127.0.0.1:$SERVICE_PORT and are reached at the returned openUrl. Services restart from their saved definition when the Lakebox starts; process memory is not resumed.",
  )
  .meta(writeTool);

export const startLakeboxServiceOperationSchema = lakeboxServiceActionSchema
  .describe(
    "Start a saved service or a built-in terminal or desktop and wait until it is ready or failed.",
  )
  .meta({ appkitTool: { ...writeTool.appkitTool, idempotent: true } });

export const stopLakeboxServiceOperationSchema = lakeboxServiceActionSchema
  .describe("Stop one running service without removing its definition.")
  .meta({ appkitTool: { ...writeTool.appkitTool, idempotent: true } });

export const removeLakeboxServiceOperationSchema = lakeboxServiceActionSchema
  .describe(
    "Stop and delete one saved service definition and its image root filesystem. Mounted home directories are preserved.",
  )
  .meta({
    appkitTool: {
      agentTool: true,
      effect: "destructive",
      approval: true,
      requiresUserContext: true,
    },
  });

export const getLakeboxServiceLogsOperationSchema = lakeboxServiceLogsRequestSchema
  .describe("Read a bounded tail of one service log, including image pull and readiness output.")
  .meta(readTool);

function rejectCredentialEnvKeys(
  env: Readonly<Record<string, string>> | undefined,
  context: z.RefinementCtx,
): void {
  for (const name of Object.keys(env ?? {})) {
    if (name.startsWith("DATABRICKS_") || name === "SSH_AUTH_SOCK") {
      context.addIssue({
        code: "custom",
        path: ["env", name],
        message:
          "Environment overlays cannot restore Databricks or SSH agent credentials; use a dedicated app-mediated capability.",
      });
    }
  }
}
