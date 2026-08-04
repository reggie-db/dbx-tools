/**
 * Where Databricks Assistant `SKILL.md` trees live.
 *
 * Two modules need these paths and must agree on them: `workspaces.ts` MOUNTS
 * them per request (see `DEFAULT_SKILL_FOLDERS`), and `remote-skills.ts`
 * WRITES provisioned skills into them at startup. They were previously spelled
 * out in both, so a change to one silently provisioned skills into a tree the
 * other never scanned.
 *
 * @module
 */

/** Shared Assistant skills tree, readable by everyone in the workspace. */
export const ASSISTANT_SHARED_SKILLS_PATH = "/Workspace/.assistant/skills";

/** Assistant skills tree owned by one user (the "save this as a skill" target). */
export function userAssistantSkillsPath(userEmail: string): string {
  return `/Users/${userEmail.trim()}/.assistant/skills`;
}
