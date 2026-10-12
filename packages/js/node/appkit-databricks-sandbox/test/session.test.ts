import { describe, expect, it } from "vitest";
import { resolvePublicGatewayAddresses } from "../src/session.ts";

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
});
