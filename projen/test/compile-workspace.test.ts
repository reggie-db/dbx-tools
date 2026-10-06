import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { compilePlan } from "../tasks/compile-workspace.ts";

it("batches plain TypeScript tasks and preserves custom and newly added workspaces", () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-compile-"));
  const members = ["packages/plain", "packages/custom", "packages/lifecycle", "packages/no-script"];
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: members }));
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
  assert.deepEqual(plan.typescriptConfigs, [join(root, members[0]!, "tsconfig.json")]);
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
