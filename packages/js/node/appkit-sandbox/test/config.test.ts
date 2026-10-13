import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSshPluginConfig } from "../src/config.ts";

describe("resolveSshPluginConfig", () => {
  it("strips AppKit runtime fields and resolves auth fallback defaults", () => {
    const config = resolveSshPluginConfig({ context: {} as never });
    assert.equal(config.fallbackToServicePrincipal, false);
    assert.equal(config.sshTransport, "auto");
    assert.equal(config.ssh2Patch, "auto");
    assert.equal(config.sandboxLifetimeSeconds, 86_400);
    assert.equal(config.reaperIntervalSeconds, 300);
    assert.equal(config.routePrefix, "/sandbox");
    assert.deepEqual(
      config.machineSoftware.map((software) => software.name),
      ["local-bin-path", "mise", "brew", "pkgx"],
    );
    assert.match(config.machineSoftware[0]?.installCommand ?? "", /dbx-tools local bin path/);
    assert.match(config.machineSoftware[0]?.checkCommand ?? "", /\.zshrc/);
    assert.match(config.machineSoftware[1]?.installCommand ?? "", /dbx-tools local bin path/);
    assert.doesNotMatch(
      config.machineSoftware[1]?.installCommand ?? "",
      /dbx-tools mise path|mise activate (?:bash|zsh)/,
    );
    assert.match(config.machineSoftware[1]?.checkCommand ?? "", /\.zshrc/);
    const brew = config.machineSoftware[2]?.installCommand ?? "";
    assert.match(brew, /cd "\$HOME"/);
    assert.match(brew, /NONINTERACTIVE=1 \/bin\/bash -c/);
    assert.match(brew, /raw\.githubusercontent\.com\/Homebrew\/install\/HEAD\/install\.sh/);
    assert.match(brew, /brew shellenv/);
    assert.doesNotMatch(brew, /^\s*sudo |apt-get/m);
    assert.match(config.machineSoftware[2]?.checkCommand ?? "", /dbx-tools homebrew shellenv/);
    assert.match(
      config.machineSoftware[3]?.installCommand ?? "",
      /https:\/\/pkgx\.sh\/\$\(uname\)\/\$\(uname -m\)/,
    );
    assert.equal("context" in config, false);

    const fallback = resolveSshPluginConfig({ fallbackToServicePrincipal: true });
    assert.equal(fallback.fallbackToServicePrincipal, true);

    const withoutSetup = resolveSshPluginConfig({ machineSoftware: [] });
    assert.deepEqual(withoutSetup.machineSoftware, []);
  });

  it("resolves case-insensitive SSH policy from scoped configUtils keys", () => {
    const previousTransport = process.env.DBX_TOOLS_SANDBOX_SSH_TRANSPORT;
    const previousPatch = process.env.DBX_TOOLS_SANDBOX_SSH_SSH2_PATCH;
    process.env.DBX_TOOLS_SANDBOX_SSH_TRANSPORT = " SsH2 ";
    process.env.DBX_TOOLS_SANDBOX_SSH_SSH2_PATCH = " TrUe ";
    try {
      const configured = resolveSshPluginConfig();
      assert.equal(configured.sshTransport, "ssh2");
      assert.equal(configured.ssh2Patch, "true");

      const explicit = resolveSshPluginConfig({
        sshTransport: "OPENSSH",
        ssh2Patch: "FALSE",
      });
      assert.equal(explicit.sshTransport, "openssh");
      assert.equal(explicit.ssh2Patch, "false");
    } finally {
      restoreEnvironment("DBX_TOOLS_SANDBOX_SSH_TRANSPORT", previousTransport);
      restoreEnvironment("DBX_TOOLS_SANDBOX_SSH_SSH2_PATCH", previousPatch);
    }
  });

  it("rejects invalid SSH policy values", () => {
    assert.throws(() => resolveSshPluginConfig({ sshTransport: "native" }));
    assert.throws(() => resolveSshPluginConfig({ ssh2Patch: "yes" }));
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
