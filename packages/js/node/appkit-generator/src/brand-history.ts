/** Persistent generated-brand history policy. */
import { fnvHashWithOptions } from "@dbx-tools/shared-core";
import {
  BrandHistoryEntrySchema,
  type BrandGenerationRequest,
  type BrandHistoryEntry,
  type BrandPackage,
} from "@dbx-tools/shared-generator";

/** Add or replace one request-derived brand and retain the newest bounded list. */
export function updateBrandHistory(
  current: readonly BrandHistoryEntry[],
  request: BrandGenerationRequest,
  brandPackage: BrandPackage,
  limit: number,
  generatedAt: Date = new Date(),
): BrandHistoryEntry[] {
  const entry = BrandHistoryEntrySchema.parse({
    id: fnvHashWithOptions({ length: 7 }, request),
    request,
    generatedAt: generatedAt.toISOString(),
    package: brandPackage,
  });
  return [entry, ...current.filter(({ id }) => id !== entry.id)].slice(0, limit);
}
