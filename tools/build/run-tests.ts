import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const uv = resolve(process.argv[2]!);
const pins = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
const directory = resolve(process.argv[4]!);
const files = [
  ...new Bun.Glob("**/*.test.ts").scanSync({ cwd: directory }),
  ...new Bun.Glob("**/*.test.tsx").scanSync({ cwd: directory }),
  ...new Bun.Glob("**/*.spec.ts").scanSync({ cwd: directory }),
  ...new Bun.Glob("**/*.spec.tsx").scanSync({ cwd: directory }),
].sort();

const python = spawnSync(uv, ["python", "find", pins.python], { encoding: "utf8" });
if (python.status !== 0) process.exit(python.status ?? 1);
const pythonInfo = spawnSync(
  python.stdout.trim(),
  [
    "-c",
    "import json, os, sys, sysconfig; print(json.dumps({'basePrefix': sys.base_prefix, 'library': os.path.join(sysconfig.get_config_var('LIBDIR'), sysconfig.get_config_var('LDLIBRARY')), 'prefix': sys.prefix}))",
  ],
  { encoding: "utf8" },
);
if (pythonInfo.status !== 0) process.exit(pythonInfo.status ?? 1);
const info = JSON.parse(pythonInfo.stdout);
const env = {
  ...process.env,
  BUN_PYTHON_PATH: info.library,
  PYTHONHOME: info.basePrefix,
  VIRTUAL_ENV: info.prefix,
};

for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ["--preserve-symlinks", "test", resolve(directory, file)],
    { encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 },
  );
  process.stdout.write((result.stdout ?? "").replace(/\p{Extended_Pictographic}/gu, ""));
  process.stderr.write((result.stderr ?? "").replace(/\p{Extended_Pictographic}/gu, ""));
  if (result.status !== 0) process.exit(result.status ?? 1);
}
