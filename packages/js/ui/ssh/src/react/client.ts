import {
  sshMachineSchema,
  sshMachinesResponseSchema,
  sshRouteResponseSchema,
  sshRoutesResponseSchema,
  type AddSshRouteRequest,
  type SshMachine,
  type SshMachinesResponse,
  type SshRoute,
} from "@dbx-tools/shared-ssh";

/** Browser client for the AppKit SSH plugin's machine and route APIs. */
export class SshClient {
  constructor(readonly basePath = "/api/ssh") {}

  listMachines(signal?: AbortSignal): Promise<SshMachinesResponse> {
    return this.request("/machines", sshMachinesResponseSchema.parse, { signal });
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

  async listRoutes(signal?: AbortSignal): Promise<SshRoute[]> {
    const response = await this.request("/routes", sshRoutesResponseSchema.parse, { signal });
    return response.routes;
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
      const message =
        body && typeof body === "object" && "message" in body
          ? String((body as { message: unknown }).message)
          : `SSH request failed (${response.status})`;
      throw new Error(message);
    }
    return parse(body);
  }
}
