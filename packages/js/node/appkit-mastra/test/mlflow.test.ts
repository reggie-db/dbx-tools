import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { appkit } from "@dbx-tools/appkit";

import {
  logFeedback,
  mlflowAssessmentTraceId,
  mlflowExperimentManagerUrl,
  resetUcTracePrefixCache,
  ucTracePrefixFromExperimentTags,
  validateFeedbackConfig,
} from "../src/mlflow.ts";

const originalExperimentId = process.env.MLFLOW_EXPERIMENT_ID;
const originalExperimentName = process.env.MLFLOW_EXPERIMENT_NAME;
const originalUcPrefix = process.env.MLFLOW_UC_TRACE_PREFIX;
const originalFetch = globalThis.fetch;

afterEach(() => {
  restoreEnvironment("MLFLOW_EXPERIMENT_ID", originalExperimentId);
  restoreEnvironment("MLFLOW_EXPERIMENT_NAME", originalExperimentName);
  restoreEnvironment("MLFLOW_UC_TRACE_PREFIX", originalUcPrefix);
  resetUcTracePrefixCache();
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

describe("UC assessment trace ids", () => {
  it("uses the bare trace id when no UC prefix is configured", () => {
    assert.equal(mlflowAssessmentTraceId("tr-abc"), "tr-abc");
  });

  it("builds the UC URI Databricks assessments expect", () => {
    assert.equal(
      mlflowAssessmentTraceId("tr-abc", "trace:/reggie.mlflow_traces.demo_otel/"),
      "trace:/reggie.mlflow_traces.demo_otel/tr-abc",
    );
  });
});

describe("UC prefix from experiment tags", () => {
  it("reads the three-part destination path Databricks stores on the experiment", () => {
    assert.equal(
      ucTracePrefixFromExperimentTags([
        {
          key: "mlflow.experiment.databricksTraceDestinationPath",
          value: "reggie.mlflow_traces.demo_otel",
        },
      ]),
      "reggie.mlflow_traces.demo_otel",
    );
  });

  it("falls back to the spans table when the destination path is schema-linked", () => {
    assert.equal(
      ucTracePrefixFromExperimentTags({
        "mlflow.experiment.databricksTraceDestinationPath": "reggie.mlflow_traces",
        "mlflow.experiment.databricksTraceSpanStorageTable":
          "reggie.mlflow_traces.demo_otel_spans",
      }),
      "reggie.mlflow_traces.demo",
    );
  });
});

describe("logFeedback", () => {
  it("posts assessments using the experiment's UC destination tag", async () => {
    delete process.env.MLFLOW_UC_TRACE_PREFIX;
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    const urls: string[] = [];
    const bodies: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      urls.push(String(input));
      if (String(input).includes("/api/2.0/mlflow/experiments/get?")) {
        return Response.json({
          experiment: {
            experiment_id: "123",
            tags: [
              {
                key: "mlflow.experiment.databricksTraceDestinationPath",
                value: "cat.schema.prefix",
              },
            ],
          },
        });
      }
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ assessment: { assessment_id: "a-1" } });
    };

    assert.equal(
      await logFeedback(workspaceClient(), {
        traceId: "tr-abc",
        value: true,
        sourceId: "ada@example.com",
      }),
      "a-1",
    );
    assert.equal(
      urls[1],
      "https://workspace.example.com/api/3.0/mlflow/traces/trace%3A%2Fcat.schema.prefix%2Ftr-abc/assessments",
    );
    assert.deepEqual(bodies[0], {
      assessment: {
        trace_id: "trace:/cat.schema.prefix/tr-abc",
        assessment_name: "user_feedback",
        source: { source_type: "HUMAN", source_id: "ada@example.com" },
        feedback: { value: true },
      },
    });
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
