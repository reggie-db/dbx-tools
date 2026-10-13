import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exec } from "../../index.ts";

const [mode, readyPath, signalPath, childId] = process.argv.slice(2);
const fixturePath = fileURLToPath(import.meta.url);

if (mode === "child") {
  const id = childId ?? "child";
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"] as const) {
    process.on(signal, () => {
      appendFileSync(signalPath!, `${id}:${signal}\n`);
      process.exit(0);
    });
  }
  if (readyPath !== "-") {
    writeFileSync(
      readyPath!,
      JSON.stringify({ parentPid: process.ppid, pids: [process.pid], listenerCount: 0 }),
    );
  }
  process.stdout.write("ready\n");
  setInterval(() => undefined, 1_000);
} else if (mode === "sync-default") {
  exec.spawnSync(process.execPath, [fixturePath, "child", readyPath!, signalPath!, "sync"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
} else {
  const count = mode === "async-default" ? 2 : mode === "async-errors" ? 3 : 1;
  const forwardTerminationSignals = mode !== "async-disabled";
  const baselineListenerCount = process.listenerCount("SIGTERM");
  const pids: number[] = [];
  const children = [];
  const ready = Array.from({ length: count }, (_, index) => {
    return new Promise<void>((resolve) => {
      const child = exec.spawn(
        process.execPath,
        [fixturePath, "child", "-", signalPath!, String(index)],
        {
          stdin: "ignore",
          stdout: { capture: false, onLine: () => resolve() },
          stderr: "ignore",
          forwardTerminationSignals,
          terminateTimeout: 1_000,
          killTimeout: 1_000,
        },
      );
      pids.push(child.pid!);
      children.push(child);
    });
  });
  await Promise.all(ready);
  if (mode === "async-errors") {
    children[0]!.shutdown = () => {
      throw new Error("synthetic synchronous shutdown failure");
    };
    children[1]!.shutdown = () => Promise.reject(new Error("synthetic shutdown rejection"));
    process.on("unhandledRejection", () => appendFileSync(signalPath!, "unhandled-rejection\n"));
    process.on("SIGTERM", () => {
      appendFileSync(signalPath!, "parent-listener:SIGTERM\n");
      setTimeout(() => process.exit(0), 750);
    });
  }
  writeFileSync(
    readyPath!,
    JSON.stringify({
      parentPid: process.pid,
      pids,
      listenerCount: process.listenerCount("SIGTERM"),
      baselineListenerCount,
    }),
  );
  setInterval(() => undefined, 1_000);
}
