import { createWorkspaceClient, type WorkspaceClient } from "@databricks/appkit";
import { type ContextLike, toContext } from "@dbx-tools/appkit";
import { isRecord } from "@dbx-tools/shared-core";
import {
  type GenieVisualizationRequest,
  genieVisualizationDownloadPath,
} from "@dbx-tools/shared-genie";

function isByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    isRecord(value) && typeof value.getReader === "function" && typeof value.cancel === "function"
  );
}

/** Identity and cancellation for a Genie visualization download. */
export interface DownloadGenieVisualizationOptions {
  /** Workspace client whose identity owns the conversation. */
  workspaceClient?: WorkspaceClient;
  /** External cancellation for the request and image body. */
  context?: ContextLike;
}

/**
 * Download Genie's original PNG bytes without redrawing or transcoding them.
 * The SDK's raw transport preserves binary responses and its normal authentication.
 */
export async function downloadGenieVisualization(
  input: GenieVisualizationRequest,
  options: DownloadGenieVisualizationOptions = {},
): Promise<Uint8Array> {
  const client = options.workspaceClient ?? createWorkspaceClient();
  const response = await client.apiClient.request(
    {
      path: genieVisualizationDownloadPath(input),
      method: "GET",
      headers: new Headers({ accept: "image/png" }),
      responseHeaders: ["content-type"],
      raw: true,
    },
    options.context ? toContext(options.context) : undefined,
  );
  if (
    !isRecord(response) ||
    typeof response["content-type"] !== "string" ||
    response["content-type"].split(";")[0]?.trim().toLowerCase() !== "image/png" ||
    !isByteStream(response.contents)
  ) {
    if (isRecord(response) && isByteStream(response.contents)) {
      await response.contents.cancel().catch(() => undefined);
    }
    throw new TypeError("Genie did not return a PNG visualization");
  }
  const bytes = new Uint8Array(await new Response(response.contents).arrayBuffer());
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    throw new TypeError("Genie returned an invalid PNG visualization");
  }
  return bytes;
}
