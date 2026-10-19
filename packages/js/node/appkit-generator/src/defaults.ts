/**
 * AppKit interceptor settings for researched brand generation.
 *
 * @module
 */

import { brandRequestSubject, type BrandGenerationRequest } from "./schema.ts";

/** AppKit execute configuration used by this package. */
export type BrandExecuteConfig = {
  cache?: { enabled?: boolean; ttl?: number; cacheKey?: (string | number | object)[] };
  retry?: { enabled?: boolean; attempts?: number; initialDelay?: number; maxDelay?: number };
  timeout?: number;
};

/** Execution settings accepted by `Plugin.execute()`. */
export type BrandExecutionSettings = {
  default: BrandExecuteConfig;
  user?: BrandExecuteConfig;
};

/** Cache lifetime for a generated branding package. */
export const BRAND_CACHE_TTL_SECONDS = 21_600;

/** Cache-key version for the generated package shape and asset policy. */
export const BRAND_CACHE_VERSION = 5;

/** Attempts for the idempotent structured synthesis call. */
export const BRAND_GENERATION_ATTEMPTS = 2;

/** Build request-specific interceptor settings for brand generation. */
export function brandGenerationSettings(
  request: BrandGenerationRequest,
  options: {
    timeoutMs: number;
    model?: string;
    maxSources: number;
    sourceMaxLength: number;
  },
): BrandExecutionSettings {
  return {
    default: {
      cache: {
        enabled: true,
        ttl: BRAND_CACHE_TTL_SECONDS,
        cacheKey: [
          "brand",
          "generate",
          BRAND_CACHE_VERSION,
          brandRequestSubject(request).toLowerCase(),
          request.website ?? "",
          options.model ?? "",
          options.maxSources,
          options.sourceMaxLength,
        ],
      },
      retry: { enabled: true, attempts: BRAND_GENERATION_ATTEMPTS },
      timeout: options.timeoutMs,
    },
  };
}
