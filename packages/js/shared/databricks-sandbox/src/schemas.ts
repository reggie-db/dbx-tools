import { z } from "zod";

export const sshMachineStatusSchema = z
  .enum(["unknown", "starting", "running", "stopping", "stopped", "error"])
  .describe("Normalized lifecycle state of a Databricks Sandbox.");
export type SshMachineStatus = z.infer<typeof sshMachineStatusSchema>;

export const sshProjectSchema = z
  .object({
    id: z.string().min(1).describe("Stable identifier for the Sandbox project."),
    name: z.string().min(1).describe("Project display name."),
    machineId: z.string().min(1).describe("Machine that hosts the project."),
    directory: z.string().min(1).describe("Project directory below the Sandbox user's home."),
    path: z.string().startsWith("/").describe("AppKit path that exposes the project server."),
    openUrl: z
      .string()
      .startsWith("/")
      .optional()
      .describe("AppKit URL opened by project links, including any configured entry page."),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .describe("Loopback HTTP port reserved for the project."),
    stripPrefix: z
      .boolean()
      .describe("Whether the registered AppKit path is removed before forwarding."),
    state: z
      .enum(["stopped", "starting", "ready", "error"])
      .describe("Current project route state."),
    error: z.string().optional().describe("Latest forwarding failure."),
  })
  .strict()
  .describe("One persisted Sandbox project and its AppKit route.");
export type SshProject = z.infer<typeof sshProjectSchema>;

/** Stable ordered identifiers for built-in Sandbox browser services. */
export const SSH_MACHINE_SERVICE_KINDS = ["terminal", "desktop", "stats"] as const;

/** Browser-safe display metadata shared by every built-in service control. */
export const SSH_MACHINE_SERVICES = [
  { kind: "terminal", label: "Terminal" },
  { kind: "desktop", label: "Desktop" },
  { kind: "stats", label: "Stats" },
] as const satisfies readonly {
  kind: (typeof SSH_MACHINE_SERVICE_KINDS)[number];
  label: string;
}[];

export const sshMachineServiceKindSchema = z
  .enum(SSH_MACHINE_SERVICE_KINDS)
  .describe("Built-in browser service available on a Databricks Sandbox.");
export type SshMachineServiceKind = z.infer<typeof sshMachineServiceKindSchema>;

export const sshMachineServiceSchema = z
  .object({
    kind: sshMachineServiceKindSchema.describe("Service type."),
    path: z.string().startsWith("/").describe("Stable AppKit path for the service."),
    openUrl: z
      .string()
      .startsWith("/")
      .describe("AppKit URL that opens the service at its intended entry page."),
    state: z
      .enum(["stopped", "starting", "ready", "error"])
      .describe("Current service provisioning state."),
    log: z.string().optional().describe("Current contents of the shared remote lifecycle log."),
    error: z.string().optional().describe("Latest service provisioning failure."),
  })
  .strict()
  .describe("Browser service provisioned on an SSH machine.");
export type SshMachineService = z.infer<typeof sshMachineServiceSchema>;

export const sshMachineSchema = z
  .object({
    id: z.string().min(1).describe("Databricks Sandbox identifier used as the SSH username."),
    name: z.string().min(1).describe("Human-readable Sandbox name."),
    provider: z.literal("databricks-sandbox").describe("Machine provider."),
    status: sshMachineStatusSchema.describe("Normalized machine lifecycle state."),
    gatewayHost: z.string().optional().describe("Databricks Sandbox SSH gateway hostname."),
    createdAt: z.string().optional().describe("ISO-8601 machine creation time."),
    expiresAt: z.string().datetime().describe("ISO-8601 service-managed expiration time."),
    lastStartedAt: z.string().optional().describe("ISO-8601 last start time."),
    autoStopSeconds: z.number().int().nonnegative().optional().describe("Configured idle timeout."),
    projects: z.array(sshProjectSchema).describe("Projects persisted for the machine."),
    services: z
      .array(sshMachineServiceSchema)
      .describe("Built-in terminal and health services for the machine."),
    canStart: z.boolean().describe("Whether the machine can be started."),
    canStop: z.boolean().describe("Whether the machine can be stopped."),
    canConnect: z.boolean().describe("Whether enough SSH metadata is available to connect."),
  })
  .strict()
  .describe("Public, secret-free summary of a Databricks Sandbox.");
