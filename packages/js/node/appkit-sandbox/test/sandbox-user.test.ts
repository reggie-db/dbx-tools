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
    assert.doesNotMatch(SANDBOX_USER_SETUP_SCRIPT, /pkgx|# dbx-tools local bin path/);
  });

  it("installs Homebrew prerequisites and a user-owned prefix", () => {
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /brew_packages="build-essential procps curl file git"/);
    assert.match(
      SANDBOX_USER_SETUP_SCRIPT,
      /apt-get install -y --no-install-recommends \$brew_packages/,
    );
    assert.match(SANDBOX_USER_SETUP_SCRIPT, /brew_prefix=\/home\/linuxbrew\/\.linuxbrew/);
    assert.match(
      SANDBOX_USER_SETUP_SCRIPT,
      /install -d -m 0755 -o "\$user" -g "\$group" "\$brew_prefix"/,
    );
    assert.doesNotMatch(SANDBOX_USER_SETUP_SCRIPT, /Homebrew\/install/);
  });
});
