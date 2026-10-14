import type { LakeboxCommandResult } from "@dbx-tools/shared-lakebox";
import { SshCommand } from "../src/session.ts";

export function completedSshCommand(
  command: string,
  args: string[],
  result: Partial<Omit<LakeboxCommandResult, "command" | "args">> = {},
): SshCommand {
  const exitCode = result.exitCode ?? 0;
  return new SshCommand(command, args, { timeoutMs: 1_000 }, async (execution) => {
    if (result.stdout) execution.stdout(result.stdout);
    if (result.stderr) execution.stderr(result.stderr);
    return exitCode;
  });
}