export type SshMachine = z.infer<typeof sshMachineSchema>;

export const sshMachinesResponseSchema = z
  .object({
    auto: z
      .boolean()
      .describe("Whether operations may automatically start and register SSH access."),
    supported: z
      .boolean()
      .describe("Whether the workspace exposes the Databricks Sandbox REST API."),
    machines: z
      .array(sshMachineSchema)
      .describe("Existing machines; this response never creates one."),
  })
  .strict()
  .describe("SSH machine discovery response.");
export type SshMachinesResponse = z.infer<typeof sshMachinesResponseSchema>;

export const createSshMachineRequestSchema = z
  .object({
    desktop: z
      .boolean()
      .optional()
      .describe("Start the Sandbox and provision its built-in browser desktop before returning."),
  })
  .strict()
  .describe("Request to create an automatically named Databricks Sandbox for the current user.");
export type CreateSshMachineRequest = z.infer<typeof createSshMachineRequestSchema>;

export const sshMachineActionSchema = z
  .object({ machineId: z.string().min(1).describe("Machine to manage.") })
  .strict()
  .describe("Machine lifecycle request.");
export type SshMachineAction = z.infer<typeof sshMachineActionSchema>;

export const deleteSshMachineResponseSchema = z
  .object({ deleted: z.boolean().describe("Whether the Sandbox was deleted.") })
  .strict()
  .describe("Databricks Sandbox deletion response.");
export type DeleteSshMachineResponse = z.infer<typeof deleteSshMachineResponseSchema>;

export const sshMachineServiceActionSchema = z
  .object({
    machineId: z.string().min(1).describe("Machine that hosts the service."),
    service: sshMachineServiceKindSchema.describe("Service to start or inspect."),
  })
  .strict()
  .describe("Request to start one built-in machine service.");
export type SshMachineServiceAction = z.infer<typeof sshMachineServiceActionSchema>;

/** Default number of lifecycle log lines returned by bounded log reads. */
export const SSH_SERVICE_LOG_DEFAULT_MAX_LINES = 200;
/** Hard maximum number of lifecycle log lines accepted by one log read. */
export const SSH_SERVICE_LOG_MAX_LINES = 1_000;
/** Default lifecycle log character cap returned by bounded log reads. */
export const SSH_SERVICE_LOG_DEFAULT_MAX_CHARS = 16_000;
/** Hard maximum lifecycle log character cap accepted by one log read. */
export const SSH_SERVICE_LOG_MAX_CHARS = 64_000;

export const sshMachineServiceLogsRequestSchema = sshMachineServiceActionSchema
  .extend({
    maxLines: z.coerce
      .number()
      .int()
      .min(1)
      .max(SSH_SERVICE_LOG_MAX_LINES)
      .default(SSH_SERVICE_LOG_DEFAULT_MAX_LINES)
      .describe("Maximum number of trailing lifecycle log lines to return."),
    maxChars: z.coerce
      .number()
      .int()
      .min(1)
      .max(SSH_SERVICE_LOG_MAX_CHARS)
      .default(SSH_SERVICE_LOG_DEFAULT_MAX_CHARS)
      .describe("Maximum number of trailing lifecycle log characters to return."),
  })
  .strict()
  .describe("Bounded lifecycle log request for one built-in Sandbox service.");
export type SshMachineServiceLogsRequest = z.infer<typeof sshMachineServiceLogsRequestSchema>;

