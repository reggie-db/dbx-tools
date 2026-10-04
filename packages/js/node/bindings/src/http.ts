import { stringUtils } from "@dbx-tools/shared-core";

import type { HttpRequest, HttpResult } from "./types.ts";

/** Execute one HTTP request through the runtime fetch implementation. */
export async function executeHttp(request: HttpRequest): Promise<HttpResult> {
  const url = stringUtils.trimToNull(request.url);
  if (!url) throw new Error("HTTP URL must not be empty");
  const controller = request.timeoutMs ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), request.timeoutMs) : undefined;
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller?.signal,
      redirect: "manual",
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
