import {
  deleteSshMachineResponseSchema,
  removeSshProjectResponseSchema,
  SSH_DEFAULT_BASE_PATH,
  SSH_PLUGIN_NAME,
  SSH_ROUTES,
  SshClientConfigSchema,
  sshMachineServiceLogsRequestSchema,
  sshMachineServiceLogsResponseSchema,
  sshRoute,
  sshMachineSchema,
  sshMachineServiceSchema,
  sshMachinesResponseSchema,
  sshProjectResponseSchema,
  sshProjectTerminalResponseSchema,
  sshProjectsResponseSchema,
  type AddSshProjectRequest,
  type CreateSshMachineRequest,
  type DeleteSshMachineResponse,
  type SshMachine,
  type SshMachineService,
  type SshMachineServiceKind,
  type SshMachineServiceLogsRequest,
  type SshMachineServiceLogsResponse,
  type SshMachinesResponse,
  type SshClientConfig,
  type SshProject,
  type SshProjectTerminalResponse,
  type SshProjectsResponse,
} from "@dbx-tools/shared-databricks-sandbox";
import { usePluginClientConfig } from "@dbx-tools/ui/react";
import { useMemo } from "react";

/** Browser client for the AppKit SSH plugin's machine and project APIs. */
export class SshClient {
  constructor(readonly basePath = SSH_DEFAULT_BASE_PATH) {}

  listMachines(signal?: AbortSignal): Promise<SshMachinesResponse> {
    return this.request(SSH_ROUTES.machines, sshMachinesResponseSchema.parse, { signal });
  }

  create(input: CreateSshMachineRequest = {}): Promise<SshMachine> {
    return this.request(SSH_ROUTES.machines, sshMachineSchema.parse, {
      method: "POST",
      body: input,
    });
  }

  start(machineId: string): Promise<SshMachine> {
    return this.request(sshRoute(SSH_ROUTES.machineStart, { machineId }), sshMachineSchema.parse, {
      method: "POST",
    });
  }

  stop(machineId: string): Promise<SshMachine> {
    return this.request(sshRoute(SSH_ROUTES.machineStop, { machineId }), sshMachineSchema.parse, {
      method: "POST",
    });
  }

  delete(machineId: string): Promise<DeleteSshMachineResponse> {
    return this.request(
      sshRoute(SSH_ROUTES.machine, { machineId }),
      deleteSshMachineResponseSchema.parse,
      { method: "DELETE" },
    );
  }

  async *startService(
    machineId: string,
    service: SshMachineServiceKind,
    signal?: AbortSignal,
  ): AsyncIterable<SshMachineService> {
    const response = await fetch(
      `${this.basePath}${sshRoute(SSH_ROUTES.machineServiceStart, { machineId, service })}`,
      { method: "POST", credentials: "same-origin", signal },
    );
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => undefined)) as unknown;
      const message = responseErrorMessage(body) ?? `Sandbox request failed (${response.status})`;
      throw new Error(message);
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          if (data === "[DONE]") return;
          yield sshMachineServiceSchema.parse(JSON.parse(data));
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  serviceLogs(
    machineId: string,
    service: SshMachineServiceKind,
    limits: Partial<Pick<SshMachineServiceLogsRequest, "maxLines" | "maxChars">> = {},
    signal?: AbortSignal,
  ): Promise<SshMachineServiceLogsResponse> {
    const request = sshMachineServiceLogsRequestSchema.parse({ machineId, service, ...limits });
    const search = new URLSearchParams({
      maxLines: String(request.maxLines),
      maxChars: String(request.maxChars),
    });
    return this.request(
      `${sshRoute(SSH_ROUTES.machineServiceLogs, { machineId, service })}?${search}`,
      sshMachineServiceLogsResponseSchema.parse,
      { signal },
    );
  }

  listProjects(signal?: AbortSignal): Promise<SshProjectsResponse> {
    return this.request(SSH_ROUTES.projects, sshProjectsResponseSchema.parse, { signal });
  }

  async addProject(input: AddSshProjectRequest): Promise<SshProject> {
    const response = await this.request(SSH_ROUTES.projects, sshProjectResponseSchema.parse, {
      method: "POST",
      body: input,
    });
    return response.project;
  }

  async removeProject(projectId: string): Promise<boolean> {
    const response = await this.request(
      sshRoute(SSH_ROUTES.project, { projectId }),
      removeSshProjectResponseSchema.parse,
      { method: "DELETE" },
    );
    return response.removed;
  }

  openProjectTerminal(projectId: string): Promise<SshProjectTerminalResponse> {
    return this.request(
      sshRoute(SSH_ROUTES.projectTerminal, { projectId }),
      sshProjectTerminalResponseSchema.parse,
      { method: "POST" },
    );
  }

  async resetProject(projectId: string): Promise<SshProject> {
    const response = await this.request(
      sshRoute(SSH_ROUTES.projectReset, { projectId }),
      sshProjectResponseSchema.parse,
      { method: "POST" },
    );
    return response.project;
  }

  private async request<T>(
    path: string,
    parse: (value: unknown) => T,
    options: { method?: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const response = await fetch(`${this.basePath}${path}`, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      signal: options.signal,
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const body = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) {
      const message = responseErrorMessage(body) ?? `Sandbox request failed (${response.status})`;
      throw new Error(message);
    }
    return parse(body);
  }
}

/** Read the server-published Sandbox plugin config and build its browser client. */
export function useSshClient(basePath?: string): SshClient {
  const published = SshClientConfigSchema.parse(
    usePluginClientConfig<SshClientConfig>(SSH_PLUGIN_NAME),
  );
  const resolvedBasePath = basePath ?? published.basePath;
  return useMemo(() => new SshClient(resolvedBasePath), [resolvedBasePath]);
}

function responseErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  for (const field of ["error", "message"] as const) {
    if (!(field in body)) continue;
    const value = String((body as Record<string, unknown>)[field]).trim();
    if (value) return value;
  }
  return undefined;
}
