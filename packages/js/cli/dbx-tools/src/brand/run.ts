/**
 * Standalone researched brand generation for the consolidated CLI.
 *
 * @module
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrandResearch } from "@dbx-tools/appkit-generator";
import { generateBrandPackage } from "@dbx-tools/appkit-generator";
import {
  runWebAssetPageFetch,
  runWebFetch,
  runWebImageFetch,
  createWebSearchRuntime,
  runWebSearch,
} from "@dbx-tools/appkit-web-search";
import { createWorkspaceClient } from "@dbx-tools/databricks";
import { isRecord } from "@dbx-tools/shared-core";
import type { BrandGenerationProgressEvent } from "@dbx-tools/shared-generator";

import { writeBrandPackage, type WrittenBrandPackage } from "./export.ts";
import type { BrandExportOptions } from "./options.ts";

/** Optional observers for one CLI brand generation run. */
export interface BrandExportCallbacks {
  readonly onProgress?: (event: BrandGenerationProgressEvent) => void | Promise<void>;
}

/**
 * Research a freeform brand brief, synthesize a portable context, and export
 * the package to disk.
 */
export async function exportBrandFromPrompt(
  prompt: string,
  options: BrandExportOptions,
  callbacks: BrandExportCallbacks = {},
): Promise<WrittenBrandPackage> {
  const workspaceClient = await createWorkspaceClient({
    ...(options.profile ? { profile: options.profile } : {}),
  });
  const host = (await workspaceClient.config.getHost()).toString();
  const runtime = createWebSearchRuntime({
    ...(options.model ? { model: options.model } : {}),
  });
  let research: BrandResearch | undefined;
  const brandPackage = await generateBrandPackage(
    {
      prompt,
      ...(options.name ? { name: options.name } : {}),
      ...(options.website ? { website: options.website } : {}),
    },
    {
      client: {
        search: (request, signal) =>
          runWebSearch(
            request,
            runtime,
            {
              client: workspaceClient,
              host,
              ...(options.profile ? { cacheIdentity: `profile:${options.profile}` } : {}),
            },
            signal,
            async (event) => {
              if (!isRecord(event)) return;
              const status = typeof event.status === "string" ? event.status : undefined;
              const eventMessage =
                typeof event.message === "string" ? event.message.trim() : undefined;
              const detail = typeof event.detail === "string" ? event.detail.trim() : undefined;
              await callbacks.onProgress?.({
                type: "progress",
                stage: "search",
                message:
                  status === "search" && eventMessage
                    ? `Web search: ${eventMessage}`
                    : `Web search complete${detail ? `: ${detail}` : ""}`,
              });
            },
          ),
        fetch: (request, signal) => runWebFetch(request, runtime, signal),
        fetchAssetPage: (request, signal) => runWebAssetPageFetch(request, runtime, signal),
        fetchImage: (request, signal) => runWebImageFetch(request, runtime, signal),
      },
      workspaceClient,
      ...(options.model ? { model: options.model } : {}),
      maxSources: options.maxSources,
      sourceMaxLength: options.sourceMaxLength,
      ...(callbacks.onProgress ? { onProgress: callbacks.onProgress } : {}),
      onResearch(value) {
        research = value;
      },
    },
  );
  if (!research) throw new Error("Brand generation completed without research provenance");
  const outputDirectory =
    options.output ?? (await mkdtemp(path.join(tmpdir(), "dbx-tools-brand-")));
  return writeBrandPackage({
    outputDirectory,
    prompt,
    brandPackage,
    research,
    showcase: options.showcase,
    force: options.force,
  });
}
