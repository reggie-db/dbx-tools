import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import type { Client as Ssh2Client, ClientChannel } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exec } from "@dbx-tools/core";
import {
  createSshTransport,
  PooledSshTransport,
  SshCommand,
  SSH_POOL_MAX,
  type SshCommandExecution,
  type SshResourceLifecycle,
  type SshTransport,
  type SshTransportFactories,
  type SshTransportOptions,
} from "../src/_ssh.ts";
import {
  nativeOpenSshArgs,
  OPENSSH_PARENT_WATCH_SOURCE,
  OpenSshTransport,
  type OpenSshResource,
  supportsNativeOpenSsh,
} from "../src/_ssh_openssh.ts";

const originalNodeEnv = process.env.NODE_ENV;
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  restoreEnvironment("NODE_ENV", originalNodeEnv);
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("native OpenSSH selection", () => {
  it("detects OpenSSH executables with dynamic forwarding", async () => {
    const command = await fakeSshCommand(true);
    expect(await supportsNativeOpenSsh(command)).toBe(true);
  });

  it("memoizes OpenSSH capability detection per executable", async () => {
    const directory = await temporaryDirectory("dbx-tools-ssh-calls-");
    const callsPath = join(directory, "calls.log");
    const command = await fakeSshCommand(true, callsPath);

    expect(await supportsNativeOpenSsh(command)).toBe(true);
    expect(await supportsNativeOpenSsh(command)).toBe(true);

    expect((await readFile(callsPath, "utf8")).trim().split("\n")).toEqual(["-V", "-G"]);
  });

  it("kills a detached native OpenSSH child when parent termination begins", async () => {
    const directory = await temporaryDirectory("dbx-tools-ssh-exit-");
    const pidPath = join(directory, "pid");
    const command = join(directory, "ssh");
    await writeFile(
      command,
      `#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => undefined, 1_000);\n`,
    );
    await chmod(command, 0o700);
    const ignoreSignal = () => undefined;
    process.on("SIGTERM", ignoreSignal);
    const probe = supportsNativeOpenSsh(command);
    let childPid: number | undefined;
    try {
      await waitUntil(async () => {
        const pid = await readFile(pidPath, "utf8").catch(() => undefined);
        if (!pid) return false;
        childPid = Number(pid);
        return true;
      });
      process.emit("SIGTERM");
      await expect(probe).resolves.toBe(false);
      await waitUntil(() => !processExists(childPid));
    } finally {
      process.off("SIGTERM", ignoreSignal);
      if (processExists(childPid)) process.kill(childPid!, "SIGKILL");
    }
  });

  it("kills a native OpenSSH child when the parent pipe closes", async () => {
    const directory = await temporaryDirectory("dbx-tools-ssh-watch-");
    const pidPath = join(directory, "pid");
    const childCommand = join(directory, "child");
    await writeFile(
      childCommand,
      `#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => undefined, 1_000);\n`,
    );
    await chmod(childCommand, 0o700);
    const watcher = exec.spawn(
      process.execPath,
      ["-e", OPENSSH_PARENT_WATCH_SOURCE, childCommand],
      {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "capture",
        forwardTerminationSignals: false,
      },
    );
    let childPid: number | undefined;
    try {
      await waitUntil(async () => {
        const pid = await readFile(pidPath, "utf8").catch(() => undefined);
        if (!pid) return false;
        childPid = Number(pid);
        return true;
      });
      watcher.stdin?.end();

      expect(await watcher).toMatchObject({ exitCode: 1 });
      await waitUntil(() => !processExists(childPid));
    } finally {
      await watcher.shutdown({ terminateTimeout: 0, killTimeout: 1_000 });
      if (processExists(childPid)) process.kill(childPid!, "SIGKILL");
    }
  });

  it("rejects non-OpenSSH executables", async () => {
    const command = await fakeSshCommand(false);
    expect(await supportsNativeOpenSsh(command)).toBe(false);
  });

  it("builds strict host verification and no-agent arguments", () => {
    const args = nativeOpenSshArgs(transportOptions(fakeClient()));
    expect(args).toContain("ForwardAgent=no");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("UserKnownHostsFile=/tmp/known_hosts");
    expect(args).toContain("HostKeyAlias=[gateway.example]:2222");
    expect(args).toContain("ServerAliveInterval=15");
    expect(args).toContain("ServerAliveCountMax=3");
  });

  it("selects OpenSSH in auto mode when supported", async () => {
    const lifecycle = fakeOpenSshLifecycle();
    const transport = await createSshTransport(
      {
        ...transportOptions(fakeClient()),
        sshCommand: await fakeSshCommand(true),
      },
      fakeOpenSshFactory(lifecycle),
    );
    expect(transport.kind).toBe("openssh");
    await transport.close();
  });

  it("defaults omitted transport policy to auto", async () => {
    const { transport: _transport, ssh2Patch: _patch, ...options } = transportOptions(fakeClient());
    const transport = await createSshTransport(
      {
        ...options,
        sshCommand: await fakeSshCommand(true),
      },
      fakeOpenSshFactory(fakeOpenSshLifecycle()),
    );
    expect(transport.kind).toBe("openssh");
    await transport.close();
  });

  it("selects unpatched ssh2 in production auto mode when OpenSSH is unavailable", async () => {
    process.env.NODE_ENV = "production";
    const command = await fakeSshCommand(false);
    const client = fakeClient();
    const originalExec = (client as unknown as { _protocol: { exec: Function } })._protocol.exec;
    const transport = await createSshTransport({
      ...transportOptions(client),
      sshCommand: command,
    });
    expect(transport.kind).toBe("ssh2");
    expect((client as unknown as { _protocol: { exec: Function } })._protocol.exec).toBe(
      originalExec,
    );
    await transport.close();
  });

  it("requires OpenSSH when explicitly selected", async () => {
    const command = await fakeSshCommand(false);
    await expect(
      createSshTransport({
        ...transportOptions(fakeClient()),
        transport: "openssh",
        sshCommand: command,
      }),
    ).rejects.toThrow(/Native OpenSSH with SOCKS5 forwarding is unavailable/);
  });

  it("does not probe OpenSSH when ssh2 is selected", async () => {
    const transport = await createSshTransport({
      ...transportOptions(fakeClient()),
      transport: "ssh2",
      sshCommand: "/does/not/exist",
    });
    expect(transport.kind).toBe("ssh2");
    await transport.close();
  });

  it("streams and captures native OpenSSH command output", async () => {
    const lifecycle = fakeOpenSshLifecycle({
      run: async (_script, execution) => {
        execution.stdout("native stdout");
        execution.stderr("native stderr");
        return 3;
      },
    });
    const transport = new OpenSshTransport(
      transportOptions(fakeClient()),
      await fakeExecutingSshCommand(),
      {},
      lifecycle,
    );
    await transport.start();
    const command = runTransport(transport, "demo", [], "'demo'", { timeoutMs: 1_000 });
    const stdout = command.stdout[Symbol.asyncIterator]();

    await expect(stdout.next()).resolves.toMatchObject({ value: "native stdout", done: false });
    await expect(command.result).resolves.toMatchObject({
      exitCode: 3,
      stdout: "native stdout",
      stderr: "native stderr",
    });
    await transport.close();
  });
});

