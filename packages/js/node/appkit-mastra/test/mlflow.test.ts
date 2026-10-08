import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { appkit } from "@dbx-tools/appkit";

import { mlflowExperimentManagerUrl, validateFeedbackConfig } from "../src/mlflow.ts";

const originalExperimentId = process.env.MLFLOW_EXPERIMENT_ID;
const originalExperimentName = process.env.MLFLOW_EXPERIMENT_NAME;
const originalFetch = globalThis.fetch;

afterEach(() => {
  restoreEnvironment("MLFLOW_EXPERIMENT_ID", originalExperimentId);
  restoreEnvironment("MLFLOW_EXPERIMENT_NAME", originalExperimentName);
  globalThis.fetch = originalFetch;
});

describe("feedback configuration", () => {
  it("fails boot validation when feedback is forced on without an experiment", () => {
    delete process.env.MLFLOW_EXPERIMENT_ID;
    delete process.env.MLFLOW_EXPERIMENT_NAME;

    assert.throws(() => validateFeedbackConfig(true), /no MLflow experiment is configured/);
    assert.doesNotThrow(() => validateFeedbackConfig(undefined));
    assert.doesNotThrow(() => validateFeedbackConfig(false));
  });

  it("accepts either experiment identifier", () => {
    process.env.MLFLOW_EXPERIMENT_NAME = "/Shared/chat";
    assert.doesNotThrow(() => validateFeedbackConfig(true));
  });
});

describe("MLflow experiment manager link", () => {
  it("returns the experiment URL for a manager through group permissions", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/2.0/preview/scim/v2/Me")) {
        return Response.json({
          userName: "viewer@example.com",
          groups: [{ display: "experiment-managers", value: "group-1" }],
        });
      }
      if (url.endsWith("/api/2.0/permissions/experiments/123")) {
        return Response.json({
          access_control_list: [
            {
              group_name: "experiment-managers",
              all_permissions: [{ permission_level: "CAN_MANAGE" }],
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    };

    assert.equal(
      await mlflowExperimentManagerUrl(workspaceClient()),
      "https://workspace.example.com/ml/experiments/123",
    );
  });

  it("omits the link when effective management cannot be established", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/2.0/preview/scim/v2/Me")) {
        return Response.json({ userName: "viewer@example.com", groups: [] });
      }
      return Response.json({
        access_control_list: [
          {
            user_name: "viewer@example.com",
            all_permissions: [{ permission_level: "CAN_EDIT" }],
          },
        ],
      });
    };

    assert.equal(await mlflowExperimentManagerUrl(workspaceClient()), undefined);
  });
});

function workspaceClient(): appkit.WorkspaceClientLike {
  return {
    config: {
      getHost: async () => new URL("https://workspace.example.com"),
      authenticate: async () => {},
    },
  } as unknown as appkit.WorkspaceClientLike;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
