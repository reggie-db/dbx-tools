import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [tool, input, output] = process.argv.slice(2);
const requirements = JSON.parse(readFileSync(input!, "utf8"));
const result = spawnSync(resolve(tool!), ["pip", "compile", "-", "--generate-hashes", "--no-header", "--output-file", resolve(output!)], {
  input: requirements.join("\n"), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
process.stdout.write((result.stdout ?? "").replace(/\p{Extended_Pictographic}/gu, ""));
process.stderr.write((result.stderr ?? "").replace(/\p{Extended_Pictographic}/gu, ""));
process.exitCode = result.status ?? 1;
