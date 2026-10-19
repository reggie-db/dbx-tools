import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { BrandResearch } from "@dbx-tools/appkit-generator";
import type { BrandPackage } from "@dbx-tools/shared-generator";
import { parse } from "yaml";

import { buildProgram } from "../src/brand/cli.ts";
import { writeBrandPackage } from "../src/brand/export.ts";

const brandPackage: BrandPackage = {
  brand: {
    schemaVersion: "1",
    name: "Acme",
    shortName: "Acme",
    tagline: "Tools for careful builders.",
    description: "Acme makes tools for application engineering teams.",
    colors: {
      primary: "#102A43",
      primaryHover: "#0B5CAD",
      accent: "#00A972",
      foreground: "#102A43",
      background: "#FFFFFF",
      surface: "#F5F7FA",
      muted: "#52667A",
      border: "#D8E0E8",
    },
    typography: {
      sans: "'Inter', ui-sans-serif, system-ui, sans-serif",
      mono: "'IBM Plex Mono', ui-monospace, monospace",
    },
    voice: {
      audience: ["application engineers"],
      tone: ["direct"],
      principles: ["Lead with the result."],
      avoid: ["unsupported claims"],
    },
    assets: {
      icon: { light: "https://acme.example/icon.svg" },
      logo: { light: "https://acme.example/logo.svg" },
      favicon: "https://acme.example/favicon.ico",
    },
    links: {
      website: "https://acme.example/",
      documentation: "https://acme.example/docs",
    },
    extensions: {},
  },
  sources: [
    {
      url: "https://acme.example/",
      title: "Acme",
      fetched: true,
    },
  ],
  visualReferences: [
    {
      platform: "ios",
      appName: "Acme Mobile",
      pageUrl: "https://apps.apple.com/us/app/acme/id123",
      images: [
        {
          url: "https://images.example/acme.png",
          contentType: "image/png",
        },
      ],
    },
  ],
};

const research: BrandResearch = {
  answer: "Acme reference evidence",
  model: "databricks-gemini",
  officialPageUrl: "https://acme.example/",
  sources: [
    {
      url: "https://acme.example/",
      title: "Acme",
      fetched: true,
      content: "Acme source",
    },
  ],
  visualReferences: [
    {
      platform: "ios",
      appName: "Acme Mobile",
      pageUrl: "https://apps.apple.com/us/app/acme/id123",
      images: [
        {
          url: "https://images.example/acme.png",
          contentType: "image/png",
          data: new Uint8Array([137, 80, 78, 71]),
        },
      ],
    },
  ],
};

describe("brand CLI", () => {
  it("parses a freeform prompt and export options", async () => {
    const calls: unknown[] = [];
    await buildProgram("dbx brand", {
      async exportBrandFromPrompt(prompt, options, callbacks) {
        calls.push({ prompt, options });
        await callbacks.onProgress?.({
          type: "progress",
          stage: "visuals",
          message: "Reviewing visual references",
        });
        return {
          outputDirectory: "/tmp/brand",
          brandYamlPath: "/tmp/brand/brand.yaml",
          manifestPath: "/tmp/brand/brand-package.json",
          referenceCount: 2,
        };
      },
      writeProgress: (value) => calls.push(value),
      writeResult: (value) => calls.push(value),
    }).parseAsync(
      [
        "A regional coffee company for commuters",
        "--name",
        "Acme Coffee",
        "--output",
        "branding/acme",
        "--profile",
        "TEST",
        "--max-sources",
        "3",
      ],
      { from: "user" },
    );

    assert.deepEqual(calls, [
      {
        prompt: "A regional coffee company for commuters",
        options: {
          name: "Acme Coffee",
          output: "branding/acme",
          profile: "TEST",
          maxSources: 3,
          sourceMaxLength: 8_000,
          force: false,
        },
      },
      "[visuals] Reviewing visual references",
      {
        brand: "/tmp/brand/brand.yaml",
        manifest: "/tmp/brand/brand-package.json",
        references: 2,
      },
    ]);
  });

  it("writes brand.yaml and downloaded mobile references", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dbx-brand-"));
    try {
      const result = await writeBrandPackage({
        outputDirectory: root,
        prompt: "Acme",
        brandPackage,
        research,
      });
      const yaml = parse(await readFile(result.brandYamlPath, "utf8")) as {
        name: string;
      };
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
        visualReferences: Array<{ images: Array<{ localPath?: string }> }>;
      };
      const localPath = manifest.visualReferences[0]?.images[0]?.localPath;

      assert.equal(yaml.name, "Acme");
      assert.equal(localPath, "./references/ios/acme-mobile-1.png");
      assert.deepEqual(
        new Uint8Array(await readFile(path.join(root, localPath!))),
        new Uint8Array([137, 80, 78, 71]),
      );
      assert.equal(result.referenceCount, 1);
      await assert.rejects(
        writeBrandPackage({
          outputDirectory: root,
          prompt: "Acme",
          brandPackage,
          research,
        }),
        /--force/,
      );
      const staleReference = path.join(root, "references", "ios", "stale.png");
      await writeFile(staleReference, new Uint8Array([1]));
      await writeBrandPackage({
        outputDirectory: root,
        prompt: "Acme",
        brandPackage,
        research,
        force: true,
      });
      await assert.rejects(readFile(staleReference), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
