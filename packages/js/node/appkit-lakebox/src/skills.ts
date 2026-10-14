import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalSkillDirectoryMount } from "@dbx-tools/appkit-mastra";

/** Default agent-workspace path for packaged Lakebox service recipes. */
export const LAKEBOX_SKILLS_MOUNT = "/.dbx-tools/skills";

/** Returns the packaged Lakebox recipe tree as a Mastra local skill mount. */
export function lakeboxSkillMounts(): LocalSkillDirectoryMount[] {
  return [{ root: lakeboxSkillsRoot(), mountPath: LAKEBOX_SKILLS_MOUNT }];
}

function lakeboxSkillsRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../skills"),
    resolve(moduleDirectory, "../../skills"),
  ];
  const root = candidates.find((candidate) => existsSync(candidate));
  if (!root) throw new Error("Packaged Lakebox skills are unavailable");
  return root;
}
