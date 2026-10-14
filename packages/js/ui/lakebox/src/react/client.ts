import {
  LAKEBOX_DEFAULT_BASE_PATH,
  LAKEBOX_PLUGIN_NAME,
  LAKEBOX_ROUTES,
  LakeboxClientConfigSchema,
  lakeboxMetricsResponseSchema,
  lakeboxRoute,
  lakeboxServiceLogsRequestSchema,
  lakeboxServiceLogsResponseSchema,
  lakeboxServiceResponseSchema,
  lakeboxServicesResponseSchema,
  lakeboxSummarySchema,
  removeLakeboxServiceResponseSchema,
  type CreateLakeboxServiceRequest,
  type LakeboxClientConfig,
  type LakeboxMetricsResponse,
  type LakeboxService,
  type LakeboxServiceLogsRequest,
  type LakeboxSummary,
} from "@dbx-tools/shared-lakebox";
import { usePluginClientConfig } from "@dbx-tools/ui/react";
import { useMemo } from "react";

/** Browser client for the Lakebox AppKit plugin API. */
export class LakeboxClient {
  constructor(readonly basePath = LAKEBOX_DEFAULT_BASE_PATH) {}

  status(signal?: AbortSignal): Promise<LakeboxSummary> {
    return this.request(LAKEBOX_ROUTES.status, lakeboxSummarySchema.parse, { signal });
  }

  start(): Promise<LakeboxSummary> {
    return this.request(LAKEBOX_ROUTES.start, lakeboxSummarySchema.parse, { method: "POST" });
  }

  stop(): Promise<LakeboxSummary> {
    return this.request(LAKEBOX_ROUTES.stop, lakeboxSummarySchema.parse, { method: "POST" });
  }

  async services(signal?: AbortSignal): Promise<LakeboxService[]> {
    return (
      await this.request(LAKEBOX_ROUTES.services, lakeboxServicesResponseSchema.parse, { signal })
    ).services;
  }

  async createService(input: CreateLakeboxServiceRequest): Promise<LakeboxService> {
    return (
      await this.request(LAKEBOX_ROUTES.services, lakeboxServiceResponseSchema.parse, {
        method: "POST",
        body: input,
      })
    ).service;
  }

  async startService(name: string): Promise<LakeboxService> {
    return (
      await this.request(
        lakeboxRoute(LAKEBOX_ROUTES.serviceStart, { name }),
        lakeboxServiceResponseSchema.parse,
        { method: "POST" },
      )
    ).service;
  }

  async stopService(name: string): Promise<LakeboxService> {
    return (
      await this.request(
        lakeboxRoute(LAKEBOX_ROUTES.serviceStop, { name }),
        lakeboxServiceResponseSchema.parse,
        { method: "POST" },
      )
    ).service;
  }

  async removeService(name: string): Promise<boolean> {
    return (
      await this.request(
        lakeboxRoute(LAKEBOX_ROUTES.service, { name }),
        removeLakeboxServiceResponseSchema.parse,
        { method: "DELETE" },
      )
    ).removed;
  }

  async serviceLogs(
    name: string,
    limits: Partial<Pick<LakeboxServiceLogsRequest, "maxLines" | "maxChars">> = {},
    signal?: AbortSignal,
  ): Promise<string> {
    const request = lakeboxServiceLogsRequestSchema.parse({ name, ...limits });
    const search = new URLSearchParams({
      maxLines: String(request.maxLines),
      maxChars: String(request.maxChars),
    });
    return (
      await this.request(
        `${lakeboxRoute(LAKEBOX_ROUTES.serviceLogs, { name })}?${search}`,
        lakeboxServiceLogsResponseSchema.parse,
        { signal },
      )
    ).log;
  }

  metrics(signal?: AbortSignal): Promise<LakeboxMetricsResponse> {
    return this.request(LAKEBOX_ROUTES.metrics, lakeboxMetricsResponseSchema.parse, { signal });
  }

  /** Streams metrics responses over SSE until the signal aborts or the stream ends. */
  async *metricsStream(signal?: AbortSignal): AsyncIterable<LakeboxMetricsResponse> {
    const response = await fetch(`${this.basePath}${LAKEBOX_ROUTES.metricsStream}`, {
      credentials: "same-origin",
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Lakebox metrics stream failed (${response.status})`);
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += value;
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const data = buffer
            .slice(0, boundary)
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          if (data) yield lakeboxMetricsResponseSchema.parse(JSON.parse(data));
        }
      }
    } finally {
      reader.releaseLock();
    }
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
      throw new Error(responseErrorMessage(body) ?? `Lakebox request failed (${response.status})`);
    }
    return parse(body);
  }
}

/** Reads the server-published Lakebox plugin config and builds its browser client. */
export function useLakeboxClient(basePath?: string): LakeboxClient {
  const published = LakeboxClientConfigSchema.parse(
    usePluginClientConfig<LakeboxClientConfig>(LAKEBOX_PLUGIN_NAME) ?? {},
  );
  const resolved = basePath ?? published.basePath;
  return useMemo(() => new LakeboxClient(resolved), [resolved]);
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
