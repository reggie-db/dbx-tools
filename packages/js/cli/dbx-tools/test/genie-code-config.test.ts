import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "smol-toml";

import {
  GENIE_CODE_GATEWAY_PROVIDER,
  genieCodeConfig,
  genieCodeHome,
  writeGenieCodeConfig,
} from "../src/genie-code/config.ts";

describe("Genie Code configuration", () => {
  it("derives one readable home from the exact profile-model pairing", () => {
    const profile = "FEVM-REGGIE-PIERCE-AWS";
    const model = "GPT 5.6 Sol";
    const digest = createHash("sha256")
      .update(JSON.stringify([profile, model]))
      .digest("hex")
      .slice(0, 12);

    assert.deepEqual(genieCodeHome(profile, model, "/home/user"), {
      name: `fevm-reggie-pierce-aws-gpt-5-6-sol-${digest}`,
      home: `/home/user/.dbx-tools/genie/profiles/fevm-reggie-pierce-aws-gpt-5-6-sol-${digest}`,
      configPath:
        `/home/user/.dbx-tools/genie/profiles/` +
        `fevm-reggie-pierce-aws-gpt-5-6-sol-${digest}/config.toml`,
    });
    assert.notEqual(
      genieCodeHome(profile, model, "/home/user").name,
      genieCodeHome(profile.toLowerCase(), model, "/home/user").name,
    );
  });

  it("renders a guarded Responses provider and trusted project", () => {
    assert.deepEqual(
      genieCodeConfig({
        bearerToken: "secret",
        gatewayBaseUrl: "http://127.0.0.1:4312/v1",
        model: "grok",
        profile: "PROFILE",
        projectDirectory: "/workspace/project",
      }),
      {
        model_provider: GENIE_CODE_GATEWAY_PROVIDER,
        model: "grok",
        databricks_profile: "PROFILE",
        model_providers: {
          [GENIE_CODE_GATEWAY_PROVIDER]: {
            name: "dbx-tools model gateway",
            base_url: "http://127.0.0.1:4312/v1",
            wire_api: "responses",
            requires_openai_auth: false,
            supports_websockets: false,
            http_headers: {
              Authorization: "Bearer secret",
              Originator: "codex",
            },
          },
        },
        projects: {
          "/workspace/project": { trust_level: "trusted" },
        },
        tui: {
          model_availability_nux: { grok: 1 },
        },
      },
    );
  });

  it("writes private TOML atomically inside the pairing home", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-genie-config-"));
    try {
      const destination = await writeGenieCodeConfig({
        bearerToken: "secret",
        gatewayBaseUrl: "http://127.0.0.1:4312/v1",
        homeDirectory: root,
        model: "gpt",
        profile: "PROFILE",
        projectDirectory: "/workspace/project",
      });
      const config = parse(await readFile(destination.configPath, "utf8"));
      const overlay = parse(await readFile(destination.overlayPath, "utf8"));

      assert.equal(config.model, "gpt");
      assert.equal(config.model_providers, undefined);
      assert.equal(
        (overlay.model_providers as Record<string, { http_headers: Record<string, string> }>)[
          GENIE_CODE_GATEWAY_PROVIDER
        ]?.http_headers.Authorization,
        "Bearer secret",
      );
      assert.match(destination.overlayName, /^dbx-[0-9a-f]{32}$/);
      const concurrent = await writeGenieCodeConfig({
        bearerToken: "other-secret",
        gatewayBaseUrl: "http://127.0.0.1:4313/v1",
        homeDirectory: root,
        model: "gpt",
        profile: "PROFILE",
        projectDirectory: "/workspace/other",
      });
      assert.equal(concurrent.home, destination.home);
      assert.notEqual(concurrent.overlayName, destination.overlayName);
      assert.deepEqual(parse(await readFile(destination.configPath, "utf8")).projects, {
        "/workspace/project": { trust_level: "trusted" },
        "/workspace/other": { trust_level: "trusted" },
      });
      if (process.platform !== "win32") {
        assert.equal((await stat(destination.configPath)).mode & 0o777, 0o600);
        assert.equal((await stat(destination.overlayPath)).mode & 0o777, 0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
