import { describe, expect, it } from "vitest";
import { resolvePublicGatewayAddresses, sshCommandScript } from "../src/session.ts";

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
    const script = sshCommandScript("sh", ["-lc", "env"], "/home/sandbox/project", {
      PROJECT_MODE: "demo",
    });

    expect(script).toContain("DATABRICKS_*");
    expect(script).not.toContain("*_TOKEN");
    expect(script).toContain('unset "$__dbx_tools_name"');
    expect(script).toContain("export DATABRICKS_CONFIG_FILE=/dev/null");
    expect(script).toContain(
      "cd -- '/home/sandbox/project' && PROJECT_MODE='demo' 'sh' '-lc' 'env'",
    );
    expect(script.indexOf('unset "$__dbx_tools_name"')).toBeLessThan(
      script.indexOf("PROJECT_MODE='demo'"),
    );
  });

  it("rejects attempts to restore Databricks credentials", () => {
    expect(() =>
      sshCommandScript("sh", ["-lc", "env"], undefined, {
        DATABRICKS_TOKEN: "service-principal-token",
      }),
    ).toThrow(/dedicated app-mediated OBO capability/);
  });
});
