/**
 * Where Databricks Assistant `SKILL.md` trees live.
 *
 * Two modules need these paths and must agree on them: `workspaces.ts` MOUNTS
 * them per request (see `DEFAULT_SKILL_FOLDERS`), and `remote-skills.ts`
 * WRITES provisioned skills into them at startup. They live here rather than being
 * spelled out in both, where a change to one would silently provision skills into a
 * tree the other never scanned.
 *
 * @module
 */

/** Shared Assistant skills tree, readable by everyone in the workspace. */
export const ASSISTANT_SHARED_SKILLS_PATH = "/Workspace/.assistant/skills";

/** Assistant skills tree owned by one user (the "save this as a skill" target). */
export function userAssistantSkillsPath(userEmail: string): string {
  return `/Users/${userEmail.trim()}/.assistant/skills`;
}
