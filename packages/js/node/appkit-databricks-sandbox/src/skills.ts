import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalSkillDirectoryMount } from "@dbx-tools/appkit-mastra";

/** Default agent-workspace path for packaged Databricks Sandbox recipes. */
export const DATABRICKS_SANDBOX_SKILLS_MOUNT = "/.dbx-tools/skills";

/** Returns the packaged Databricks Sandbox recipe tree as a Mastra local skill mount. */
export function databricksSandboxSkillMounts(): LocalSkillDirectoryMount[] {
  return [{ root: databricksSandboxSkillsRoot(), mountPath: DATABRICKS_SANDBOX_SKILLS_MOUNT }];
}

function databricksSandboxSkillsRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../skills"),
    resolve(moduleDirectory, "../../skills"),
  ];
  const root = candidates.find((candidate) => existsSync(candidate));
  if (!root) throw new Error("Packaged Databricks Sandbox skills are unavailable");
  return root;
}
