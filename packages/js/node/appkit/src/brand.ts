import { brand as coreBrand } from "@dbx-tools/core";
import { brand as sharedBrand, type BrandContext } from "@dbx-tools/shared-core";

let activeBrandContext: BrandContext = sharedBrand.defaultBrandContext;

export async function loadBrandContext(cwd: string = process.cwd()): Promise<BrandContext> {
  activeBrandContext = await coreBrand.loadBrandContext(cwd);
  return activeBrandContext;
}

export function getBrandContext(): BrandContext {
  return activeBrandContext;
}