describe("SshCommand", () => {
  it("returns immediately, streams output, and awaits to the exit code", async () => {
    let finish!: () => void;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const command = new SshCommand(
      "sh",
      ["-lc", "test"],
      { timeoutMs: 1_000 },
      async (execution) => {
        execution.stdout("before completion");
        await release;
        execution.stderr("failed");
        return 7;
      },
    );
    const stdout = command.stdout[Symbol.asyncIterator]();

    expect(command.exitCode).toBeUndefined();
    await expect(stdout.next()).resolves.toMatchObject({ value: "before completion", done: false });
    finish();
    expect(await command).toBe(7);
    await expect(command.result).resolves.toMatchObject({
      success: false,
      exitCode: 7,
      stdout: "before completion",
      stderr: "failed",
    });
  });

  it("decodes UTF-8 characters split across transport chunks", async () => {
    const bytes = Buffer.from("résumé");
    const command = new SshCommand("printf", [], { timeoutMs: 1_000 }, async (execution) => {
      execution.stdout(bytes.subarray(0, 2));
      execution.stdout(bytes.subarray(2, 4));
      execution.stdout(bytes.subarray(4));
      return 0;
    });

    await expect(command.result).resolves.toMatchObject({ stdout: "résumé" });
  });

  it("cancels an active command with exit code 130", async () => {
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancelBackend = vi.fn();
    const command = new SshCommand("sleep", ["60"], { timeoutMs: 1_000 }, async (execution) => {
      execution.setCancel(cancelBackend);
      started();
      return new Promise<number>(() => undefined);
    });
    await active;

    await command.cancel();

    expect(cancelBackend).toHaveBeenCalledOnce();
    expect(await command).toBe(130);
  });

  it("times out an active command with exit code 124", async () => {
    const cancelBackend = vi.fn();
    const command = new SshCommand("sleep", ["60"], { timeoutMs: 5 }, async (execution) => {
      execution.setCancel(cancelBackend);
      return new Promise<number>(() => undefined);
    });

    await expect(command.result).resolves.toMatchObject({ exitCode: 124, timedOut: true });
    expect(cancelBackend).toHaveBeenCalledOnce();
  });

  it("does not start when the caller signal is already aborted", async () => {
    const start = vi.fn(async () => 0);
    const command = new SshCommand(
      "echo",
      [],
      { timeoutMs: 1_000, signal: AbortSignal.abort() },
      start,
    );

    expect(await command).toBe(130);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("pooled SSH transport", () => {
  it("caps each operation pool at ten authenticated resources", () => {
    expect(SSH_POOL_MAX).toBe(10);
  });

  it("warms one tested command resource and destroys each resource after one operation", async () => {
    const created: TestPoolResource[] = [];
    const destroyed: number[] = [];
    let tests = 0;
    const lifecycle: SshResourceLifecycle<TestPoolResource> = {
      create: async () => {
        const resource = { id: created.length + 1, valid: true };
        created.push(resource);
        return resource;
      },
      destroy: async (resource) => {
        resource.valid = false;
        destroyed.push(resource.id);
      },
      test: async (resource) => {
        tests++;
        return resource.valid;
      },
    };
    const transport = new TestPooledTransport(lifecycle);
    await transport.start();

    expect(created).toHaveLength(1);
    expect(tests).toBeGreaterThan(0);
    await expect(
      runTransport(transport, "echo", ["ready"], "'echo' 'ready'", { timeoutMs: 1_000 }).result,
    ).resolves.toMatchObject({ exitCode: 0, stdout: "1:'echo' 'ready'" });
    await waitUntil(() => created.length >= 2);
    expect(destroyed).toContain(1);

    const stream = await transport.connect("127.0.0.1", 8_080);
    const forwardingResource = created.at(-1)!;
    expect(destroyed).not.toContain(forwardingResource.id);
    stream.destroy();
    await waitUntil(() => destroyed.includes(forwardingResource.id));

    await transport.close();
    expect(destroyed).toContain(2);
  });

  it("reports the connection factory error instead of an acquire timeout", async () => {
    const transport = new TestPooledTransport(
      {
        create: async () => {
          throw new Error("connection failed");
        },
        destroy: async () => undefined,
        test: async () => true,
      },
      { acquireTimeoutMillis: 20 },
    );

    await expect(transport.start()).rejects.toThrow("connection failed");
    await transport.close();
  });

  it("waits for an in-progress startup before closing its created resource", async () => {
    let finishCreate!: (resource: TestPoolResource) => void;
    const created = new Promise<TestPoolResource>((resolve) => {
      finishCreate = resolve;
    });
    const destroyed: number[] = [];
    const transport = new TestPooledTransport({
      create: () => created,
      destroy: async (resource) => {
        destroyed.push(resource.id);
      },
      test: async () => true,
    });

    const start = transport.start();
    const close = transport.close();
    finishCreate({ id: 1, valid: true });

    await expect(start).rejects.toThrow(/transport is closed/);
    await close;
    expect(destroyed).toEqual([1]);
  });

  it("replaces a dead warm resource before assigning an operation", async () => {
    const created: TestPoolResource[] = [];
    const destroyed: number[] = [];
    const transport = new TestPooledTransport({
      create: async () => {
        const resource = { id: created.length + 1, valid: true };
        created.push(resource);
        return resource;
      },
      destroy: async (resource) => {
        destroyed.push(resource.id);
      },
      test: async (resource) => resource.valid,
    });
    await transport.start();
    created[0]!.valid = false;

    await expect(
      runTransport(transport, "echo", [], "'echo'", { timeoutMs: 1_000 }).result,
    ).resolves.toMatchObject({ stdout: "2:'echo'" });
    expect(destroyed).toContain(1);
    await transport.close();
  });

  it("retries a failed forwarding open with a fresh resource", async () => {
    const created: TestPoolResource[] = [];
    const destroyed: number[] = [];
    let attempts = 0;
    const transport = new TestPooledTransport(
      {
        create: async () => {
          const resource = { id: created.length + 1, valid: true };
          created.push(resource);
          return resource;
        },
        destroy: async (resource) => {
          resource.valid = false;
          destroyed.push(resource.id);
        },
        test: async (resource) => resource.valid,
      },
      {},
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("forwarding connection closed");
        return new Duplex({
          allowHalfOpen: true,
          read: () => undefined,
          write: (_chunk, _encoding, callback) => callback(),
        });
      },
    );
    await transport.start();

    const stream = await transport.connect("127.0.0.1", 8_080);

    expect(attempts).toBe(2);
    expect(destroyed).toContain(2);
    stream.resume();
    stream.push(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(destroyed).not.toContain(3);
    stream.destroy();
    await waitUntil(() => destroyed.includes(3));
    await transport.close();
  });
});

describe("ssh2 exec no-reply fallback", () => {
  it("auto-patches in development and remains idempotent", async () => {
    process.env.NODE_ENV = "development";
    const request = vi.fn();
    const callback = vi.fn();
    const channel = { outgoing: { id: 9 }, _callbacks: [callback] };
    const client = fakeClient(request, channel);

    const first = await createSshTransport({
      ...transportOptions(client),
      transport: "ssh2",
    });
    const protocol = (client as unknown as { _protocol: { exec: Function } })._protocol;
    const patchedExec = protocol.exec;
    const second = await createSshTransport({
      ...transportOptions(client),
      transport: "ssh2",
    });
    expect(protocol.exec).toBe(patchedExec);
    protocol.exec(9, "printf test", true);
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith(9, "printf test", false);
    expect(callback).toHaveBeenCalledWith(false);
    await Promise.all([first.close(), second.close()]);
  });

  it("forces the patch in production when configured true", async () => {
    process.env.NODE_ENV = "production";
    const client = fakeClient();
    const protocol = (client as unknown as { _protocol: { exec: Function } })._protocol;
    const originalExec = protocol.exec;
    const transport = await createSshTransport({
      ...transportOptions(client),
      transport: "ssh2",
      ssh2Patch: "true",
    });
    expect(transport.kind).toBe("ssh2");
    expect(protocol.exec).not.toBe(originalExec);
    await transport.close();
  });

  it("does not patch when configured false", async () => {
    process.env.NODE_ENV = "development";
    const client = fakeClient();
    const protocol = (client as unknown as { _protocol: { exec: Function } })._protocol;
    const originalExec = protocol.exec;
    const transport = await createSshTransport({
      ...transportOptions(client),
      transport: "ssh2",
      ssh2Patch: "false",
    });
    expect(protocol.exec).toBe(originalExec);
    await transport.close();
  });

  it("continues unpatched for auto when ssh2 internals are unavailable", async () => {
    process.env.NODE_ENV = "development";
    const client = fakeClientWithoutInternals();
    const transport = await createSshTransport({
      ...transportOptions(client),
      transport: "ssh2",
    });
    expect(transport.kind).toBe("ssh2");
    await transport.close();
  });

  it("rejects required patching when ssh2 internals are unavailable", async () => {
    const client = fakeClientWithoutInternals();
    await expect(
      createSshTransport({
        ...transportOptions(client),
        transport: "ssh2",
        ssh2Patch: "true",
      }),
    ).rejects.toThrow(/do not support the required exec no-reply patch/);
  });

  it("captures command output and closes only a timed-out channel", async () => {
    const outputChannel = fakeChannel();
    const outputClient = fakeClient();
    outputClient.exec = vi.fn((script, callback) => {
      expect(script).toContain("exit 7");
      callback(undefined, outputChannel);
      queueMicrotask(() => {
        outputChannel.emit("data", Buffer.from("stdout"));
        outputChannel.stderr.emit("data", Buffer.from("stderr"));
        outputChannel.emit("exit", 7);
        outputChannel.emit("close");
      });
      return outputClient;
    });
    const timeoutChannel = fakeChannel();
    const timeoutClient = fakeClient();
    timeoutClient.exec = vi.fn((_script, callback) => {
      callback(undefined, timeoutChannel);
      return timeoutClient;
    });
    const replacementClient = fakeClient();
    const pendingClients = [timeoutClient, replacementClient];
    const transport = await createSshTransport({
      ...transportOptions(outputClient),
      createSsh2CommandClient: async () => pendingClients.shift() ?? fakeClient(),
      transport: "ssh2",
      ssh2Patch: "true",
    });

    const command = runTransport(transport, "sh", ["-lc", "exit 7"], "'sh' '-lc' 'exit 7'", {
      timeoutMs: 1_000,
    });
    expect(command).toBeInstanceOf(SshCommand);
    expect(command.exitCode).toBeUndefined();
    await expect(command.result).resolves.toMatchObject({
      success: false,
      exitCode: 7,
      stdout: "stdout",
      stderr: "stderr",
    });

    await expect(
      runTransport(transport, "sleep", ["60"], "'sleep' '60'", { timeoutMs: 5 }).result,
    ).resolves.toMatchObject({ exitCode: 124, timedOut: true });
    expect(timeoutChannel.signal).toHaveBeenCalledWith("KILL");
    expect(timeoutChannel.close).toHaveBeenCalledOnce();
    await transport.close();
  });

  it("uses and closes one fresh ssh2 client per command", async () => {
    const clients: Ssh2Client[] = [];
    const createClient = () => {
      const client = fakeClient();
      client.exec = vi.fn((_script, callback) => {
        const channel = fakeChannel();
        callback(undefined, channel);
        queueMicrotask(() => {
          channel.emit("exit", 0);
          channel.emit("close");
        });
        return client;
      });
      clients.push(client);
      return client;
    };
    const initialClient = createClient();
    const transport = await createSshTransport({
      ...transportOptions(initialClient),
      createSsh2CommandClient: async () => createClient(),
      transport: "ssh2",
      ssh2Patch: "true",
    });

    await Promise.all([
      runTransport(transport, "echo", ["one"], "'echo' 'one'", { timeoutMs: 1_000 }),
      runTransport(transport, "echo", ["two"], "'echo' 'two'", { timeoutMs: 1_000 }),
    ]);

    const usedClients = clients.filter((client) => mockCallCount(client.exec) > 0);
    expect(usedClients).toHaveLength(2);
    for (const client of usedClients) {
      expect(client.exec).toHaveBeenCalledOnce();
      expect(client.end).toHaveBeenCalledOnce();
    }
    await waitUntil(() => clients.length >= 3);
    await transport.close();
    for (const client of clients) expect(client.end).toHaveBeenCalled();
  });

  it("uses direct ssh2 forwarding for routed TCP connections", async () => {
    const commandClient = fakeClient();
    const forwardingClient = fakeClient();
    const channel = fakeChannel();
    forwardingClient.forwardOut = vi.fn(
      (_sourceHost, _sourcePort, _remoteHost, _remotePort, callback) => {
        callback(undefined, channel);
        return forwardingClient;
      },
    );
    const transport = await createSshTransport({
      ...transportOptions(commandClient),
      createSsh2CommandClient: async () => forwardingClient,
      transport: "ssh2",
      ssh2Patch: "true",
    });

    await expect(transport.connect("127.0.0.1", 8_080)).resolves.toBe(channel);
    expect(forwardingClient.forwardOut).toHaveBeenCalledWith(
      "127.0.0.1",
      0,
      "127.0.0.1",
      8_080,
      expect.any(Function),
    );
    channel.emit("close");
    await waitUntil(() => mockCallCount(forwardingClient.end) > 0);
    await transport.close();
  });

  it("times out an unacknowledged ssh2 forwarding request", async () => {
    const commandClient = fakeClient();
    const forwardingClient = fakeClient();
    forwardingClient.forwardOut = vi.fn(() => forwardingClient);
    const transport = await createSshTransport({
      ...transportOptions(commandClient),
      connectTimeoutMs: 5,
      createSsh2CommandClient: async () => forwardingClient,
      transport: "ssh2",
      ssh2Patch: "false",
    });

    await expect(transport.connect("127.0.0.1", 8_080)).rejects.toThrow(/forwarding did not open/);
    expect(forwardingClient.end).toHaveBeenCalled();
    await transport.close();
  });

  it("rejects an unacknowledged forwarding request immediately when closing", async () => {
    const commandClient = fakeClient();
    const forwardingClient = fakeClient();
    forwardingClient.forwardOut = vi.fn(() => forwardingClient);
    const transport = await createSshTransport({
      ...transportOptions(commandClient),
      connectTimeoutMs: 1_000,
      createSsh2CommandClient: async () => forwardingClient,
      transport: "ssh2",
      ssh2Patch: "false",
    });
    const forwarding = transport.connect("127.0.0.1", 8_080);
    await waitUntil(() => mockCallCount(forwardingClient.forwardOut) > 0);

    const close = transport.close();

    await expect(forwarding).rejects.toThrow(/connection closed while opening forwarding/);
    await close;
  });

  it("closes in-flight command clients with the transport", async () => {
    const commandClient = fakeClient();
    commandClient.exec = vi.fn((_script, callback) => {
      callback(undefined, fakeChannel());
      return commandClient;
    });
    const transport = await createSshTransport({
      ...transportOptions(commandClient),
      transport: "ssh2",
      ssh2Patch: "true",
    });

    const execution = runTransport(transport, "sleep", ["60"], "'sleep' '60'", {
      timeoutMs: 1_000,
    });
    await waitUntil(() => mockCallCount(commandClient.exec) > 0);
    const closed = transport.close();
    await waitUntil(() => mockCallCount(commandClient.end) > 0);
    await closed;
    await expect(execution.result).rejects.toThrow(/connection closed/);
  });

  it("destroys ssh2 sockets when graceful close is not acknowledged", async () => {
    const client = fakeClient();
    client.end = vi.fn(() => client);
    const transport = await createSshTransport({
      ...transportOptions(client),
      connectTimeoutMs: 5,
      transport: "ssh2",
      ssh2Patch: "false",
    });

    await transport.close();

    expect(client.end).toHaveBeenCalledOnce();
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});

function runTransport(
  transport: SshTransport,
  command: string,
  args: string[],
  script: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): SshCommand {
  return new SshCommand(command, args, options, (execution) => transport.run(script, execution));
}

interface TestPoolResource {
  id: number;
  valid: boolean;
}

class TestPooledTransport extends PooledSshTransport<TestPoolResource> {
  readonly kind = "ssh2" as const;

  constructor(
    lifecycle: SshResourceLifecycle<TestPoolResource>,
    options: { acquireTimeoutMillis?: number } = {},
    private readonly connectResource: (
      resource: TestPoolResource,
    ) => Promise<Duplex> = async () => new PassThrough(),
  ) {
    super(lifecycle, {
      acquireTimeoutMillis: options.acquireTimeoutMillis ?? 1_000,
      idleTimeoutMillis: 1_000,
      evictionRunIntervalMillis: 0,
    });
  }

  protected async runWithResource(
    resource: TestPoolResource,
    script: string,
    execution: SshCommandExecution,
  ): Promise<number> {
    execution.stdout(`${resource.id}:${script}`);
    return 0;
  }

  protected connectWithResource(resource: TestPoolResource): Promise<Duplex> {
    return this.connectResource(resource);
  }
}

interface FakeOpenSshLifecycle extends SshResourceLifecycle<OpenSshResource> {
  readonly created: OpenSshResource[];
  readonly destroyed: OpenSshResource[];
}

function fakeOpenSshLifecycle(overrides: Partial<OpenSshResource> = {}): FakeOpenSshLifecycle {
  const created: OpenSshResource[] = [];
  const destroyed: OpenSshResource[] = [];
  return {
    created,
    destroyed,
    create: async () => {
      const resource: OpenSshResource = {
        run: async () => 0,
        connect: async () => new PassThrough(),
        test: async () => true,
        close: async () => undefined,
        ...overrides,
      };
      created.push(resource);
      return resource;
    },
    destroy: async (resource) => {
      destroyed.push(resource);
      await resource.close();
    },
    test: (resource) => resource.test(),
  };
}

function fakeOpenSshFactory(
  lifecycle: SshResourceLifecycle<OpenSshResource>,
): Partial<SshTransportFactories> {
  return {
    createOpenSsh: async (options, command) => {
      const transport = new OpenSshTransport(options, command, {}, lifecycle);
      await transport.start();
      return transport;
    },
  };
}

function transportOptions(client: Ssh2Client): SshTransportOptions {
  return {
    host: "gateway.example",
    connectHost: "18.97.131.216",
    port: 2_222,
    username: "sandbox",
    privateKeyPath: "/tmp/id_ed25519",
    knownHostsPath: "/tmp/known_hosts",
    connectTimeoutMs: 1_000,
    ssh2Client: client,
    createSsh2CommandClient: async () => fakeClient(),
    transport: "auto",
    ssh2Patch: "auto",
  };
}

function fakeClient(
  request = vi.fn(),
  channel: {
    outgoing: { id: number };
    _callbacks: Array<(error: boolean | Error) => void>;
  } = {
    outgoing: { id: 9 },
    _callbacks: [vi.fn()],
  },
): Ssh2Client {
  const client = new EventEmitter() as EventEmitter & Ssh2Client;
  return Object.assign(client, {
    _protocol: { exec: request },
    _chanMgr: { _channels: { 4: channel } },
    end: vi.fn(() => {
      queueMicrotask(() => client.emit("close"));
      return client;
    }),
    destroy: vi.fn(() => {
      queueMicrotask(() => client.emit("close"));
      return client;
    }),
    exec: vi.fn(),
    forwardOut: vi.fn(),
  }) as unknown as Ssh2Client;
}

function fakeClientWithoutInternals(): Ssh2Client {
  const client = fakeClient() as unknown as {
    _protocol?: unknown;
    _chanMgr?: unknown;
  };
  delete client._protocol;
  delete client._chanMgr;
  return client as unknown as Ssh2Client;
}

function fakeChannel(): ClientChannel & {
  close: ReturnType<typeof vi.fn>;
  signal: ReturnType<typeof vi.fn>;
} {
  const channel = new EventEmitter() as ClientChannel & {
    close: ReturnType<typeof vi.fn>;
    signal: ReturnType<typeof vi.fn>;
  };
  channel.stderr = new EventEmitter() as ClientChannel["stderr"];
  channel.close = vi.fn();
  channel.signal = vi.fn();
  return channel;
}

async function fakeSshCommand(openSsh: boolean, callsPath?: string): Promise<string> {
  const directory = await temporaryDirectory("dbx-tools-ssh-test-");
  const command = join(directory, "ssh");
  await writeFile(
    command,
    `#!/bin/sh\n${callsPath ? `printf '%s\\n' "$1" >> ${JSON.stringify(callsPath)}\n` : ""}if [ "$1" = "-V" ]; then echo '${openSsh ? "OpenSSH_10.3" : "other-ssh 1.0"}' >&2; exit 0; fi\nif [ "$1" = "-G" ]; then exit 0; fi\nexit 1\n`,
  );
  await chmod(command, 0o700);
  return command;
}

async function fakeExecutingSshCommand(): Promise<string> {
  const directory = await temporaryDirectory("dbx-tools-ssh-exec-test-");
  const command = join(directory, "ssh");
  await writeFile(
    command,
    '#!/bin/sh\nif [ "$1" = "-V" ]; then echo \'OpenSSH_10.3\' >&2; exit 0; fi\nif [ "$1" = "-G" ]; then exit 0; fi\nprintf \'native stdout\'\nprintf \'native stderr\' >&2\nexit 3\n',
  );
  await chmod(command, 0o700);
  return command;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function processExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function mockCallCount(value: unknown): number {
  return (value as { mock: { calls: unknown[] } }).mock.calls.length;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
