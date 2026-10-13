import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPrivilegedSandboxExecution,
  privilegedSandboxExecution,
  SANDBOX_HOME,
  SANDBOX_PROJECTS_ROOT,
  SANDBOX_USER,
  SANDBOX_USER_SETUP_SCRIPT,
} from "../src/_sandbox-user.ts";

describe("Sandbox user provisioning", () => {
  it("owns one fixed unprivileged identity and absolute home", () => {
    assert.equal(SANDBOX_USER, "sandbox-user");
    assert.equal(SANDBOX_HOME, "/home/sandbox-user");
    assert.equal(SANDBOX_PROJECTS_ROOT, "/home/sandbox-user/projects");
    assert.equal(isPrivilegedSandboxExecution(privilegedSandboxExecution), true);
    assert.equal(isPrivilegedSandboxExecution({}), false);
  });

  it("uses check-lock-check and removes privileged group membership", () => {
    const firstCheck = SANDBOX_USER_SETUP_SCRIPT.indexOf("if is_ready; then");
    const lock = SANDBOX_USER_SETUP_SCRIPT.indexOf('while ! mkdir "$lock"');
    const secondCheck = SANDBOX_USER_SETUP_SCRIPT.indexOf("if is_ready; then", firstCheck + 1);

    assert.ok(firstCheck >= 0);
    assert.ok(lock > firstCheck);
    assert.ok(secondCheck > lock);
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /useradd --create-home/);
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /passwd --lock/);
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /sudo wheel admin/);
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /ALL=\(ALL:ALL\) !ALL/);
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /visudo -cf/);
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /chmod 0700 \/root/);
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /find "\$source" -type l/);
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /chown -R --no-dereference/);
  });

  it("installs pkgx during privileged provisioning", () => {
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /command -v pkgx/);
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /apt-get install -y --no-install-recommends/);
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /ca-certificates curl/);
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /curl -fsS https:\/\/pkgx\.sh \| sh/);
  });
});
