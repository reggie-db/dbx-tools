/**
 * Standalone researched brand generation for the consolidated CLI.
 *
 * @module
 */

import type { BrandResearch } from "@dbx-tools/appkit-generator";
import { generateBrandPackage } from "@dbx-tools/appkit-generator/generate";
import {
  runWebAssetPageFetch,
  runWebFetch,
  runWebImageFetch,
} from "@dbx-tools/appkit-web-search/fetch";
import { createWebSearchRuntime } from "@dbx-tools/appkit-web-search/runtime";
import { runWebSearch } from "@dbx-tools/appkit-web-search/search";
import { createWorkspaceClient } from "@dbx-tools/databricks/workspace-client";
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
  return writeBrandPackage({
    outputDirectory: options.output,
    prompt,
    brandPackage,
    research,
    force: options.force,
  });
}
