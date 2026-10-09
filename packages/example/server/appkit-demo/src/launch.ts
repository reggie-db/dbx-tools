import { AppKitChildProcess } from "@dbx-tools/appkit/child-process";

const EMOJI = /\p{Extended_Pictographic}\uFE0F?/gu;

export function normalizeProcessOutput(value: string): string {
  return value.replace(EMOJI, "").replace(/^[ \t]+/gm, "");
}

function writeNormalizedLine(destination: NodeJS.WriteStream, line: string): void {
  destination.write(`${normalizeProcessOutput(line)}\n`);
}

const managedProcess = new AppKitChildProcess([
  "bun",
  ["src/server.ts"],
  {
    env: process.env,
    stdin: "inherit",
    stdout: { onLine: (line) => writeNormalizedLine(process.stdout, line), capture: false },
    stderr: { onLine: (line) => writeNormalizedLine(process.stderr, line), capture: false },
  },
]);
const result = await managedProcess.run({ signals: ["SIGINT", "SIGTERM"] });
process.exitCode = result.exitCode;