export const sshMachineServiceLogsResponseSchema = z
  .object({
    log: z.string().describe("Bounded trailing contents of the service lifecycle log."),
  })
  .strict()
  .describe("Bounded lifecycle log response for one built-in Sandbox service.");
export type SshMachineServiceLogsResponse = z.infer<typeof sshMachineServiceLogsResponseSchema>;

export const sshMachineServiceStartResultSchema = z
  .object({
    exitCode: z
      .number()
      .int()
      .describe("Zero when the service became ready; nonzero when provisioning failed."),
  })
  .strict()
  .describe("Minimal agent result for one built-in service start.");
export type SshMachineServiceStartResult = z.infer<typeof sshMachineServiceStartResultSchema>;

export const sshCommandRequestSchema = z
  .object({
    machineId: z
      .string()
      .min(1)
      .describe("Assigned Sandbox id from list_ssh_machines that executes the command."),
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
      .describe(
        "Individual arguments passed to the executable. Never concatenate the executable and its arguments into command.",
      ),
    cwd: z.string().optional().describe("Remote working directory."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Non-authentication remote environment overlay applied after inherited Databricks authentication and SSH agent variables are cleared. Databricks credentials require a dedicated app-mediated OBO capability.",
      ),
    timeoutMs: z.number().int().positive().max(3_600_000).optional().describe("Command timeout."),
  })
  .strict()
  .superRefine((request, context) => {
    for (const name of Object.keys(request.env ?? {})) {
      if (name.startsWith("DATABRICKS_") || name === "SSH_AUTH_SOCK") {
        context.addIssue({
          code: "custom",
          path: ["env", name],
          message:
            "SSH environment overlays cannot restore Databricks or SSH agent credentials; use a dedicated app-mediated OBO capability.",
        });
      }
    }
  })
  .describe("SSH command execution request.");
export type SshCommandRequest = z.input<typeof sshCommandRequestSchema>;

export const sshCommandResultSchema = z
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
  .describe("SSH command execution result.");
export type SshCommandResult = z.infer<typeof sshCommandResultSchema>;

export const addSshProjectRequestSchema = z
  .object({
    machineId: z
      .string()
      .min(1)
      .describe(
        "Assigned Sandbox id from list_ssh_machines. Do not invent an id or pick an unlisted sandbox.",
      ),
    projectId: z
      .string()
      .min(1)
      .optional()
      .describe("Stable project identifier to update. Omit when creating a project."),
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .optional()
      .describe("Lowercase project name. A unique name is generated when omitted."),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("Loopback HTTP port. An unused machine-local port is generated when omitted."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Project path suffix beneath the user's prefix. Defaults to the project name and must be unique on the Sandbox.",
      ),
    openPath: z
      .string()
      .optional()
      .describe(
        "Optional project-relative entry URL, such as open.html or vnc.html?autoconnect=1. An empty string or slash opens the route root. External URLs and parent-directory traversal are rejected.",
      ),
    config: z
      .record(z.string(), z.json())
      .optional()
      .describe(
        "Optional raw mise configuration represented as JSON and following https://mise.jdx.dev/schema/mise.json. The server serializes it to mise.toml and injects reserved PROJECT_NAME, PROJECT_PATH, and PROJECT_PORT environment values. First-class tools, postinstall, and uninstall values merge over conflicting raw config fields.",
      ),
    tools: z
      .record(z.string().min(1), z.json())
      .optional()
      .describe(
        "Optional mise tools table. Values use the canonical mise JSON schema at https://mise.jdx.dev/schema/mise.json. Entries merge over config.tools with the same tool name.",
      ),
    postinstall: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional mise hooks.postinstall shell script. It may install, prepare, or intentionally launch a workload that remains active until uninstall. It overrides config.hooks.postinstall. Use an idempotent check-lock-check pattern plus a completion marker for expensive work.",
      ),
    uninstall: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional mise tasks.uninstall shell script. Project removal and reset may call only this project task automatically, then still terminate recorded pid files and processes whose working directory is the project. It overrides config.tasks.uninstall.",
      ),
    route: z
      .boolean()
      .optional()
      .describe(
        "Whether AppKit exposes the project server through an authenticated route. Defaults true when creating and retains the stored value when updating.",
      ),
    serviceDependencies: z
      .array(sshMachineServiceKindSchema)
      .optional()
      .describe(
        "Built-in machine services that must be available before the project starts. Defaults empty when creating and retains the stored value when updating.",
      ),
    stripPrefix: z
      .boolean()
      .optional()
      .describe(
        "Remove the registered HTTP and WebSocket path before forwarding; defaults true off root. Set false only when the service is configured for the full public base path.",
      ),
  })
  .strict()
  .describe("Request to create or update an isolated, mise-managed Sandbox project.");
