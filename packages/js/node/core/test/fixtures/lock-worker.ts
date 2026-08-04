/** Worker fixture: locks a key shared with the main thread, then reports. */
import { parentPort, workerData } from "node:worker_threads";

import { withProcessLock } from "../../src/process-lock.ts";

const data = workerData as { passthrough?: string };
parentPort?.postMessage(`workerData:${data.passthrough}`);
await withProcessLock("cross-thread", async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
});
parentPort?.postMessage("worker:done");
