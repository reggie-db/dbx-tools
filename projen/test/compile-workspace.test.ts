import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import type { TaskSpec } from "projen";
import { compilePlan } from "../tasks/compile-workspace.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("batches plain TypeScript tasks and preserves custom and newly added workspaces", () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-compile-"));
  fixtures.push(root);
  const members = ["packages/plain", "packages/custom", "packages/lifecycle", "packages/no-script"];
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: members }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));
  for (const member of members) mkdirSync(join(root, member, ".projen"), { recursive: true });
  writeFileSync(
    join(root, members[0]!, "package.json"),
    JSON.stringify({ name: "@fixture/plain", scripts: { compile: "projen compile" } }),
  );
  writeFileSync(
    join(root, members[0]!, ".projen/tasks.json"),
    JSON.stringify({ tasks: { compile: { steps: [{ execArgs: ["tsc", "--build"] }] } } }),
  );
  writeFileSync(
    join(root, members[1]!, "package.json"),
    JSON.stringify({ name: "@fixture/custom", scripts: { compile: "projen compile" } }),
  );
  writeFileSync(
    join(root, members[1]!, ".projen/tasks.json"),
    JSON.stringify({ tasks: { compile: { steps: [{ exec: "bun build.ts" }] } } }),
  );
  writeFileSync(
    join(root, members[2]!, "package.json"),
    JSON.stringify({ name: "@fixture/lifecycle", scripts: { compile: "projen compile" } }),
  );
  writeFileSync(
    join(root, members[2]!, ".projen/tasks.json"),
    JSON.stringify({
      tasks: {
        "pre-compile": { steps: [{ exec: "bun generate.ts" }] },
        compile: { steps: [{ execArgs: ["tsc", "--build"] }] },
      },
    }),
  );
  writeFileSync(join(root, members[3]!, "package.json"), JSON.stringify({ name: "@fixture/no" }));

  const plan = compilePlan(root);
  assert.deepEqual(plan.typescriptConfigs, [
    join(root, "tsconfig.json"),
    join(root, members[0]!, "tsconfig.json"),
  ]);
  assert.deepEqual(plan.customPackages, [
    { name: "@fixture/custom", directory: join(root, members[1]!) },
    { name: "@fixture/lifecycle", directory: join(root, members[2]!) },
  ]);

  mkdirSync(join(root, "packages/added", ".projen"), { recursive: true });
  writeFileSync(
    join(root, "packages/added/package.json"),
    JSON.stringify({ name: "@fixture/added", scripts: { compile: "bun build.ts" } }),
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: [...members, "packages/added"] }),
  );
  assert.equal(compilePlan(root).customPackages.at(-1)?.name, "@fixture/added");
});

for (const taskName of ["pre-compile", "compile", "post-compile"]) {
  for (const [option, value] of Object.entries({
    condition: "exit 1",
    cwd: "generated",
    env: { NODE_OPTIONS: "--max-old-space-size=4096" },
    requiredEnv: ["COMPILER_READY"],
    shell: "system",
  } satisfies Partial<TaskSpec>)) {
    it(`preserves native Projen ${taskName} ${option} behavior instead of batching`, () => {
      const root = mkdtempSync(join(tmpdir(), "workspace-compile-"));
      fixtures.push(root);
      const member = "packages/conditional";
      mkdirSync(join(root, member, ".projen"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [member] }));
      writeFileSync(
        join(root, member, "package.json"),
        JSON.stringify({ name: "@fixture/conditional", scripts: { compile: "projen compile" } }),
      );
      const tasks: Record<string, TaskSpec> = {
        compile: { name: "compile", steps: [{ execArgs: ["tsc", "--build"] }] },
      };
      tasks[taskName] = { ...tasks[taskName], name: taskName, [option]: value };
      writeFileSync(join(root, member, ".projen/tasks.json"), JSON.stringify({ tasks }));
      assert.deepEqual(compilePlan(root), {
        typescriptConfigs: [],
        customPackages: [{ name: "@fixture/conditional", directory: join(root, member) }],
      });
    });
  }
}
