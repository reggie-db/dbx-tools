import {
  deleteSshMachineResponseSchema,
  sshMachineSchema,
  sshMachineServiceSchema,
  sshMachinesResponseSchema,
  sshProjectResponseSchema,
  sshProjectsResponseSchema,
  type AddSshProjectRequest,
  type CreateSshMachineRequest,
  type DeleteSshMachineResponse,
  type SshMachine,
  type SshMachineService,
  type SshMachineServiceKind,
  type SshMachinesResponse,
  type SshProject,
  type SshProjectsResponse,
} from "@dbx-tools/shared-databricks-sandbox";

/** Browser client for the AppKit SSH plugin's machine and project APIs. */
export class SshClient {
  constructor(readonly basePath = "/api/databricks-sandbox") {}

  listMachines(signal?: AbortSignal): Promise<SshMachinesResponse> {
    return this.request("/machines", sshMachinesResponseSchema.parse, { signal });
  }

  create(input: CreateSshMachineRequest = {}): Promise<SshMachine> {
    return this.request("/machines", sshMachineSchema.parse, { method: "POST", body: input });
  }

  start(machineId: string): Promise<SshMachine> {
    return this.request(
      `/machines/${encodeURIComponent(machineId)}/start`,
      sshMachineSchema.parse,
      { method: "POST" },
    );
  }

  stop(machineId: string): Promise<SshMachine> {
    return this.request(`/machines/${encodeURIComponent(machineId)}/stop`, sshMachineSchema.parse, {
      method: "POST",
    });
  }

  delete(machineId: string): Promise<DeleteSshMachineResponse> {
    return this.request(
      `/machines/${encodeURIComponent(machineId)}`,
      deleteSshMachineResponseSchema.parse,
      { method: "DELETE" },
    );
  }

  startService(machineId: string, service: SshMachineServiceKind): Promise<SshMachineService> {
    return this.request(
      `/machines/${encodeURIComponent(machineId)}/services/${encodeURIComponent(service)}/start`,
      sshMachineServiceSchema.parse,
      { method: "POST" },
    );
  }

  listProjects(signal?: AbortSignal): Promise<SshProjectsResponse> {
    return this.request("/projects", sshProjectsResponseSchema.parse, { signal });
  }

  async addProject(input: AddSshProjectRequest): Promise<SshProject> {
    const response = await this.request("/projects", sshProjectResponseSchema.parse, {
      method: "POST",
      body: input,
    });
    return response.project;
  }

  async removeProject(projectId: string): Promise<boolean> {
    const response = await this.request(
      `/projects/${encodeURIComponent(projectId)}`,
      (value) => value as { removed: boolean },
      { method: "DELETE" },
    );
    return response.removed;
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

function responseErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  for (const field of ["error", "message"] as const) {
    if (!(field in body)) continue;
    const value = String((body as Record<string, unknown>)[field]).trim();
    if (value) return value;
  }
  return undefined;
}
