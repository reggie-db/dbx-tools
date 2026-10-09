import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { appkit } from "@dbx-tools/appkit";
import { context, trace } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import {
  AgentTraceSpanProcessor,
  appMlflowTraceInfoConfigured,
  directMlflowTraceLocation,
  directMlflowTracingConfigured,
  directMlflowTrackingUri,
  flushDirectMlflowTracing,
  initializeAppMlflowTraceInfo,
  logFeedback,
  mlflowAssessmentTraceId,
  mlflowEnabled,
  mlflowExperimentManagerUrl,
  persistAppMlflowTraceInfo,
  resetAppMlflowTraceInfo,
  resetUcTracePrefixCache,
  ucTracePrefixFromExperimentTags,
  validateFeedbackConfig,
} from "../src/mlflow.ts";
import { APPKIT_AGENT_TRACE_ROOT_ATTR } from "../src/trace-attributes.ts";

const originalExperimentId = process.env.MLFLOW_EXPERIMENT_ID;
const originalExperimentName = process.env.MLFLOW_EXPERIMENT_NAME;
const originalUcPrefix = process.env.MLFLOW_UC_TRACE_PREFIX;
const originalTrackingUri = process.env.MLFLOW_TRACKING_URI;
const originalProfile = process.env.DATABRICKS_CONFIG_PROFILE;
const originalAppOverride = process.env.DBX_TOOLS_DATABRICKS_APP_ENV;
const originalOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const originalOtlpTracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const originalFetch = globalThis.fetch;

class RecordingSpanProcessor implements SpanProcessor {
  readonly started: string[] = [];
  readonly ended: string[] = [];

  onStart(span: Span): void {
    this.started.push(span.name);
  }

  onEnd(span: ReadableSpan): void {
    this.ended.push(span.name);
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

afterEach(() => {
  restoreEnvironment("MLFLOW_EXPERIMENT_ID", originalExperimentId);
  restoreEnvironment("MLFLOW_EXPERIMENT_NAME", originalExperimentName);
  restoreEnvironment("MLFLOW_UC_TRACE_PREFIX", originalUcPrefix);
  restoreEnvironment("MLFLOW_TRACKING_URI", originalTrackingUri);
  restoreEnvironment("DATABRICKS_CONFIG_PROFILE", originalProfile);
  restoreEnvironment("DBX_TOOLS_DATABRICKS_APP_ENV", originalAppOverride);
  restoreEnvironment("OTEL_EXPORTER_OTLP_ENDPOINT", originalOtlpEndpoint);
  restoreEnvironment("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", originalOtlpTracesEndpoint);
  resetUcTracePrefixCache();
  resetAppMlflowTraceInfo();
  globalThis.fetch = originalFetch;
});

describe("direct MLflow configuration", () => {
  it("injects the selected Databricks profile automatically outside Apps", () => {
    process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "false";
    process.env.DATABRICKS_CONFIG_PROFILE = "workspace-profile";
    delete process.env.MLFLOW_TRACKING_URI;

    assert.equal(directMlflowTrackingUri(), "databricks://workspace-profile");
  });

  it("never starts a direct provider inside a Databricks App", () => {
    process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "true";
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    process.env.MLFLOW_TRACKING_URI = "databricks";

    assert.equal(directMlflowTrackingUri(), undefined);
    assert.equal(directMlflowTracingConfigured(), false);
  });

  it("enables trace-info promotion for an App OTLP deployment", () => {
    process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "true";
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4314";

    assert.equal(appMlflowTraceInfoConfigured(), true);
  });

  it("parses the existing UC trace prefix for the direct SDK", () => {
    process.env.MLFLOW_UC_TRACE_PREFIX = "reggie_pierce_aws_catalog.mlflow_traces.demo";
    assert.deepEqual(directMlflowTraceLocation(), {
      catalogName: "reggie_pierce_aws_catalog",
      schemaName: "mlflow_traces",
      tablePrefix: "demo",
    });
  });

  it("enables MLflow feedback for automatic local direct tracing", () => {
    process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "false";
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

    assert.equal(directMlflowTracingConfigured(), true);
    assert.equal(mlflowEnabled(), true);
  });
});

describe("Databricks Apps MLflow trace-info promotion", () => {
  it("persists trace tags and user metadata without uploading spans", async () => {
    process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "true";
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4314";
    const urls: string[] = [];
    const bodies: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/api/2.0/mlflow/experiments/get?")) {
        return Response.json({
          experiment: {
            experiment_id: "123",
            tags: [
              {
                key: "mlflow.experiment.databricksTraceDestinationPath",
                value: "cat.schema.demo",
              },
            ],
          },
        });
      }
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({});
    };

    assert.equal(await initializeAppMlflowTraceInfo(workspaceClient()), true);
    persistAppMlflowTraceInfo({
      traceId: "0123456789abcdef0123456789abcdef",
      requestTime: 1000,
      executionDuration: 250,
      error: false,
      requestPreview: "question",
      responsePreview: "answer",
      user: "ada@example.com",
      tags: {
        agent: "model-a",
        genie: "true",
        sp_auth: "true",
        tunnel: "portr",
        tunnel_subdomain: "demo",
      },
    });
    await flushDirectMlflowTracing();

    assert.equal(
      urls[1],
      "https://workspace.example.com/api/4.0/mlflow/traces/cat.schema.demo/0123456789abcdef0123456789abcdef/info",
    );
    assert.deepEqual(bodies[0], {
      trace_id: "trace:/cat.schema.demo/0123456789abcdef0123456789abcdef",
      trace_location: {
        type: "UC_TABLE_PREFIX",
        uc_table_prefix: {
          catalog_name: "cat",
          schema_name: "schema",
          table_prefix: "demo",
        },
      },
      request_preview: "question",
      response_preview: "answer",
      request_time: "1970-01-01T00:00:01.000Z",
      execution_duration: "0.25s",
      state: "OK",
      trace_metadata: {
        "mlflow.trace_schema.version": "4",
        "mlflow.trace.user": "ada@example.com",
      },
      tags: {
        agent: "model-a",
        genie: "true",
        sp_auth: "true",
        tunnel: "portr",
        tunnel_subdomain: "demo",
      },
      assessments: [],
    });
  });
});

