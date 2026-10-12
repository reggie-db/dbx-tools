import {
  deleteSshMachineResponseSchema,
  sshMachineSchema,
  sshMachineServiceSchema,
  sshMachinesResponseSchema,
  sshRouteResponseSchema,
  sshRoutesResponseSchema,
  type AddSshRouteRequest,
  type CreateSshMachineRequest,
  type DeleteSshMachineResponse,
  type SshMachine,
  type SshMachineService,
  type SshMachineServiceKind,
  type SshMachinesResponse,
  type SshRoute,
  type SshRoutesResponse,
} from "@dbx-tools/shared-databricks-sandbox";

/** Browser client for the AppKit SSH plugin's machine and route APIs. */
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

  listRoutes(signal?: AbortSignal): Promise<SshRoutesResponse> {
    return this.request("/routes", sshRoutesResponseSchema.parse, { signal });
  }

  async addRoute(input: AddSshRouteRequest): Promise<SshRoute> {
    const response = await this.request("/routes", sshRouteResponseSchema.parse, {
      method: "POST",
      body: input,
    });
    return response.route;
  }

  async removeRoute(routeId: string): Promise<boolean> {
    const response = await this.request(
      `/routes/${encodeURIComponent(routeId)}`,
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
