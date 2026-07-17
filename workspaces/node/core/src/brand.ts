/** Node-only discovery and file loading for the shared brand context. */
import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { brand as sharedBrand } from "@dbx-tools/shared-core";
import { statSync } from "./file";
import { resolveProjectRoots } from "./project";

const BRAND_CONTEXT_FILES = [
  "branding/brand.yaml",
  "branding/brand.yml",
  "branding/brand.json",
  "brand.yaml",
  "brand.yml",
  "brand.json",
] as const;

export type BrandContext = sharedBrand.BrandContext;
export type BrandContextInput = sharedBrand.BrandContextInput;
export const BrandContextSchema = sharedBrand.BrandContextSchema;
export const defaultBrandContext = sharedBrand.defaultBrandContext;
export const parseBrandContext = sharedBrand.parseBrandContext;
export const brandContextJsonSchema = sharedBrand.brandContextJsonSchema;
export const brandContextPrompt = sharedBrand.brandContextPrompt;

/** Find a conventional YAML or JSON brand file from known project roots. */
export function findBrandContextFile(cwd: string = process.cwd()): string | undefined {
  for (const root of resolveProjectRoots(cwd)) {
    for (const candidate of BRAND_CONTEXT_FILES) {
      const path = resolve(root, candidate);
      if (statSync(path)?.isFile()) return path;
    }
  }
  return undefined;
}

/** Read and validate one `.yaml`, `.yml`, or `.json` brand context file. */
export async function loadBrandContextFile(path: string): Promise<BrandContext> {
  const source = await readFile(path, "utf8");
  const extension = extname(path).toLowerCase();
  let input: unknown;

  if (extension === ".json") input = JSON.parse(source) as unknown;
  else if (extension === ".yaml" || extension === ".yml") {
    const { parse } = await import("yaml");
    input = parse(source) as unknown;
  } else throw new Error(`Unsupported brand context format: ${extension || "no extension"}`);

  return sharedBrand.parseBrandContext(input);
}

/**
 * Discover and load a brand context. Missing files resolve to dbx tools defaults;
 * malformed files fail with their parser or Zod validation error.
 */
export async function loadBrandContext(cwd: string = process.cwd()): Promise<BrandContext> {
  const path = findBrandContextFile(cwd);
  return path ? loadBrandContextFile(path) : sharedBrand.defaultBrandContext;
}

/** Resolve a relative asset reference against the brand file that declared it. */
export function resolveBrandAssetPath(brandFile: string, asset: string): string {
  if (
    isAbsolute(asset) ||
    asset.startsWith("@") ||
    asset.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(asset)
  ) {
    return asset;
  }
  return resolve(dirname(brandFile), asset);
}
