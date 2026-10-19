/**
 * Brand package filesystem export.
 *
 * @module
 */

import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrandResearch } from "@dbx-tools/appkit-generator";
import type { BrandPackage } from "@dbx-tools/shared-generator";
import { BrandPackageSchema } from "@dbx-tools/shared-generator";
import { stringify } from "yaml";

/** Inputs required to write a generated brand package. */
export interface WriteBrandPackageOptions {
  readonly outputDirectory: string;
  readonly prompt: string;
  readonly brandPackage: BrandPackage;
  readonly research: BrandResearch;
  readonly force?: boolean;
}

/** Files written for a generated brand package. */
export interface WrittenBrandPackage {
  readonly outputDirectory: string;
  readonly brandYamlPath: string;
  readonly manifestPath: string;
  readonly referenceCount: number;
}

function imageExtension(contentType?: string): string {
  if (!contentType) return ".img";
  const normalized = contentType.split(";", 1)[0].trim().toLowerCase();
  switch (normalized) {
    case "image/avif":
      return ".avif";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/svg+xml":
      return ".svg";
    case "image/webp":
      return ".webp";
    default:
      return ".img";
  }
}

function fileSlug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "reference"
  );
}

async function writeAtomic(filePath: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, filePath);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a normal `brand.yaml` plus research provenance and downloaded visual
 * references.
 */
export async function writeBrandPackage(
  options: WriteBrandPackageOptions,
): Promise<WrittenBrandPackage> {
  const outputDirectory = path.resolve(options.outputDirectory);
  const brandYamlPath = path.join(outputDirectory, "brand.yaml");
  const packageExists = await fileExists(brandYamlPath);
  if (packageExists && !options.force) {
    throw new Error(`Brand package already exists at ${brandYamlPath}; pass --force to replace it`);
  }
  if (options.force) {
    await rm(path.join(outputDirectory, "references"), { recursive: true, force: true });
  }

  const visualReferences = structuredClone(options.brandPackage.visualReferences);
  let referenceCount = 0;
  for (
    let referenceIndex = 0;
    referenceIndex < options.research.visualReferences.length;
    referenceIndex += 1
  ) {
    const researchReference = options.research.visualReferences[referenceIndex];
    const exportedReference = visualReferences[referenceIndex];
    if (!exportedReference) continue;
    for (let imageIndex = 0; imageIndex < researchReference.images.length; imageIndex += 1) {
      const researchImage = researchReference.images[imageIndex];
      const exportedImage = exportedReference.images[imageIndex];
      if (!exportedImage || !researchImage.data) continue;
      const fileName = `${fileSlug(researchReference.appName)}-${imageIndex + 1}${imageExtension(researchImage.contentType)}`;
      const relativePath = path.posix.join("references", researchReference.platform, fileName);
      await writeAtomic(path.join(outputDirectory, relativePath), researchImage.data);
      exportedImage.localPath = `./${relativePath}`;
      referenceCount += 1;
    }
  }

  const brandPackage = BrandPackageSchema.parse({
    ...options.brandPackage,
    visualReferences,
  });
  const manifestPath = path.join(outputDirectory, "brand-package.json");
  await writeAtomic(brandYamlPath, stringify(brandPackage.brand, { indent: 2 }));
  await writeAtomic(
    manifestPath,
    `${JSON.stringify(
      {
        prompt: options.prompt,
        generatedAt: new Date().toISOString(),
        ...brandPackage,
      },
      null,
      2,
    )}\n`,
  );

  return {
    outputDirectory,
    brandYamlPath,
    manifestPath,
    referenceCount,
  };
}
