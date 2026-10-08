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
    detached: true,
    env: process.env,
    stdin: "inherit",
    stdout: { onLine: (line) => writeNormalizedLine(process.stdout, line), capture: false },
    stderr: { onLine: (line) => writeNormalizedLine(process.stderr, line), capture: false },
  },
]);
const child = managedProcess.start();
let stopping = false;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const handler = () => {
    if (stopping) return;
    stopping = true;
    for (const [name, callback] of signalHandlers) process.off(name, callback);
    void managedProcess
      .shutdown()
      .catch((error) => console.error(error))
      .finally(() => process.kill(process.pid, signal));
  };
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}

void child.then((result) => {
  if (!stopping) process.exitCode = result.exitCode ?? (child.signalCode ? 1 : 0);
});
