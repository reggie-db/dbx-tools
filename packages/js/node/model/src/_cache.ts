import { projectCache } from "@dbx-tools/cache";

/** Memory-first cache for endpoint catalogues, isolated for full invalidation. */
export const modelCatalogueCache = projectCache("model-catalog", {
  maxEntries: 256,
  useClone: false,
});

/** One memory-first project cache shared by every model metadata key. */
export const modelMetadataCache = projectCache("model-metadata", {
  maxEntries: 256,
  useClone: false,
});
