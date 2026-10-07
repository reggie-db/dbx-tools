import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RUNTIME_AUTH_TYPE, databricksAuthClientInfoSchema } from "../src/client.ts";
import { authTypeSchema, targetKindSchema } from "../src/config-schema.ts";
import { AuthType, TargetKind } from "../src/config.ts";
import {
  databricksProfileListSchema,
  databricksProfileSelectionSchema,
  databricksProfileSummarySchema,
} from "../src/profile.ts";

const PROFILE = {
  name: "DEFAULT",
  host: "https://workspace.example.com",
  workspaceId: "1234567890",
  target: TargetKind.Workspace,
  authType: AuthType.DatabricksCli,
  principal: "user@example.com",
};
const CONFIG = {
  profile: PROFILE.name,
  host: PROFILE.host,
  workspaceId: PROFILE.workspaceId,
  target: PROFILE.target,
  authType: PROFILE.authType,
  principal: PROFILE.principal,
};

describe("browser-safe Databricks auth schemas", () => {
  it("validates canonical auth and target values", () => {
    assert.equal(authTypeSchema.parse("databricks-cli"), AuthType.DatabricksCli);
    assert.equal(targetKindSchema.parse("workspace"), TargetKind.Workspace);
    assert.throws(() => authTypeSchema.parse("unknown"));
    assert.throws(() => targetKindSchema.parse("unknown"));
  });

  it("validates profile summaries and lists", () => {
    assert.deepEqual(databricksProfileSummarySchema.parse(PROFILE), PROFILE);
    assert.deepEqual(databricksProfileListSchema.parse([PROFILE]), [PROFILE]);
    assert.throws(() =>
      databricksProfileSummarySchema.parse({
        ...PROFILE,
        host: "http://[]",
      }),
    );
  });

  it("validates ambient and named profile selections", () => {
    assert.deepEqual(databricksProfileSelectionSchema.parse({ kind: "ambient" }), {
      kind: "ambient",
    });
    assert.deepEqual(
      databricksProfileSelectionSchema.parse({
        kind: "profile",
        profile: " DEFAULT ",
      }),
      { kind: "profile", profile: "DEFAULT" },
    );
  });

  it("validates secret-free client configuration", () => {
    assert.deepEqual(databricksAuthClientInfoSchema.parse(CONFIG), CONFIG);
    assert.deepEqual(databricksAuthClientInfoSchema.parse({ ...CONFIG, profile: undefined }), {
      ...CONFIG,
      profile: undefined,
    });
    assert.equal(
      databricksAuthClientInfoSchema.parse({
        ...CONFIG,
        authType: RUNTIME_AUTH_TYPE,
      }).authType,
      RUNTIME_AUTH_TYPE,
    );
    assert.throws(() => authTypeSchema.parse(RUNTIME_AUTH_TYPE));
    assert.equal("accessToken" in databricksAuthClientInfoSchema.parse(CONFIG), false);
  });
});
