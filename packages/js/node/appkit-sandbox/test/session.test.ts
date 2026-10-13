import { describe, expect, it, vi } from "vitest";
import { privilegedSandboxExecution } from "../src/_sandbox-user.ts";
import type { SshTransport } from "../src/_ssh.ts";
import {
  resolvePublicGatewayAddresses,
  SshCommand,
  SshSession,
  sshCommandScript,
} from "../src/session.ts";

describe("SshSession", () => {
  it("returns a live command before connection setup completes", async () => {
    let finishConnection!: () => void;
    const connection = new Promise<void>((resolve) => {
      finishConnection = resolve;
    });
    const session = new SshSession({
      host: "gateway.example",
      port: 2_222,
      username: "sandbox",
      privateKey: "key",
      privateKeyPath: "/tmp/key",
      knownHostsPath: "/tmp/known-hosts",
      connectTimeoutMs: 1_000,
      sshTransport: "ssh2",
      ssh2Patch: "false",
    });
    Object.defineProperty(session, "connect", { value: () => connection });
    (session as unknown as { transport: SshTransport }).transport = {
      kind: "ssh2",
      run: async (_script, execution) => {
        execution.stdout("connected");
        return 0;
      },
      connect: async () => {
        throw new Error("not used");
      },
      close: async () => undefined,
    };

    const command = session.execute("echo", ["connected"], { timeoutMs: 1_000 });

    expect(command).toBeInstanceOf(SshCommand);
    expect(command.exitCode).toBeUndefined();
    finishConnection();
    await expect(command.result).resolves.toMatchObject({ exitCode: 0, stdout: "connected" });
  });

  it("cancels active commands before closing the transport", async () => {
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const close = vi.fn(async () => undefined);
    const cancel = vi.fn();
    const session = new SshSession({
      host: "gateway.example",
      port: 2_222,
      username: "sandbox",
      privateKey: "key",
      privateKeyPath: "/tmp/key",
      knownHostsPath: "/tmp/known-hosts",
      connectTimeoutMs: 1_000,
      sshTransport: "ssh2",
      ssh2Patch: "false",
    });
    const transport: SshTransport = {
      kind: "ssh2",
      run: async (_script, execution) => {
        execution.setCancel(cancel);
        started();
        return new Promise<number>(() => undefined);
      },
      connect: async () => {
        throw new Error("not used");
      },
      close,
    };
    Object.defineProperty(session, "connect", { value: async () => undefined });
    (session as unknown as { transport: SshTransport }).transport = transport;
    const command = session.execute("sleep", ["60"], { timeoutMs: 1_000 });
    await active;

    await session.close();

    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(await command).toBe(130);
  });

  it("destroys pending clients and waits for connection settlement when closing", async () => {
    let finishConnection!: () => void;
    const connecting = new Promise<void>((resolve) => {
      finishConnection = resolve;
    });
    const destroy = vi.fn();
    const session = new SshSession({
      host: "gateway.example",
      port: 2_222,
      username: "sandbox",
      privateKey: "key",
      privateKeyPath: "/tmp/key",
      knownHostsPath: "/tmp/known-hosts",
      connectTimeoutMs: 1_000,
      sshTransport: "ssh2",
      ssh2Patch: "false",
    });
    (
      session as unknown as {
        pendingClients: Set<{ destroy(): void }>;
        connecting: Promise<void>;
      }
    ).pendingClients.add({ destroy });
    (session as unknown as { connecting: Promise<void> }).connecting = connecting;

    let closed = false;
    const firstClose = session.close().then(() => {
      closed = true;
    });
    const secondClose = session.close();
    await Promise.resolve();

    expect(destroy).toHaveBeenCalledOnce();
    expect(closed).toBe(false);
    finishConnection();
    await Promise.all([firstClose, secondClose]);
    expect(closed).toBe(true);
  });
});

describe("resolvePublicGatewayAddresses", () => {
  it("resolves unique public IPv4 gateway addresses", async () => {
    const requests: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          Answer: [
            { type: 5, data: "regional-ingress.example.com." },
            { type: 1, data: "18.97.131.216" },
            { type: 1, data: "18.97.131.216" },
            { type: 1, data: "18.97.131.214" },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };

    await expect(
      resolvePublicGatewayAddresses(
        "us-east-2.service-direct.cloud.databricks.com",
        fetcher as typeof fetch,
      ),
    ).resolves.toEqual(["18.97.131.216", "18.97.131.214"]);
    expect(requests).toHaveLength(1);
  });

  it("does not resolve unrelated hosts through public DNS", async () => {
    let called = false;
    const fetcher = async () => {
      called = true;
      return new Response();
    };

    await expect(
      resolvePublicGatewayAddresses("example.com", fetcher as typeof fetch),
    ).resolves.toEqual([]);
    expect(called).toBe(false);
  });

  it("clears inherited machine auth before applying non-auth command environment", () => {
    const script = sshCommandScript("sh", ["-lc", "env"], "/home/sandbox-user/project", {
      PROJECT_MODE: "demo",
    });

    expect(script).toContain("DATABRICKS_*");
    expect(script).not.toContain("*_TOKEN");
    expect(script).toContain('unset "$__dbx_tools_name"');
    expect(script).toContain("export DATABRICKS_CONFIG_FILE=/dev/null");
    expect(script).toContain("'-u' 'sandbox-user'");
    expect(script).toContain("HOME='/home/sandbox-user'");
    expect(script).toContain("PROJECT_MODE='demo'");
    expect(script).toContain("/home/sandbox-user/project");
    expect(script.match(/unset "\$__dbx_tools_name"/g)).toHaveLength(2);
    expect(script.indexOf('unset "$__dbx_tools_name"')).toBeLessThan(
      script.indexOf("PROJECT_MODE='demo'"),
    );
  });

  it("rejects attempts to restore Databricks credentials", () => {
    expect(() =>
      sshCommandScript("sh", ["-lc", "env"], undefined, {
        DATABRICKS_TOKEN: "service-principal-token",
      }),
    ).toThrow(/cannot replace the Sandbox identity/);
  });

  it("requires the private capability for privileged commands", () => {
    const session = new SshSession({
      host: "gateway.example",
      port: 2_222,
      username: "sandbox",
      privateKey: "key",
      privateKeyPath: "/tmp/key",
      knownHostsPath: "/tmp/known-hosts",
      connectTimeoutMs: 1_000,
      sshTransport: "ssh2",
      ssh2Patch: "false",
    });
    expect(() => session.executePrivileged("id", [], { timeoutMs: 1_000 }, {} as never)).toThrow(
      /package-owned capability/,
    );
    expect(sshCommandScript("id", [], undefined, undefined, true)).toContain(
      "'sudo' '-n' '-H' '--'",
    );
    expect(privilegedSandboxExecution).toBeDefined();
  });
});
