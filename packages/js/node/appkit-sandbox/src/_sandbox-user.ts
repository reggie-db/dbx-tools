import { readPackageResource } from "./_package.ts";

export const SANDBOX_USER = "sandbox-user";
export const SANDBOX_HOME = `/home/${SANDBOX_USER}`;
export const SANDBOX_PROJECTS_ROOT = `${SANDBOX_HOME}/projects`;
export const SANDBOX_STATE_ROOT = `${SANDBOX_HOME}/.dbx-tools`;
export const SANDBOX_USER_SETUP_SCRIPT = readPackageResource("scripts", "setup-sandbox-user.sh");
export const DESKTOP_PREREQUISITES_SCRIPT = readPackageResource(
  "scripts",
  "setup-desktop-prerequisites.sh",
);

const PRIVILEGED_EXECUTION = Symbol("sandbox-privileged-execution");

export interface PrivilegedSandboxExecution {
  readonly [PRIVILEGED_EXECUTION]: true;
}

export const privilegedSandboxExecution: PrivilegedSandboxExecution = Object.freeze({
  [PRIVILEGED_EXECUTION]: true as const,
});

export function isPrivilegedSandboxExecution(value: unknown): value is PrivilegedSandboxExecution {
  return value === privilegedSandboxExecution;
}
