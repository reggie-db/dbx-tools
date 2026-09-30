import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

function stableBunExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, process.platform === "win32" ? "bun.exe" : "bun");
    if (!existsSync(candidate)) continue;
    const resolved = realpathSync(candidate);
    const normalized = resolved.replaceAll("\\", "/");
    if (!normalized.includes("/node_modules/") && !/\/(?:private\/)?tmp\/bun-node-/.test(normalized)) {
      return resolved;
    }
  }
  return process.execPath;
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const child = spawn(process.execPath, ["x", "--bun", "@bazel/bazelisk@1.28.1", ...args], {
  cwd: root,
  env: { ...process.env, DBX_BUN_EXECUTABLE: stableBunExecutable() },
  stdio: ["inherit", "pipe", "pipe"],
});
for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
  input.setEncoding("utf8");
  input.on("data", (text: string) => output.write(text.replace(/\p{Extended_Pictographic}/gu, "")));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
