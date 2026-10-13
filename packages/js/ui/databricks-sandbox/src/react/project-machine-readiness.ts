import type { SshMachine } from "@dbx-tools/shared-databricks-sandbox";

/** Ensures a project's machine is running before the project request begins. */
export async function ensureProjectMachineRunning(
  machines: readonly SshMachine[],
  machineId: string,
  start: (machineId: string) => Promise<SshMachine>,
  update: (machine: SshMachine) => void,
): Promise<SshMachine> {
  const current = machines.find((machine) => machine.id === machineId);
  if (current?.status === "running") return current;
  if (current) {
    update({ ...current, status: "starting", canStart: false, canStop: true });
  }
  const running = await start(machineId);
  if (running.status !== "running") {
    throw new Error(`Sandbox machine ${machineId} did not reach the running state`);
  }
  update(running);
  return running;
}
