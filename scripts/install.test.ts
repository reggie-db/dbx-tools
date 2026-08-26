/// <reference types="bun" />
/// <reference types="node" />

import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  ensureCommand,
  getMiseInstallPath,
  getMiseReleaseAsset,
  log,
  parseCommandVersion,
  updateManagedProfileText,
} from "./install.ts";

const SCRIPT_PATH = join(import.meta.dir, "install.ts");
const dockerIt = process.env.RUN_DOCKER_INSTALL_TESTS === "1" ? it : it.skip;

interface InstallerRunOptions {
  args?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  installPath?: string;
  path?: string;
  shell?: string;
}

interface InstallerRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function findMiseExecutable(): Promise<string> {
  const child = Bun.spawn(["which", "mise"], { stdout: "pipe" });
  const output = (await new Response(child.stdout).text()).trim();
  assert.equal(await child.exited, 0);
  return output;
}

async function runInstaller(
  home: string,
  options: InstallerRunOptions = {},
): Promise<InstallerRunResult> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    MISE_INSTALL_PATH: options.installPath,
    PATH: options.path ?? process.env.PATH,
    SHELL: options.shell ?? "/bin/zsh",
    ...options.environment,
  };
  for (const name of [
    "MISE_INSTALL_NO_MODIFY_PATH",
    "MISE_INSTALL_SHELL",
    "XDG_CONFIG_HOME",
    "ZDOTDIR",
  ]) {
    if (!(name in (options.environment ?? {}))) delete environment[name];
  }
  const child = Bun.spawn([process.execPath, SCRIPT_PATH, ...(options.args ?? [])], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function withTemporaryHome(callback: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "mise-test-"));
  try {
    await callback(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function withEnvironment(
  values: NodeJS.ProcessEnv,
  callback: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("mise install paths", () => {
  it("uses the official Unix default and exact override", () => {
    assert.equal(
      getMiseInstallPath({ HOME: "/home/example" }, "linux"),
      "/home/example/.local/bin/mise",
    );
    assert.equal(
      getMiseInstallPath({
        HOME: "/home/example",
        MISE_INSTALL_PATH: "/opt/mise/bin/mise",
      }),
      "/opt/mise/bin/mise",
    );
    assert.equal(
      getMiseInstallPath({ HOME: "/home/example", MISE_INSTALL_PATH: "" }),
      "/home/example/.local/bin/mise",
    );
    assert.equal(getMiseInstallPath({ HOME: "/home/example", MISE_INSTALL_PATH: "  " }), "  ");
  });

  it("uses the selected Windows per-user path and fallbacks", () => {
    assert.equal(
      getMiseInstallPath(
        {
          LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
          USERPROFILE: "C:\\Users\\example",
        },
        "win32",
      ),
      "C:\\Users\\example\\AppData\\Local\\mise\\bin\\mise.exe",
    );
    assert.equal(
      getMiseInstallPath({ USERPROFILE: "C:\\Users\\example" }, "win32"),
      "C:\\Users\\example\\AppData\\Local\\mise\\bin\\mise.exe",
    );
    assert.equal(
      getMiseInstallPath({ MISE_INSTALL_PATH: "D:\\tools\\custom-mise.exe" }, "win32"),
      "D:\\tools\\custom-mise.exe",
    );
  });
});

describe("mise release assets", () => {
  it("builds every supported asset shape", () => {
    assert.equal(
      getMiseReleaseAsset("2026.8.5", "darwin", "x64"),
      "mise-v2026.8.5-macos-x64.tar.gz",
    );
    assert.equal(
      getMiseReleaseAsset("2026.8.5", "darwin", "arm64"),
      "mise-v2026.8.5-macos-arm64.tar.gz",
    );
    assert.equal(
      getMiseReleaseAsset("2026.8.5", "linux", "x64", true),
      "mise-v2026.8.5-linux-x64-musl.tar.gz",
    );
    assert.equal(
      getMiseReleaseAsset("2026.8.5", "linux", "arm", false),
      "mise-v2026.8.5-linux-armv7.tar.gz",
    );
    assert.equal(getMiseReleaseAsset("2026.8.5", "win32", "x64"), "mise-v2026.8.5-windows-x64.exe");
    assert.equal(
      getMiseReleaseAsset("2026.8.5", "win32", "arm64"),
      "mise-v2026.8.5-windows-arm64.exe",
    );
  });

  it("rejects unsupported targets", () => {
    assert.throws(() => getMiseReleaseAsset("2026.8.5", "win32", "arm"));
    assert.throws(() => getMiseReleaseAsset("2026.8.5", "freebsd", "x64"));
  });
});

describe("mise-backed commands", () => {
  it("parses versions from stdout before stderr", () => {
    assert.equal(
      parseCommandVersion({
        stdout: "caddy v2.10.2 h1:checksum",
        stderr: "build 2026.8.5",
      }),
      "2.10.2",
    );
    assert.equal(parseCommandVersion({ stdout: "", stderr: "tool version 1.9" }), "1.9");
    assert.equal(
      parseCommandVersion({
        stdout: "tool 1.2.3 runtime 20.11.1",
        stderr: "",
      }),
      "1.2.3",
    );
    assert.equal(parseCommandVersion({ stdout: "caddy v2.10.2-0", stderr: "" }), "2.10.2-0");
  });

  it("returns an acceptable PATH command without invoking mise", async () => {
    await withTemporaryHome(async (home) => {
      const bin = join(home, "bin");
      const miseTouched = join(home, "mise-touched");
      await mkdir(bin);
      const caddy = join(bin, "caddy");
      await Bun.write(caddy, "#!/bin/sh\necho caddy v2.10.2\n");
      await chmod(caddy, 0o755);
      const mise = join(bin, "mise");
      await Bun.write(
        mise,
        `#!/bin/sh
touch "${miseTouched}"
exit 0
`,
      );
      await chmod(mise, 0o755);

      await withEnvironment(
        {
          MISE_INSTALL_PATH: undefined,
          PATH: `${bin}:/usr/bin:/bin`,
        },
        async () => {
          assert.equal(await ensureCommand("caddy", "2.10.0"), caddy);
        },
      );
      await assert.rejects(access(miseTouched));
    });
  });

  it("installs a missing or outdated command with the selected mise tool", async () => {
    await withTemporaryHome(async (home) => {
      const bin = join(home, "bin");
      const installedBin = join(home, "installed", "bin");
      const installedCaddy = join(installedBin, "caddy");
      const miseUsed = join(home, "mise-used");
      await mkdir(bin);
      const caddy = join(bin, "caddy");
      await Bun.write(caddy, "#!/bin/sh\necho caddy v2.10.2-0\n");
      await chmod(caddy, 0o755);
      const mise = join(bin, "mise");
      await Bun.write(
        mise,
        `#!/bin/sh
set -eu
if [ "$1" = use ] && [ "\${2:-}" = --help ]; then
  exit 0
fi
if [ "$1" = use ]; then
  mkdir -p "${installedBin}"
  printf '%s\\n' '#!/bin/sh' 'echo caddy v2.10.2' > "${installedCaddy}"
  chmod +x "${installedCaddy}"
  printf '%s\\n' "$*" > "${miseUsed}"
  exit 0
fi
if [ "$1" = which ]; then
  echo "${installedCaddy}"
  exit 0
fi
exit 1
`,
      );
      await chmod(mise, 0o755);

      await withEnvironment(
        {
          MISE_INSTALL_PATH: undefined,
          PATH: `${bin}:/usr/bin:/bin`,
        },
        async () => {
          assert.equal(
            await ensureCommand("caddy", "2.10.2", {
              miseTool: "github:caddyserver/caddy",
            }),
            installedCaddy,
          );
        },
      );
      assert.equal(
        (await readFile(miseUsed, "utf8")).trim(),
        "use -g --yes -- github:caddyserver/caddy",
      );
    });
  });

  it("supports a custom version command and validates minimum versions", async () => {
    await withTemporaryHome(async (home) => {
      const bin = join(home, "bin");
      await mkdir(bin);
      const command = join(bin, "custom-tool");
      await Bun.write(command, '#!/bin/sh\n[ "$1" = version ] && echo custom-tool 3.4.5\n');
      await chmod(command, 0o755);
      await withEnvironment({ PATH: `${bin}:/usr/bin:/bin` }, async () => {
        assert.equal(
          await ensureCommand("custom-tool", "3.4.0", {
            versionCommand: "version",
          }),
          command,
        );
        await assert.rejects(
          ensureCommand("custom-tool", "not-a-version"),
          /invalid minimum version/,
        );
      });
    });
  });

  it("rejects direct command paths and option-shaped mise tools", async () => {
    await assert.rejects(ensureCommand("/opt/caddy", "2.10.0"), /bare executable name/);
    await assert.rejects(
      ensureCommand("caddy", "2.10.0", { miseTool: "--remove=node" }),
      /non-option tool specification/,
    );
  });
});

describe("installer CLI", () => {
  it("prints a valid PATH caddy without invoking mise", async () => {
    await withTemporaryHome(async (home) => {
      const bin = join(home, "bin");
      const miseTouched = join(home, "mise-touched");
      await mkdir(bin);
      const caddy = join(bin, "caddy");
      await Bun.write(caddy, '#!/bin/sh\n[ "$1" = version ] && echo caddy v2.10.2\n');
      await chmod(caddy, 0o755);
      const mise = join(bin, "mise");
      await Bun.write(
        mise,
        `#!/bin/sh
touch "${miseTouched}"
exit 0
`,
      );
      await chmod(mise, 0o755);

      const result = await runInstaller(home, {
        args: ["caddy", "--minVersion", "2.10.2", "--versionCommand", "version"],
        installPath: undefined,
        path: `${bin}:/usr/bin:/bin`,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, `${caddy}\n`);
      await assert.rejects(access(miseTouched));
    });
  });

  it("accepts any program with default version settings", async () => {
    await withTemporaryHome(async (home) => {
      const bin = join(home, "bin");
      const miseTouched = join(home, "mise-touched");
      await mkdir(bin);
      const node = join(bin, "node");
      await Bun.write(node, "#!/bin/sh\necho v22.0.0\n");
      await chmod(node, 0o755);
      const mise = join(bin, "mise");
      await Bun.write(
        mise,
        `#!/bin/sh
touch "${miseTouched}"
exit 0
`,
      );
      await chmod(mise, 0o755);

      const result = await runInstaller(home, {
        args: ["node"],
        path: `${bin}:/usr/bin:/bin`,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, `${node}\n`);
      await assert.rejects(access(miseTouched));
    });
  });

  it("prints help and rejects extra positional arguments", async () => {
    await withTemporaryHome(async (home) => {
      const help = await runInstaller(home, { args: ["--help"] });
      assert.equal(help.exitCode, 0, help.stderr);
      assert.match(help.stdout, /scripts\/install\.ts node/);

      const invalid = await runInstaller(home, {
        args: ["node", "extra"],
      });
      assert.equal(invalid.exitCode, 2);
      assert.match(invalid.stderr, /invalid command/);
      assert.equal(invalid.stdout, "");
    });
  });
});

describe("managed profile blocks", () => {
  const lines = [
    "export PATH='/home/example/.local/bin':\"$PATH\"",
    'eval "$(/home/example/.local/bin/mise activate zsh --shims)"',
  ];

  it("appends once and preserves unrelated content", () => {
    const original = "export EXISTING=1\n";
    const updated = updateManagedProfileText(original, lines);
    assert.match(updated, /^export EXISTING=1/m);
    assert.equal(updateManagedProfileText(updated, lines), updated);
  });

  it("replaces only standalone installer markers", () => {
    const inlineMarker = 'echo "# >>> mise installer >>>"\n';
    const updated = updateManagedProfileText(inlineMarker, lines);
    assert.match(updated, /^echo /);
    assert.match(updated, /# <<< mise installer <<</);
  });

  it("rejects partial and duplicate marker blocks", () => {
    assert.throws(() => updateManagedProfileText("# >>> mise installer >>>\n", lines));
    assert.throws(() =>
      updateManagedProfileText(
        "# >>> mise installer >>>\n# >>> mise installer >>>\n# <<< mise installer <<<\n",
        lines,
      ),
    );
  });
});

describe("logging", () => {
  it("supports an injected writer and adds one newline", () => {
    let output = "";
    log("message", {
      writer: (message) => {
        output += message;
      },
    });
    assert.equal(output, "message\n");
  });
});

describe("Unix shell profiles", () => {
  it("configures zsh login and interactive profiles idempotently", async () => {
    await withTemporaryHome(async (home) => {
      const mise = await findMiseExecutable();
      const first = await runInstaller(home, { installPath: mise });
      assert.equal(first.exitCode, 0, first.stderr);
      assert.match(first.stdout, /export PATH=/);
      assert.match(first.stdout, /activate zsh/);

      const zprofile = await readFile(join(home, ".zprofile"), "utf8");
      const zshrc = await readFile(join(home, ".zshrc"), "utf8");
      assert.match(zprofile, /activate zsh --shims/);
      assert.match(zprofile, /export PATH=/);
      assert.match(zshrc, /activate zsh\)/);
      assert.doesNotMatch(zshrc, /--shims/);

      const second = await runInstaller(home, { installPath: mise });
      assert.equal(second.exitCode, 0, second.stderr);
      assert.equal(second.stdout, "");
      assert.equal(second.stderr, "");
      assert.equal(await readFile(join(home, ".zprofile"), "utf8"), zprofile);
      assert.equal(await readFile(join(home, ".zshrc"), "utf8"), zshrc);
    });
  });

  it("uses ZDOTDIR for both zsh profiles", async () => {
    await withTemporaryHome(async (home) => {
      const mise = await findMiseExecutable();
      const zdotdir = join(home, "zsh");
      const result = await runInstaller(home, {
        installPath: mise,
        environment: { ZDOTDIR: zdotdir },
      });
      assert.equal(result.exitCode, 0, result.stderr);
      await access(join(zdotdir, ".zprofile"));
      await access(join(zdotdir, ".zshrc"));
    });
  });

  it("chooses the first existing bash login profile", async () => {
    await withTemporaryHome(async (home) => {
      const mise = await findMiseExecutable();
      await writeFile(join(home, ".bash_login"), "export EXISTING=1\n");
      await writeFile(join(home, ".profile"), "export FALLBACK=1\n");
      const result = await runInstaller(home, {
        installPath: mise,
        shell: "/bin/bash",
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(await readFile(join(home, ".bash_login"), "utf8"), /activate bash --shims/);
      assert.equal(await readFile(join(home, ".profile"), "utf8"), "export FALLBACK=1\n");
      assert.match(await readFile(join(home, ".bashrc"), "utf8"), /activate bash\)/);
    });
  });

  it("creates .profile when bash has no login profile", async () => {
    await withTemporaryHome(async (home) => {
      const result = await runInstaller(home, {
        installPath: await findMiseExecutable(),
        shell: "/bin/bash",
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(await readFile(join(home, ".profile"), "utf8"), /activate bash --shims/);
    });
  });

  it("uses XDG_CONFIG_HOME for fish and emits fish-native commands", async () => {
    await withTemporaryHome(async (home) => {
      const configHome = join(home, "config");
      const result = await runInstaller(home, {
        installPath: await findMiseExecutable(),
        shell: "/usr/bin/fish",
        environment: {
          MISE_INSTALL_SHELL: "fish",
          XDG_CONFIG_HOME: configHome,
        },
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /fish_add_path --path/);
      assert.match(result.stdout, /activate fish \| source/);
      assert.doesNotMatch(result.stdout, /case ":\$PATH:"/);
      assert.match(
        await readFile(join(configHome, "fish", "config.fish"), "utf8"),
        /activate fish \| source/,
      );
    });
  });

  it("uses PATH-only setup for an unknown shell", async () => {
    await withTemporaryHome(async (home) => {
      const result = await runInstaller(home, {
        installPath: await findMiseExecutable(),
        shell: "/bin/dash",
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(await readFile(join(home, ".profile"), "utf8"), /export PATH=/);
      assert.doesNotMatch(result.stdout, /activate/);
    });
  });

  it("honors MISE_INSTALL_NO_MODIFY_PATH", async () => {
    await withTemporaryHome(async (home) => {
      const mise = await findMiseExecutable();
      const result = await runInstaller(home, {
        installPath: mise,
        path: `${dirname(mise)}:${process.env.PATH ?? ""}`,
        environment: { MISE_INSTALL_NO_MODIFY_PATH: "true" },
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, "");
      await assert.rejects(access(join(home, ".zprofile")));
      await assert.rejects(access(join(home, ".zshrc")));
    });
  });

  it("preserves profile symlinks and permissions", async () => {
    await withTemporaryHome(async (home) => {
      const dotfiles = join(home, "dotfiles");
      const target = join(dotfiles, "zshrc");
      const profile = join(home, ".zshrc");
      await mkdir(dotfiles);
      await writeFile(target, "export EXISTING=1\n");
      await chmod(target, 0o640);
      await symlink(target, profile);

      const result = await runInstaller(home, {
        installPath: await findMiseExecutable(),
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal((await lstat(profile)).isSymbolicLink(), true);
      assert.match(await readFile(target, "utf8"), /activate zsh/);
      assert.equal((await stat(target)).mode & 0o777, 0o640);
    });
  });

  it("does not duplicate active shell setup or accept comments", async () => {
    await withTemporaryHome(async (home) => {
      const mise = await findMiseExecutable();
      await writeFile(
        join(home, ".zprofile"),
        `eval "$(${mise} activate zsh --shims)" # existing\n`,
      );
      await writeFile(join(home, ".zshrc"), `# eval "$(${mise} activate zsh)"\n`);

      const first = await runInstaller(home, { installPath: mise });
      assert.equal(first.exitCode, 0, first.stderr);
      const zprofile = await readFile(join(home, ".zprofile"), "utf8");
      const zshrc = await readFile(join(home, ".zshrc"), "utf8");
      assert.equal((zprofile.match(/activate zsh --shims/g) ?? []).length, 1);
      assert.equal((zshrc.match(/activate zsh\)/g) ?? []).length, 2);

      const second = await runInstaller(home, { installPath: mise });
      assert.equal(second.exitCode, 0, second.stderr);
      assert.equal(second.stdout, "");
      assert.equal(await readFile(join(home, ".zprofile"), "utf8"), zprofile);
      assert.equal(await readFile(join(home, ".zshrc"), "utf8"), zshrc);
    });
  });
});

describe("Homebrew selection", () => {
  it("installs with Homebrew before direct download", async () => {
    await withTemporaryHome(async (home) => {
      const bin = join(home, "fake-bin");
      const prefix = join(home, "brew-prefix");
      const installed = join(home, "brew-installed");
      await mkdir(bin, { recursive: true });
      const brew = join(bin, "brew");
      await Bun.write(
        brew,
        `#!/bin/sh
set -eu
case "$1" in
  --version) exit 0 ;;
  --prefix)
    [ -f "${installed}" ] || exit 1
    echo "${prefix}"
    ;;
  install)
    echo brew-stdout
    echo brew-stderr >&2
    mkdir -p "${prefix}/bin"
    printf '%s\\n' '#!/bin/sh' 'exit 0' > "${prefix}/bin/mise"
    chmod +x "${prefix}/bin/mise"
    touch "${installed}"
    ;;
  *) exit 1 ;;
esac
`,
      );
      await chmod(brew, 0o755);

      const result = await runInstaller(home, {
        path: `${bin}:/usr/bin:/bin`,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stderr, /Installing mise with Homebrew/);
      assert.match(result.stderr, /brew-stdout/);
      assert.match(result.stderr, /brew-stderr/);
      assert.doesNotMatch(result.stdout, /brew-(?:stdout|stderr)/);
      assert.match(result.stdout, new RegExp(`${prefix}/bin`));
      await access(installed);
    });
  });

  it("bypasses Homebrew when MISE_INSTALL_PATH is explicit", async () => {
    await withTemporaryHome(async (home) => {
      const bin = join(home, "fake-bin");
      const custom = join(home, "custom", "mise");
      const brewCalled = join(home, "brew-called");
      await mkdir(bin, { recursive: true });
      await mkdir(dirname(custom), { recursive: true });
      await Bun.write(custom, "#!/bin/sh\nexit 0\n");
      await chmod(custom, 0o755);
      const brew = join(bin, "brew");
      await Bun.write(
        brew,
        `#!/bin/sh
touch "${brewCalled}"
exit 0
`,
      );
      await chmod(brew, 0o755);

      const result = await runInstaller(home, {
        installPath: custom,
        path: `${bin}:/usr/bin:/bin`,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, new RegExp(dirname(custom)));
      await assert.rejects(access(brewCalled));
    });
  });
});

describe("Docker installation environments", () => {
  dockerIt(
    "installs on Debian, configures bash, evaluates output, and converges",
    { timeout: 180_000 },
    async () => {
      const script = [
        "set -eu",
        'first="$(bun /install.ts)"',
        'eval "$first"',
        "mise use --help >/dev/null",
        'test -x "$HOME/.local/bin/mise"',
        "grep -q 'activate bash --shims' \"$HOME/.profile\"",
        "grep -q 'activate bash)' \"$HOME/.bashrc\"",
        'second="$(bun /install.ts)"',
        'test -z "$second"',
      ].join("; ");
      const child = Bun.spawn(
        [
          "docker",
          "run",
          "--rm",
          "-e",
          "SHELL=/bin/bash",
          "-v",
          `${SCRIPT_PATH}:/install.ts:ro`,
          "oven/bun:1",
          "bash",
          "-lc",
          script,
        ],
        { stdout: "inherit", stderr: "inherit" },
      );
      assert.equal(await child.exited, 0);
    },
  );

  dockerIt(
    "installs the musl asset on Alpine with PATH-only setup",
    { timeout: 180_000 },
    async () => {
      const script = [
        "set -eu",
        'first="$(bun /install.ts)"',
        'eval "$first"',
        "mise use --help >/dev/null",
        'test -x "$HOME/.local/bin/mise"',
        "grep -q 'export PATH=' \"$HOME/.profile\"",
        'second="$(bun /install.ts)"',
        'test -z "$second"',
      ].join("; ");
      const child = Bun.spawn(
        [
          "docker",
          "run",
          "--rm",
          "-e",
          "MISE_INSTALL_MUSL=1",
          "-e",
          "SHELL=/bin/ash",
          "-v",
          `${SCRIPT_PATH}:/install.ts:ro`,
          "oven/bun:1-alpine",
          "sh",
          "-lc",
          script,
        ],
        { stdout: "inherit", stderr: "inherit" },
      );
      assert.equal(await child.exited, 0);
    },
  );

  dockerIt(
    "supports a custom path with spaces and profile opt-out",
    { timeout: 180_000 },
    async () => {
      const script = [
        "set -eu",
        'first="$(bun /install.ts)"',
        'eval "$first"',
        '"$MISE_INSTALL_PATH" use --help >/dev/null',
        "! grep -q '# >>> mise installer >>>' \"$HOME/.profile\"",
        'second="$(bun /install.ts)"',
        'test -z "$second"',
      ].join("; ");
      const child = Bun.spawn(
        [
          "docker",
          "run",
          "--rm",
          "-e",
          "MISE_INSTALL_NO_MODIFY_PATH=1",
          "-e",
          "MISE_INSTALL_PATH=/tmp/mise custom/bin/mise",
          "-e",
          "SHELL=/bin/sh",
          "-v",
          `${SCRIPT_PATH}:/install.ts:ro`,
          "oven/bun:1",
          "sh",
          "-lc",
          script,
        ],
        { stdout: "inherit", stderr: "inherit" },
      );
      assert.equal(await child.exited, 0);
    },
  );
});
