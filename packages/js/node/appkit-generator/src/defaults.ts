/**
 * AppKit interceptor settings for researched brand generation.
 *
 * @module
 */

import type { BrandGenerationRequest } from "@dbx-tools/shared-generator";
import { brandRequestSubject } from "./schema.ts";

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

/** Maximum persisted generated brands retained per user. */
export const BRAND_HISTORY_LIMIT = 12;

/** Persistence lifetime for one user's generated-brand history. */
export const BRAND_HISTORY_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Cache-key version for persisted generated-brand history. */
export const BRAND_HISTORY_VERSION = 1;

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
