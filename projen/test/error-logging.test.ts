import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { findFiles } from "@dbx-tools/path";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "../..");
const LOG_METHODS = new Set(["debug", "info", "warn", "warning", "error", "fatal"]);

function lossyExceptionLogs(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const issues: string[] = [];

  function report(node: ts.Node, reason: string): void {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    issues.push(`${file}:${line + 1}: ${reason}`);
  }

  function isToErrorCall(node: ts.Node): boolean {
    return (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sourceFile) === "errorUtils" &&
      node.expression.name.text === "toError"
    );
  }

  function isNormalized(identifier: ts.Identifier, call: ts.CallExpression): boolean {
    let current: ts.Node | undefined = identifier.parent;
    while (current && current !== call) {
      if (isToErrorCall(current)) return true;
      current = current.parent;
    }
    return false;
  }

  function isIdentifierReference(identifier: ts.Identifier): boolean {
    const parent = identifier.parent;
    if (ts.isPropertyAssignment(parent) && parent.name === identifier) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
    return true;
  }

  function isLoggerCall(node: ts.Node): node is ts.CallExpression {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    if (!LOG_METHODS.has(node.expression.name.text)) return false;
    const receiver = node.expression.expression.getText(sourceFile);
    return receiver === "log" || receiver === "logger" || receiver.endsWith(".logger");
  }

  function inspectLogCall(call: ts.CallExpression, rejectedNames = new Set<string>()): void {
    function inspect(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sourceFile) === "errorUtils" &&
        node.expression.name.text === "errorMessage"
      ) {
        report(node, "pass errorUtils.toError(...) to the logger instead of errorMessage(...)");
      }
      if (ts.isConditionalExpression(node) && /instanceof\s+Error/.test(node.getText(sourceFile))) {
        report(node, "pass the caught value through errorUtils.toError(...)");
      }
      if (
        ts.isIdentifier(node) &&
        isIdentifierReference(node) &&
        rejectedNames.has(node.text) &&
        !isNormalized(node, call)
      ) {
        report(node, `normalize rejected value ${node.text} with errorUtils.toError(...)`);
      }
      if (ts.isPropertyAssignment(node)) {
        const name = node.name.getText(sourceFile).replace(/^['"]|['"]$/g, "");
        if (name === "stack" || name === "errorMessage") {
          report(node, `log the Error object instead of a separate ${name} field`);
        }
        if (
          (name === "error" || name === "message") &&
          ts.isPropertyAccessExpression(node.initializer) &&
          node.initializer.name.text === "message"
        ) {
          report(node, "log the Error object instead of its message");
        }
        if (
          name === "error" &&
          ts.isPropertyAccessExpression(node.initializer) &&
          node.initializer.name.text === "reason"
        ) {
          report(node, "normalize rejected result.reason with errorUtils.toError(...)");
        }
      }
      ts.forEachChild(node, inspect);
    }
    for (const argument of call.arguments) inspect(argument);
  }

  function inspectRejectedCallback(callback: ts.Expression | undefined): void {
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return;
    const parameter = callback.parameters[0]?.name;
    if (!parameter || !ts.isIdentifier(parameter)) return;
    const rejectedNames = new Set([parameter.text]);
    function visitCallback(node: ts.Node): void {
      if (isLoggerCall(node)) {
        inspectLogCall(node, rejectedNames);
      }
      ts.forEachChild(node, visitCallback);
    }
    visitCallback(callback.body);
  }

  function visit(node: ts.Node): void {
    if (ts.isCatchClause(node) && node.variableDeclaration?.name) {
      const binding = node.variableDeclaration.name;
      if (ts.isIdentifier(binding)) {
        const rejectedNames = new Set([binding.text]);
        function visitCatch(child: ts.Node): void {
          if (isLoggerCall(child)) {
            inspectLogCall(child, rejectedNames);
          }
          ts.forEachChild(child, visitCatch);
        }
        visitCatch(node.block);
      }
    }
    if (isLoggerCall(node)) {
      inspectLogCall(node);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === "catch") inspectRejectedCallback(node.arguments[0]);
      if (node.expression.name.text === "then") inspectRejectedCallback(node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return issues;
}

describe("error logging", () => {
  it("keeps exception objects and stack traces in logs", async () => {
    const issues: string[] = [];
    for (const pattern of [
      "packages/**/*.{ts,tsx,js,mjs,cjs}",
      "projen/**/*.{ts,tsx,js,mjs,cjs}",
    ]) {
      for await (const file of findFiles(pattern, {
        cwd: ROOT,
        ignore: ["**/lib/**", "**/dist/**", "**/_generated/**", "**/node_modules/**"],
        ignoreOptions: { test: false },
      })) {
        issues.push(...lossyExceptionLogs(file, readFileSync(resolve(ROOT, file), "utf8")));
      }
    }

    assert.deepEqual(issues, []);
  });
});
