/**
 * Codegen generator (ts-to-zod based).
 *
 * Scans every workspace package whose `package.json` declares a `codegen`
 * field and turns the listed upstream `.d.ts` inputs into read-only `src/`
 * modules of zod schemas plus matching inferred TypeScript types. Each input
 * emits one `src/<name>.ts` (schemas + `export type X = z.infer<typeof
 * xSchema>` lines); barrelsby then namespaces it into the package's root
 * barrel like any other `src/` module (`sdkModel.dashboards.genieMessageSchema`).
 *
 * The single source of truth for "which packages get generated content, from
 * which inputs" is each consumer's own `package.json`:
 *
 *   {
 *     "name": "@dbx-tools/shared-sdk-model",
 *     "codegen": {
 *       "inputs": [
 *         "node_modules/@databricks/sdk-experimental/dist/apis/dashboards/model.d.ts"
 *       ]
 *     }
 *   }
 *
 * Each entry under `inputs` is a path (relative to the package for
 * `node_modules/...`, else repo-root-relative), optionally suffixed with
 * `=<name>` to override the auto-derived basename:
 *
 *   - `apis/dashboards/model.d.ts`     -> `src/dashboards.ts`
 *   - `apis/dashboards/model.d.ts=foo` -> `src/foo.ts`
 *
 * Generated modules are written read-only with the standard do-not-edit header
 * (see `./generated`), so they are indistinguishable from any other generated
 * file and hand-written `src/` modules (writable) are never touched. Stale
 * generated modules from a removed input are cleaned up on each run.
 *
 * Each input is preprocessed with the TypeScript compiler API before ts-to-zod
 * sees it: every `import` declaration is dropped, and any type reference whose
 * root identifier was introduced by one of those imports is rewritten to
 * `unknown` (codegen output is a pure data-shape surface; peer SDK runtime
 * modules don't belong here).
 *
 * `ts-to-zod` and `typescript` are loaded lazily (heavy, and only needed when
 * codegen actually runs), so importing this module stays cheap. Codegen runs as
 * part of synth's post-synthesize pass (see `GeneratedSource` in `project.ts`);
 * SDK `.d.ts` inputs change rarely, so there's no separate task or watcher.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import type * as ts from "typescript";
import { header, isReadonly, makeReadonly, makeWritable } from "./generated";
import { logger } from "./log";
import { repoRoot, workspacePackages } from "./workspace";

const log = logger.withTag("projen:codegen");

/** Do-not-edit banner stamped on every generated codegen module. */
const HEADER = header({
  tool: "dbxtools codegen (ts-to-zod)",
  source: "the upstream .d.ts declared in package.json codegen.inputs",
});

interface CodegenInput {
  /** Absolute path to the source `.d.ts` file. */
  source: string;
  /** Output basename (e.g. `dashboards` -> emits `src/dashboards.ts`). */
  name: string;
}

/** Read a package's `package.json` `codegen.inputs`, or `undefined` if absent. */
function codegenInputs(dir: string): string[] | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      codegen?: { inputs?: string[] };
    };
    const inputs = manifest.codegen?.inputs;
    return inputs?.length ? inputs : undefined;
  } catch {
    return undefined;
  }
}

function deriveName(path: string): string {
  const file = basename(path);
  // SDK convention: `apis/<api>/model.d.ts`. Use the parent directory's name
  // so `apis/dashboards/model.d.ts` -> `dashboards`.
  if (file === "model.d.ts" || file === "model.ts") return basename(dirname(path));
  return file.replace(/\.d\.ts$|\.ts$/, "");
}

function parseInputArg(value: string): CodegenInput {
  const eq = value.indexOf("=");
  if (eq === -1) return { source: value, name: deriveName(value) };
  return { source: value.slice(0, eq), name: value.slice(eq + 1) };
}

/**
 * Resolve a codegen input to an absolute path. A `node_modules/...` source is
 * searched for in each `node_modules` from the consuming package up to the
 * filesystem root, so it resolves whether the dependency is nested under the
 * package or hoisted to the workspace root. Any other source is treated as
 * repo-root-relative.
 */