describe("direct MLflow span filtering", () => {
  it("keeps chat semantics while dropping unrelated HTTP and cache spans", () => {
    const recording = new RecordingSpanProcessor();
    const provider = new NodeTracerProvider({
      spanProcessors: [new AgentTraceSpanProcessor(recording)],
    });
    const httpTracer = provider.getTracer("@opentelemetry/instrumentation-http");
    const cacheTracer = provider.getTracer("cache-manager-cache-manager");
    const mastraTracer = provider.getTracer("mastra");

    const health = httpTracer.startSpan("GET /health", {
      attributes: { "http.target": "/health" },
    });
    health.end();

    const root = mastraTracer.startSpan("mastra.chat_turn", {
      attributes: { [APPKIT_AGENT_TRACE_ROOT_ATTR]: true },
    });
    const parent = trace.setSpan(context.active(), root);
    const request = httpTracer.startSpan("POST", undefined, parent);
    const cache = cacheTracer.startSpan("cache.getOrExecute", undefined, parent);
    const model = mastraTracer.startSpan("model_generation", undefined, parent);
    request.end();
    cache.end();
    model.end();
    root.end();

    assert.deepEqual(recording.started, ["mastra.chat_turn", "model_generation"]);
    assert.deepEqual(recording.ended, ["model_generation", "mastra.chat_turn"]);
  });

  it("accepts an explicitly tagged owned chat root", () => {
    const recording = new RecordingSpanProcessor();
    const provider = new NodeTracerProvider({
      spanProcessors: [new AgentTraceSpanProcessor(recording)],
    });
    const root = provider.getTracer("telemetry").startSpan("mastra.chat_turn", {
      attributes: { [APPKIT_AGENT_TRACE_ROOT_ATTR]: true },
    });
    root.end();

    assert.deepEqual(recording.started, ["mastra.chat_turn"]);
    assert.deepEqual(recording.ended, ["mastra.chat_turn"]);
  });
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
        "mlflow.experiment.databricksTraceSpanStorageTable": "reggie.mlflow_traces.demo_otel_spans",
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
