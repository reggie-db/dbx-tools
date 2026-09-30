import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

const packageRoot = resolve(import.meta.dirname, "..");
const bun = process.execPath;

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, {
    cwd,
    env: { ...process.env },
    stdio: "pipe",
  });
}

it("loads packed AppKit surfaces from an isolated consumer", { timeout: 180_000 }, () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "dbx-tools-appkit-consumer-"));
  const archives = join(temporaryRoot, "archives");
  const consumer = join(temporaryRoot, "consumer");
  mkdirSync(archives, { recursive: true });
  mkdirSync(consumer, { recursive: true });

  try {
    run(bun, ["run", "compile"], packageRoot);
    const manifestPath = join(packageRoot, "package.json");
    const manifest = readFileSync(manifestPath);
    const manifestMode = statSync(manifestPath).mode;
    chmodSync(manifestPath, 0o644);
    try {
      run(bun, ["pm", "pack", "--ignore-scripts", "--destination", archives], packageRoot);
    } finally {
      writeFileSync(manifestPath, manifest);
      chmodSync(manifestPath, manifestMode);
    }
    const archive = join(
      archives,
      readdirSync(archives).find((file) => file.endsWith(".tgz"))!,
    );
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "appkit-packed-consumer",
          private: true,
          type: "module",
          dependencies: {
            "@databricks/appkit": "0.81.0",
            "@databricks/appkit-ui": "0.81.0",
            "@dbx-tools/appkit": `file:${archive}`,
            react: "~19.2.4",
            "react-dom": "~19.2.4",
            vitest: "^3.2.4",
          },
          devDependencies: {
            "@types/bun": "1.3.14",
            "@types/react": "^19.2.2",
            "@types/react-dom": "^19.2.2",
            tailwindcss: "^4.3.2",
            "tw-animate-css": "^1.4.0",
            typescript: "^5.9.3",
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(consumer, "server.test.ts"),
      [
        'import { test, expect } from "bun:test";',
        'import * as appkit from "@databricks/appkit";',
        'import * as beta from "@databricks/appkit/beta";',
        'import * as testing from "@databricks/appkit/testing";',
        'import * as tsdown from "@databricks/appkit/tsdown";',
        'import * as dbxAppkit from "@dbx-tools/appkit";',
        'test("public exports", () => {',
        "  expect(typeof appkit.createApp).toBe('function');",
        "  expect(typeof beta.createAgent).toBe('function');",
        "  expect(typeof testing.createTestPlugin).toBe('function');",
        "  expect(typeof tsdown.appkitServerConfig).toBe('function');",
        "  expect(typeof dbxAppkit.appkit.createApp).toBe('function');",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(consumer, "browser.tsx"),
      [
        'import { Button } from "@databricks/appkit-ui/react";',
        'import * as beta from "@databricks/appkit-ui/react/beta";',
        'import "@databricks/appkit-ui/styles.css";',
        "export const surface = { Button, beta };",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            allowImportingTsExtensions: true,
            jsx: "react-jsx",
            lib: ["ES2022", "DOM"],
            module: "ESNext",
            moduleResolution: "bundler",
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: "ES2022",
            types: ["bun"],
          },
          include: ["*.ts", "*.tsx"],
        },
        null,
        2,
      )}\n`,
    );

    run(bun, ["install"], consumer);
    run(bun, ["test", "server.test.ts"], consumer);
    run(bun, ["x", "tsc", "--noEmit"], consumer);
    run(bun, ["build", "browser.tsx", "--target", "browser", "--outdir", "dist"], consumer);
    assert.ok(readdirSync(join(consumer, "dist")).some((file) => file.endsWith(".js")));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