function resolveInputSource(source: string, fromDir: string): string {
  if (source.startsWith("node_modules/")) {
    let dir = fromDir;
    for (;;) {
      const candidate = resolve(dir, source);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(repoRoot, source);
}

/**
 * Parse `entryPath` as TypeScript, drop every `import` declaration, and rewrite
 * any type reference whose root identifier was introduced by one of those
 * imports to the `unknown` keyword. ts-to-zod then sees a self-contained source
 * where the dropped peer modules surface as `z.unknown()` schemas.
 */
function stripImports(tsRuntime: typeof ts, entryPath: string): string {
  const text = readFileSync(entryPath, "utf-8");
  const sf = tsRuntime.createSourceFile(
    entryPath,
    text,
    tsRuntime.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    tsRuntime.ScriptKind.TS,
  );

  const namespaceAliases = new Set<string>();
  const importedNames = new Set<string>();
  for (const stmt of sf.statements) {
    if (!tsRuntime.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const c = stmt.importClause;
    if (c.name) importedNames.add(c.name.text);
    const nb = c.namedBindings;
    if (!nb) continue;
    if (tsRuntime.isNamespaceImport(nb)) {
      namespaceAliases.add(nb.name.text);
    } else {
      for (const el of nb.elements) importedNames.add(el.name.text);
    }
  }

  const unknownType = (): ts.KeywordTypeNode =>
    tsRuntime.factory.createKeywordTypeNode(tsRuntime.SyntaxKind.UnknownKeyword);

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => (root) => {
    const visitor: ts.Visitor = (node) => {
      if (tsRuntime.isImportDeclaration(node)) return undefined;

      // `ns.X` / `X` in TYPE position -> `unknown`, only when the root
      // identifier came from an import; local declarations stay untouched.
      if (tsRuntime.isTypeReferenceNode(node)) {
        const tn = node.typeName;
        if (
          tsRuntime.isQualifiedName(tn) &&
          tsRuntime.isIdentifier(tn.left) &&
          namespaceAliases.has(tn.left.text)
        ) {
          return unknownType();
        }
        if (tsRuntime.isIdentifier(tn) && importedNames.has(tn.text)) {
          return unknownType();
        }
      }

      // `ns.X` in VALUE position: drop the namespace prefix so ts-to-zod sees a
      // bare identifier.
      if (
        tsRuntime.isPropertyAccessExpression(node) &&
        tsRuntime.isIdentifier(node.expression) &&
        namespaceAliases.has(node.expression.text)
      ) {
        return node.name;
      }

      return tsRuntime.visitEachChild(node, visitor, context);
    };
    return tsRuntime.visitEachChild(root, visitor, context);
  };

  const result = tsRuntime.transform(sf, [transformer]);
  const printer = tsRuntime.createPrinter({ removeComments: false });
  const transformed = result.transformed[0] ?? sf;
  const out = printer.printFile(transformed);
  result.dispose();
  return out;
}

/**
 * Final shaping before ts-to-zod sees the source:
 *
 *   1. Promote every top-level `interface` / `type` to an `export` (ts-to-zod
 *      only emits schemas for exported declarations and bails on exported types
 *      referencing non-exported ones).
 *   2. Rewrite each JSDoc block so its leading prose becomes a single
 *      `@description` tag (ts-to-zod emits a matching `.describe(...)` call).
 *      The original prose is dropped so it doesn't appear twice. Other tags
 *      (`@minimum`, `@format`, ...) flow through verbatim.
 */
function preprocess(source: string): string {
  const out = source.replace(/^(interface|type)\s/gm, "export $1 ");
  return out.replace(/\/\*\*([\s\S]*?)\*\//g, (match, body: string) => {
    if (/@description\b/.test(body)) return match;

    const lines = body
      .replace(/^\n/, "")
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").replace(/\s+$/, ""));

    const firstTagIdx = lines.findIndex((line) => /^@\w+/.test(line));
    const descLines = firstTagIdx === -1 ? lines : lines.slice(0, firstTagIdx);
    const tagLines = firstTagIdx === -1 ? [] : lines.slice(firstTagIdx);

    const description = descLines.join(" ").replace(/\s+/g, " ").trim();
    if (!description) return match;

    const rebuilt = [`@description ${description}`, ...tagLines];
    return `/**\n${rebuilt.map((line) => ` * ${line}`.trimEnd()).join("\n")}\n */`;
  });
}

/**
 * Take ts-to-zod's `getInferredTypes(...)` output - shaped for a separate file
 * (banner, `import { z } from "zod"`, `import * as generated from "<schemas>"`,
 * then `export type X = z.infer<typeof generated.xSchema>` lines) - and rewrite
 * it for inclusion in the same file as the schemas: drop the banner and both
 * imports, and drop the `generated.` namespace prefix from every reference so
 * the type aliases bind to the colocated schema constants.
 */
function inlineInferredTypes(inferredFile: string): string {
  return inferredFile
    .replace(/^\/\/ Generated by ts-to-zod\s*\n/, "")
    .replace(/^import \{ z \} from "zod";\s*\n+/m, "")
    .replace(/^import \* as generated from "[^"]*";\s*\n+/m, "")
    .replace(/\bgenerated\.(\w+)/g, "$1")
    .trim();
}

/** True if `<srcDir>/<file>` is a codegen-generated module (read-only + our header). */
function isGeneratedModule(srcDir: string, file: string): boolean {
  if (!file.endsWith(".ts")) return false;
  const path = join(srcDir, file);
  if (!isReadonly(path)) return false;
  try {
    return readFileSync(path, "utf8").startsWith("// GENERATED by dbxtools codegen");
  } catch {
    return false;
  }
}

/**
 * Regenerate the codegen `src/` modules for one consumer package. The
 * package's `package.json` is read-only - the `inputs` list comes out, nothing
 * flows back. Returns the package dir so the caller can rebuild its barrel.
 */
function generatePackage(
  tsRuntime: typeof ts,
  generate: typeof import("ts-to-zod").generate,
  dir: string,
  inputs: string[],
): string {
  const parsed = inputs.map(parseInputArg);
  const srcDir = resolve(dir, "src");
  mkdirSync(srcDir, { recursive: true });

  // Remove prior generated modules (read-only + our header) so a dropped input
  // can't leave a stale module behind. Hand-written `src/` files stay writable
  // and are never matched, so they're left alone.
  const emitted = new Set(parsed.map((input) => `${input.name}.ts`));
  for (const file of readdirSync(srcDir)) {
    if (!emitted.has(file) && isGeneratedModule(srcDir, file)) {
      makeWritable(join(srcDir, file));
      rmSync(join(srcDir, file));
    }
  }

  let warnings = 0;
  for (const input of parsed) {
    const sourcePath = resolveInputSource(input.source, dir);
    if (!existsSync(sourcePath)) {
      throw new Error(`codegen input not found: ${input.source}`);
    }

    const sourceText = preprocess(stripImports(tsRuntime, sourcePath));
    const { getZodSchemasFile, getInferredTypes, errors } = generate({
      sourceText,
      // Carry JSDoc through so the `@description` tag stays visible alongside
      // the matching `.describe(...)`.
      keepComments: true,
    });
    if (errors.length) {
      warnings += errors.length;
      for (const err of errors) log.warn(`  ! ${err}`);
    }

    // ts-to-zod adds an import line only when the source references external
    // types; bundling makes everything self-contained, so this is never read.
    const importPath = `./${input.name}.js`;
    const schemas = getZodSchemasFile(importPath);
    const inferred = inlineInferredTypes(getInferredTypes(importPath));
    const content = HEADER + "\n" + schemas.trimEnd() + "\n\n" + inferred + "\n";
    const outPath = resolve(srcDir, `${input.name}.ts`);
    makeWritable(outPath);
    writeFileSync(outPath, content);
    makeReadonly(outPath);
  }

  log.success(
    `${basename(dir)}: ${parsed.length} module(s)` + (warnings ? ` (${warnings} warning(s))` : ""),
  );
  return dir;
}

/**
 * Regenerate the `generated/` tree for every workspace package declaring a
 * `codegen` field. Returns the package dirs it wrote so the caller can rebuild
 * their barrels. `ts-to-zod` + `typescript` are lazy-loaded.
 */
export function generateCodegen(): string[] {
  const targets = workspacePackages()
    .map((p) => ({ dir: p.dir, inputs: codegenInputs(p.dir) }))
    .filter((t): t is { dir: string; inputs: string[] } => t.inputs !== undefined);

  if (targets.length === 0) {
    log.info("no workspace packages declare a `codegen` field");
    return [];
  }

  const require = createRequire(import.meta.url);
  const tsRuntime = require("typescript") as typeof ts;
  const { generate } = require("ts-to-zod") as typeof import("ts-to-zod");

  const written: string[] = [];
  for (const target of targets) {
    written.push(generatePackage(tsRuntime, generate, target.dir, target.inputs));
  }
  return written;
}