export type AddSshProjectRequest = z.input<typeof addSshProjectRequestSchema>;

export const removeSshProjectRequestSchema = z
  .object({ projectId: z.string().min(1).describe("Sandbox project to remove.") })
  .strict()
  .describe(
    "Request to remove a Sandbox project, run its optional mise uninstall task, terminate remaining project processes, and delete its directory.",
  );
export type RemoveSshProjectRequest = z.infer<typeof removeSshProjectRequestSchema>;

export const listSshProjectsRequestSchema = z
  .object({})
  .strict()
  .describe("Request to list persisted Sandbox projects owned by the current user.");
export type ListSshProjectsRequest = z.infer<typeof listSshProjectsRequestSchema>;

export const sshProjectActionSchema = z
  .object({ projectId: z.string().min(1).describe("Sandbox project to manage.") })
  .strict()
  .describe("Sandbox project action request.");
export type SshProjectAction = z.infer<typeof sshProjectActionSchema>;

export const sshProjectResponseSchema = z
  .object({ project: sshProjectSchema.describe("Created or updated project.") })
  .strict()
  .describe("Sandbox project response.");
export type SshProjectResponse = z.infer<typeof sshProjectResponseSchema>;

export const sshProjectTerminalResponseSchema = z
  .object({
    project: sshProjectSchema.describe("Project opened in the terminal."),
    service: sshMachineServiceSchema.describe("DinoTTY service containing the new project tab."),
  })
  .strict()
  .describe("Project terminal response.");
export type SshProjectTerminalResponse = z.infer<typeof sshProjectTerminalResponseSchema>;

export const removeSshProjectResponseSchema = z
  .object({ removed: z.boolean().describe("Whether the project was removed.") })
  .strict()
  .describe("Sandbox project removal response.");
export type RemoveSshProjectResponse = z.infer<typeof removeSshProjectResponseSchema>;

export const sshProjectsResponseSchema = z
  .object({
    pathPrefix: z
      .string()
      .startsWith("/")
      .describe("Non-security collision-avoidance path prefix assigned to the authenticated user."),
    projects: z.array(sshProjectSchema).describe("Persisted projects owned by the user."),
  })
  .strict()
  .describe("Persisted Sandbox projects response.");
export type SshProjectsResponse = z.infer<typeof sshProjectsResponseSchema>;

export const listSshMachinesOperationSchema = z
  .object({})
  .strict()
  .describe(
    "List the current user's Databricks Sandboxes. Check this first and prefer an existing Sandbox unless the user explicitly requests another.",
  )
  .meta({ appkitTool: { agentTool: true, effect: "read", requiresUserContext: true } });

export const createSshMachineOperationSchema = createSshMachineRequestSchema
  .describe(
    "Create a Databricks Sandbox for the current user. Set desktop true to start it and provision the built-in branded browser desktop before returning.",
  )
  .meta({ appkitTool: { agentTool: true, effect: "write", requiresUserContext: true } });

export const startSshMachineOperationSchema = sshMachineActionSchema
  .describe("Start an existing Databricks Sandbox assigned to the current user.")
  .meta({
    appkitTool: {
      agentTool: true,
      effect: "write",
      requiresUserContext: true,
      idempotent: true,
    },
  });

