import { brandFiles } from "@dbx-tools/core";
import { brandUtils, type BrandContext } from "@dbx-tools/shared-core";

let activeBrandContext: BrandContext = brandUtils.defaultBrandContext;

export async function loadBrandContext(cwd: string = process.cwd()): Promise<BrandContext> {
  activeBrandContext = await brandFiles.loadBrandContext(cwd);
  return activeBrandContext;
}

export function getBrandContext(): BrandContext {
  return activeBrandContext;
}
