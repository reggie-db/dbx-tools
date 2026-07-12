/**
 * OpenAPI scope generator.
 *
 * Scans every package's `src` for `@openapi` JSDoc annotations (the swagger-jsdoc
 * convention - typically on the Express routes in a `server` package). For each
 * annotated package it generates a read-only `packages/openapi/<name>` package:
 *
 *   - `openapi.json`   - the OpenAPI spec (swagger-jsdoc).
 *   - `src/schema.ts`  - types generated from the spec (openapi-typescript).
 *   - `src/client.ts`  - a typed `openapi-fetch` client, usable client-side.
 *
 * AppKit ships no OpenAPI client generator (it uses zod contracts), so this uses
 * the best-of-2026 stack: openapi-typescript + openapi-fetch (openapi-ts.dev).
 * The whole `openapi` scope is generated + read-only; the barrel + projen config
 * are produced by the normal barrels/synth passes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import openapiTS, { astToString } from "openapi-typescript";
import swaggerJsdoc from "swagger-jsdoc";
import { makeReadonly, makeWritable, stampGenerated } from "./generated";
import { logger } from "./log";
import { PACKAGES_DIR, discoverPackagesOnDisk, isModuleFile, walkFiles } from "./workspace";

const log = logger.withTag("projen:openapi");
const ANNOTATION = /@openapi\b/;

const CLIENT_SRC = `import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema";

/** Create a typed OpenAPI client (openapi-fetch); safe to use in the browser. */
export function createApiClient(options?: ClientOptions) {
  return createClient<paths>(options);
}
`;

/** Packages (outside the generated `openapi` scope) whose src has @openapi annotations. */
function annotatedPackages() {
  return discoverPackagesOnDisk()
    .filter((p) => p.scope === "server" || p.scope === "node")
    .map((p) => ({
      pkg: p,
      apis: walkFiles(p.src)
        .filter(isModuleFile)
        .filter((f) => ANNOTATION.test(readFileSync(f, "utf8"))),
    }))
    .filter((p) => p.apis.length > 0);
}

/**
 * Regenerate the `openapi` scope from annotations. Returns the package dirs it
 * wrote (so the caller can re-synth + rebuild just those barrels).
 */
export async function generateOpenapi(): Promise<string[]> {
  const written: string[] = [];
  for (const { pkg, apis } of annotatedPackages()) {
    const spec = swaggerJsdoc({
      definition: {
        openapi: "3.0.0",
        info: { title: `${pkg.scope}/${pkg.name}`, version: "0.0.0" },
      },
      apis,
    }) as Record<string, unknown>;
    spec["x-generated"] = "dbxtools openapi from @openapi annotations - DO NOT EDIT";

    const pkgDir = join(PACKAGES_DIR, "openapi", pkg.name);
    const srcDir = join(pkgDir, "src");
    mkdirSync(srcDir, { recursive: true });

    // openapi.json (JSON can't carry a comment header; note rides as x-generated)
    const specPath = join(pkgDir, "openapi.json");
    makeWritable(specPath);
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
    makeReadonly(specPath);

    // src/schema.ts (types) + src/client.ts (openapi-fetch client)
    const schemaPath = join(srcDir, "schema.ts");
    makeWritable(schemaPath);
    const ast = await openapiTS(spec as unknown as Parameters<typeof openapiTS>[0]);
    writeFileSync(schemaPath, astToString(ast));
    stampGenerated(schemaPath, {
      tool: "dbxtools openapi (openapi-typescript)",
      source: `the @openapi annotations in ${pkg.scope}/${pkg.name}`,
    });

    const clientPath = join(srcDir, "client.ts");
    makeWritable(clientPath);
    writeFileSync(clientPath, CLIENT_SRC);
    stampGenerated(clientPath, {
      tool: "dbxtools openapi (openapi-fetch)",
      source: "./schema",
    });

    written.push(pkgDir);
    log.success(`openapi/${pkg.name} (from ${pkg.scope}/${pkg.name})`);
  }
  if (written.length === 0) log.info("no @openapi annotations found");
  return written;
}

/** True if the changed path is a source file that might carry @openapi annotations. */
export function mayHaveAnnotations(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return (
    /\/packages\/[^/]+\/[^/]+\/src\//.test(p) &&
    !/\/packages\/openapi\//.test(p) &&
    isModuleFile(path) &&
    existsSync(path) &&
    ANNOTATION.test(readFileSync(path, "utf8"))
  );
}
