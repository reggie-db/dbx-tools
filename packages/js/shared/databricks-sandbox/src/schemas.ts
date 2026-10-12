import { z } from "zod";

export const sshMachineStatusSchema = z
  .enum(["unknown", "starting", "running", "stopping", "stopped", "error"])
  .describe("Normalized lifecycle state of a Databricks Sandbox.");
export type SshMachineStatus = z.infer<typeof sshMachineStatusSchema>;

export const sshRouteSchema = z
  .object({
    id: z.string().min(1).describe("Stable identifier for the forwarded route."),
    machineId: z.string().min(1).describe("Machine that receives forwarded traffic."),
    path: z.string().startsWith("/").describe("AppKit path that exposes the remote server."),
    remoteHost: z.string().min(1).describe("Host resolved from the SSH machine."),
    remotePort: z.number().int().min(1).max(65535).describe("Remote TCP port."),
    stripPrefix: z
      .boolean()
      .describe("Whether the registered AppKit path is removed before forwarding."),
    state: z.enum(["starting", "ready", "error"]).describe("Current forwarding state."),
    error: z.string().optional().describe("Latest forwarding failure."),
  })
  .strict()
  .describe("One AppKit path forwarded to a Databricks Sandbox.");
export type SshRoute = z.infer<typeof sshRouteSchema>;

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
    lastStartedAt: z.string().optional().describe("ISO-8601 last start time."),
    autoStopSeconds: z.number().int().nonnegative().optional().describe("Configured idle timeout."),
    routes: z.array(sshRouteSchema).describe("Routes currently exposed for the machine."),
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
    name: z
      .string()
      .trim()
      .max(256)
      .optional()
      .describe("Optional display name for the new Databricks Sandbox."),
  })
  .strict()
  .describe("Request to create a Databricks Sandbox for the current user.");
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

export const addSshRouteRequestSchema = z
  .object({
    machineId: z.string().min(1).describe("Machine hosting the remote web server."),
    remotePort: z.number().int().min(1).max(65535).describe("Remote HTTP port."),
    remoteHost: z.string().min(1).default("127.0.0.1").describe("Remote bind host."),
    path: z
      .string()
      .startsWith("/")
      .optional()
      .describe("Requested AppKit path, automatically scoped beneath the route prefix."),
    stripPrefix: z
      .boolean()
      .optional()
      .describe("Remove the registered path before forwarding; defaults true off root."),
  })
  .strict()
  .describe("Request to expose a remote HTTP server through AppKit.");
export type AddSshRouteRequest = z.input<typeof addSshRouteRequestSchema>;

export const removeSshRouteRequestSchema = z
  .object({ routeId: z.string().min(1).describe("Forwarded route to remove.") })
  .strict()
  .describe("Request to remove a forwarded route.");
export type RemoveSshRouteRequest = z.infer<typeof removeSshRouteRequestSchema>;

export const sshRouteResponseSchema = z
  .object({ route: sshRouteSchema.describe("Created or updated route.") })
  .strict()
  .describe("Forwarded route response.");
export type SshRouteResponse = z.infer<typeof sshRouteResponseSchema>;

export const sshRoutesResponseSchema = z
  .object({ routes: z.array(sshRouteSchema).describe("Registered routes owned by the user.") })
  .strict()
  .describe("Registered SSH routes response.");
export type SshRoutesResponse = z.infer<typeof sshRoutesResponseSchema>;
