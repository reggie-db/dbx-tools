import type { LakeboxEntry } from "./rest.ts";

const MANAGED_PREFIX = "dbx-lakebox-";

/**
 * Derives the deterministic display name of an application's managed Lakebox.
 *
 * The Lakebox ID is assigned by Databricks, so discovery matches this exact
 * name among Lakeboxes visible to the app service principal.
 */
export function lakeboxManagedName(application: string): string {
  const slug = application
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 200);
  if (!slug) throw new Error("A managed Lakebox requires a non-empty application name");
  return `${MANAGED_PREFIX}${slug}`;
}

/**
 * Selects the managed Lakebox from a listing.
 *
 * When concurrent replicas raced to create it, the oldest entry wins so every
 * replica converges on the same Lakebox.
 */
export function selectManagedLakebox(
  entries: readonly LakeboxEntry[],
  name: string,
): LakeboxEntry | undefined {
  return entries
    .filter((entry) => entry.name === name)
    .sort(
      (left, right) =>
        (Date.parse(left.createTime ?? "") || Number.MAX_SAFE_INTEGER) -
          (Date.parse(right.createTime ?? "") || Number.MAX_SAFE_INTEGER) ||
        left.sandboxId.localeCompare(right.sandboxId),
    )[0];
}
