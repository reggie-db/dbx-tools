/**
 * Module export detection via `@typescript-eslint/typescript-estree`.
 *
 * Used by the barrel generator to skip source files that do not export anything.
 * Parses each candidate module into an ESTree-compatible AST and checks only
 * top-level `Program.body` statements — no regex or hand-rolled token scanning.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";

const require = createRequire(import.meta.url);

/** Top-level statement types that make a file a re-exportable module. */
const EXPORT_STATEMENT_TYPES = new Set([
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "ExportAllDeclaration",
  "TSExportAssignment",
]);

// Lazy so importing this module during synth does not require the parser yet.
let parseFn: ((code: string, options?: Record<string, unknown>) => { body: { type: string }[] }) | undefined;
function parse(code: string, file: string): { body: { type: string }[] } {
  parseFn ??= require("@typescript-eslint/typescript-estree").parse;
  const ext = extname(file).toLowerCase();
  return parseFn!(code, {
    filePath: file,
    jsx: ext === ".tsx" || ext === ".jsx",
    loc: false,
    range: false,
    errorOnUnknownASTType: false,
  });
}

/** True when the file has at least one top-level export statement. */
export function hasExport(file: string): boolean {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return false;
  }

  try {
    return parse(source, file).body.some((stmt) => EXPORT_STATEMENT_TYPES.has(stmt.type));
  } catch {
    return false;
  }
}
