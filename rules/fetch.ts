import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const [mode, tool, output, input, lock] = process.argv.slice(2);
const directory = resolve(output!);
mkdirSync(directory, { recursive: true });
const run = (args: string[], env = process.env) => {
  const result = spawnSync(resolve(tool!), args, { cwd: directory, encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 });
  process.stdout.write((result.stdout ?? "").replace(/\p{Extended_Pictographic}/gu, ""));
  process.stderr.write((result.stderr ?? "").replace(/\p{Extended_Pictographic}/gu, ""));
  if (result.status !== 0) throw new Error(`${mode} dependency fetch failed (${result.status}): ${result.error?.message ?? "see output"}`);
};
if (mode === "bun") {
  const dependencies = JSON.parse(readFileSync(resolve(input!), "utf8"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, dependencies }));
  if (lock) copyFileSync(resolve(lock), join(directory, "bun.lock"));
  run(["install", "--ignore-scripts", "--no-progress", ...(lock ? ["--frozen-lockfile"] : [])]);
} else {
  const requirements = JSON.parse(readFileSync(resolve(input!), "utf8")) as string[];
  const env = { ...process.env };
  // BUCK requirements and locks are complete inputs; user-level constraints would add undeclared packages.
  delete env.PIP_CONSTRAINT;
  delete env.UV_CONSTRAINT;
  run(["pip", "install", "--no-compile", "--target", directory,
    ...(lock ? ["--require-hashes", "--no-deps", "--requirements", resolve(lock)] : requirements)], env);
}
