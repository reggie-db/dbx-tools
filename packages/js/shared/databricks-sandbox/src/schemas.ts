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

export const sshMachineServiceKindSchema = z
  .enum(["terminal", "stats"])
  .describe("Built-in browser service available on a Databricks Sandbox.");
export type SshMachineServiceKind = z.infer<typeof sshMachineServiceKindSchema>;

export const sshMachineServiceSchema = z
  .object({
    kind: sshMachineServiceKindSchema.describe("Service type."),
    path: z.string().startsWith("/").describe("Stable AppKit path for the service."),
    state: z
      .enum(["stopped", "starting", "ready", "error"])
      .describe("Current service provisioning state."),
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
  .object({})
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

export const sshCommandRequestSchema = z
  .object({
    machineId: z.string().min(1).describe("Machine that executes the command."),
    command: z.string().min(1).describe("Executable or shell command."),
    args: z.array(z.string()).default([]).describe("Arguments passed to the command."),
    cwd: z.string().optional().describe("Remote working directory."),
    env: z.record(z.string(), z.string()).optional().describe("Remote environment overlay."),
    timeoutMs: z.number().int().positive().max(3_600_000).optional().describe("Command timeout."),
  })
  .strict()
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
    machineId: z.string().min(1).describe("Machine that hosts the project."),
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
        "Mise configuration represented as JSON. The server serializes it to mise.toml and injects reserved PROJECT_NAME, PROJECT_PATH, and PROJECT_PORT environment values.",
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
  .describe("Request to remove a Sandbox project and its directory.");
export type RemoveSshProjectRequest = z.infer<typeof removeSshProjectRequestSchema>;

export const sshProjectResponseSchema = z
  .object({ project: sshProjectSchema.describe("Created or updated project.") })
  .strict()
  .describe("Sandbox project response.");
export type SshProjectResponse = z.infer<typeof sshProjectResponseSchema>;

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