export const stopSshMachineOperationSchema = sshMachineActionSchema
  .describe("Stop an existing Databricks Sandbox assigned to the current user.")
  .meta({
    appkitTool: {
      agentTool: true,
      effect: "write",
      requiresUserContext: true,
      idempotent: true,
    },
  });

export const deleteSshMachineOperationSchema = sshMachineActionSchema
  .describe("Permanently delete one Databricks Sandbox and all of its persisted projects.")
  .meta({
    appkitTool: {
      agentTool: true,
      effect: "destructive",
      approval: true,
      requiresUserContext: true,
    },
  });

export const executeSshCommandOperationSchema = sshCommandRequestSchema
  .describe(
    "Execute a maintenance command on an assigned Sandbox. Create or select a persisted project first for app, demo, server, desktop, or persistent file work, and run from that project directory. Keep installation in mise hooks.postinstall and prefer documented mise start and stop tasks over ad-hoc workload commands. List available tasks, including hidden tasks, before invoking one.",
  )
  .meta({ appkitTool: { agentTool: true, effect: "write", requiresUserContext: true } });

export const startSshMachineServiceOperationSchema = sshMachineServiceActionSchema
  .describe(
    "Idempotently start the built-in terminal, branded desktop, or health service. The agent result contains only an exit code; live lifecycle logs are sent to clients as transient progress and can be fetched separately with bounded limits.",
  )
  .meta({
    appkitTool: {
      agentTool: true,
      effect: "write",
      requiresUserContext: true,
      idempotent: true,
    },
  });

export const getSshMachineServiceLogsOperationSchema = sshMachineServiceLogsRequestSchema
  .describe(
    "Read a bounded tail of one built-in Sandbox service lifecycle log. Use this only when install diagnostics are needed; machine listing and service-start results intentionally omit logs.",
  )
  .meta({ appkitTool: { agentTool: true, effect: "read", requiresUserContext: true } });

export const listSshProjectsOperationSchema = listSshProjectsRequestSchema
  .describe("List the current user's persisted Sandbox projects and their public AppKit routes.")
  .meta({ appkitTool: { agentTool: true, effect: "read", requiresUserContext: true } });

export const addSshProjectOperationSchema = addSshProjectRequestSchema
  .describe(
    "Create or update a persisted Sandbox project, its isolated directory, mise configuration, reserved loopback port, and authenticated AppKit route. Prefer first-class tools, postinstall, and uninstall options; raw config follows https://mise.jdx.dev/schema/mise.json. postinstall may prepare or launch a workload, while only uninstall may be auto-called during removal or reset.",
  )
  .meta({ appkitTool: { agentTool: true, effect: "write", requiresUserContext: true } });

export const openSshProjectTerminalOperationSchema = sshProjectActionSchema
  .describe("Open a new DinoTTY tab rooted at a persisted Sandbox project's directory.")
  .meta({ appkitTool: { agentTool: true, effect: "write", requiresUserContext: true } });

export const resetSshProjectOperationSchema = sshProjectActionSchema
  .describe(
    "Permanently wipe a persisted Sandbox project's directory, run its optional mise uninstall task, terminate remaining project processes, and recreate it from its saved mise configuration.",
  )
  .meta({
    appkitTool: {
      agentTool: true,
      effect: "destructive",
      approval: true,
      requiresUserContext: true,
      idempotent: true,
    },
  });

export const removeSshProjectOperationSchema = removeSshProjectRequestSchema
  .describe(
    "Permanently remove a Sandbox project, its route, and its isolated directory. Attempts only mise run uninstall when present, logs and ignores failures, terminates recorded pid files and processes whose cwd is the project directory, then deletes ~/projects/<path>.",
  )
  .meta({
    appkitTool: {
      agentTool: true,
      effect: "destructive",
      approval: true,
      requiresUserContext: true,
    },
  });
