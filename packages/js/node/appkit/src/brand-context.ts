import { brandFiles } from "@dbx-tools/core";
import { brandUtils, type BrandContext } from "@dbx-tools/shared-core";

let activeBrandContext: BrandContext = brandUtils.defaultBrandContext;

/** Load and activate the brand context found from the supplied directory. */
export async function loadBrandContext(cwd: string = process.cwd()): Promise<BrandContext> {
  activeBrandContext = await brandFiles.loadBrandContext(cwd);
  return activeBrandContext;
}

/** Return the currently active brand context. */
export function getBrandContext(): BrandContext {
  return activeBrandContext;
}
