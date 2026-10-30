import { createWorkspaceClient, type WorkspaceClient } from "@databricks/appkit";
import { type ContextLike, toContext } from "@dbx-tools/appkit";
import { isRecord, log, toError } from "@dbx-tools/shared-core";
import {
  type GenieVisualizationRequest,
  genieVisualizationDownloadPath,
} from "@dbx-tools/shared-genie";

const logger = log.logger("genie/visualization");
const GENIE_PNG_SCALE = 4;
const GENIE_PNG_SHARPEN = { sigma: 1.1, m1: 0.9, m2: 0.02 } as const;

type SharpFactory = (typeof import("sharp"))["default"];

let sharpFactoryPromise: Promise<SharpFactory | undefined> | undefined;

function isByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    isRecord(value) && typeof value.getReader === "function" && typeof value.cancel === "function"
  );
}

async function loadSharp(): Promise<SharpFactory | undefined> {
  sharpFactoryPromise ??= import("sharp")
    .then((module) => module.default)
    .catch((error: unknown) => {
      logger.debug("PNG enhancement unavailable; serving the original Genie image", {
        error: toError(error),
      });
      return undefined;
    });
  return sharpFactoryPromise;
}

/**
 * Resize a Genie screenshot to four times its source dimensions with Lanczos3,
 * then apply a mild unsharp mask. Returns the original bytes when the optional
 * Sharp runtime is unavailable or rejects the image.
 */
export async function upscaleGenieVisualizationPng(inputBytes: Uint8Array): Promise<Uint8Array> {
  const sharp = await loadSharp();
  if (!sharp) return inputBytes;
  try {
    const input = Buffer.from(inputBytes);
    const metadata = await sharp(input).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Could not read Genie visualization dimensions");
    }
    const output = await sharp(input)
      .resize({
        width: metadata.width * GENIE_PNG_SCALE,
        height: metadata.height * GENIE_PNG_SCALE,
        kernel: sharp.kernel.lanczos3,
        fit: "fill",
      })
      .sharpen(GENIE_PNG_SHARPEN)
      .png()
      .toBuffer();
    return new Uint8Array(output);
  } catch (error) {
    logger.warn("PNG enhancement failed; serving the original Genie image", {
      error: toError(error),
    });
    return inputBytes;
  }
}

/** Identity and cancellation for a Genie visualization download. */
export interface DownloadGenieVisualizationOptions {
  /** Workspace client whose identity owns the conversation. */
  workspaceClient?: WorkspaceClient;
  /** External cancellation for the request and image body. */
  context?: ContextLike;
}

/**
 * Download Genie's PNG and apply optional raster cleanup before returning it.
 * The SDK's raw transport preserves binary responses and its normal authentication;
 * source-chart exports should still be preferred when they are available.
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
  return upscaleGenieVisualizationPng(bytes);
}
