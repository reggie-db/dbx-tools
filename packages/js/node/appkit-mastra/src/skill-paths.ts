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

/** Organization Assistant root, mounted at its actual workspace path. */
export const ORGANIZATION_ASSISTANT_PATH = "/Workspace/.assistant";

/** Organization skills tree, readable by everyone in the workspace. */
export const ORGANIZATION_SKILLS_PATH = `${ORGANIZATION_ASSISTANT_PATH}/skills`;

/** Workspace home root for one user. */
export function personalWorkspacePath(userEmail: string): string {
  return `/Workspace/Users/${userEmail.trim()}`;
}

/** Personal skills tree owned by one user. */
export function personalSkillsPath(userEmail: string): string {
  return `${personalWorkspacePath(userEmail)}/.assistant/skills`;
}
