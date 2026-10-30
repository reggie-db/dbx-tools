import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type WorkspaceClientLike } from "@dbx-tools/appkit";
import { MASTRA_THREAD_ID_KEY } from "@mastra/core/request-context";
import { context, trace } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { MASTRA_AUTH_MODE_KEY, MASTRA_USER_EMAIL_KEY } from "../src/config.ts";
import {
  AgentTraceSpanProcessor,
  appMlflowTraceInfoConfigured,
  directMlflowTraceLocation,
  directMlflowTracingConfigured,
  directMlflowTrackingUri,
  flushDirectMlflowTracing,
  initializeAppMlflowTraceInfo,
  initializeRequestMlflowTraceInfo,
  logFeedback,
  mlflowAssessmentTraceId,
  mlflowEnabled,
  mlflowExperimentManagerUrl,
  mlflowExperimentViewerUrl,
  persistAppMlflowTraceInfo,
  resetAppMlflowTraceInfo,
  resetUcTracePrefixCache,
  ucTracePrefixFromExperimentTags,
} from "../src/mlflow.ts";
import { AppMlflowTraceInfoSpanProcessor } from "../src/telemetry.ts";
import { APPKIT_AGENT_TRACE_ROOT_ATTR } from "../src/trace-attributes.ts";

const originalExperimentId = process.env.MLFLOW_EXPERIMENT_ID;
const originalExperimentName = process.env.MLFLOW_EXPERIMENT_NAME;
const originalUcPrefix = process.env.MLFLOW_UC_TRACE_PREFIX;
const originalMlflowWarehouseId = process.env.MLFLOW_TRACING_SQL_WAREHOUSE_ID;
const originalDatabricksWarehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
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
  restoreEnvironment("MLFLOW_TRACING_SQL_WAREHOUSE_ID", originalMlflowWarehouseId);
  restoreEnvironment("DATABRICKS_WAREHOUSE_ID", originalDatabricksWarehouseId);
  restoreEnvironment("MLFLOW_TRACKING_URI", originalTrackingUri);
  restoreEnvironment("DATABRICKS_CONFIG_PROFILE", originalProfile);
  restoreEnvironment("DBX_TOOLS_DATABRICKS_APP_ENV", originalAppOverride);
  restoreEnvironment("OTEL_EXPORTER_OTLP_ENDPOINT", originalOtlpEndpoint);
  restoreEnvironment("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", originalOtlpTracesEndpoint);
  resetUcTracePrefixCache();
  resetAppMlflowTraceInfo();
  globalThis.fetch = originalFetch;
});

describe("MLflow Node ESM compatibility", () => {
  it("uses exact published filenames for every deep import", () => {
    const source = readFileSync(new URL("../src/mlflow.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/["'](@mlflow\/core\/dist\/[^"']+)["']/g)].map(
      ([, specifier]) => specifier!,
    );

    assert.ok(specifiers.length > 0);
    assert.ok(specifiers.every((specifier) => specifier.endsWith(".js")));
    const imported = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `await Promise.all(${JSON.stringify(specifiers)}.map((specifier) => import(specifier)))`,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
      },
    );
    assert.equal(imported.status, 0, imported.stderr);
  });
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
  it("retries trace-location discovery with a request-scoped client", async () => {
    process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "true";
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4314";
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      if (requests === 1) return new Response("forbidden", { status: 403 });
      return Response.json({
        experiment: {
          experiment_id: "123",
          trace_location: {
            uc_trace_location: {
              catalog: "cat",
              schema: "schema",
              table_prefix: "demo",
            },
          },
        },
      });
    };

    assert.equal(await initializeAppMlflowTraceInfo(workspaceClient()), false);
    assert.equal(await initializeRequestMlflowTraceInfo(workspaceClient()), true);
    assert.equal(requests, 2);
  });

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
            trace_location: {
              uc_trace_location: {
                catalog: "cat",
                schema: "schema",
                table_prefix: "demo",
                effective_table_prefix: "demo",
              },
            },
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

  it("promotes clean fields from the actual exported Mastra trace", async () => {
    process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "true";
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4314";
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
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
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({});
    };
    assert.equal(await initializeAppMlflowTraceInfo(workspaceClient()), true);

    const provider = new NodeTracerProvider({
      spanProcessors: [new AppMlflowTraceInfoSpanProcessor()],
    });
    const tracer = provider.getTracer("mastra");
    const root = tracer.startSpan("invoke_agent Support", {
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.id": "support",
        "mastra.agent_run.input": JSON.stringify([
          { role: "user", parts: [{ type: "text", text: "clean question" }] },
        ]),
        "mastra.agent_run.output": JSON.stringify({ text: "clean answer" }),
        [`mastra.metadata.${MASTRA_USER_EMAIL_KEY}`]: "ada@example.com",
        [`mastra.metadata.${MASTRA_THREAD_ID_KEY}`]: "thread-7",
        [`mastra.metadata.${MASTRA_AUTH_MODE_KEY}`]: "obo",
      },
    });
    const rootContext = trace.setSpan(context.active(), root);
    const model = tracer.startSpan(
      "chat model-a",
      { attributes: { "gen_ai.request.model": "model-a" } },
      rootContext,
    );
    model.end();
    tracer.startSpan("execute_tool ask_genie", undefined, rootContext).end();
    const traceId = root.spanContext().traceId;
    root.end();
    await flushDirectMlflowTracing();
    await provider.shutdown();

    assert.match(urls[1] ?? "", new RegExp(`/${traceId}/info$`));
    assert.equal(bodies[0]?.request_preview, "clean question");
    assert.equal(bodies[0]?.response_preview, "clean answer");
    assert.deepEqual(bodies[0]?.tags, {
      agent: "model-a",
      genie: "true",
      obo_auth: "true",
    });
    assert.deepEqual(bodies[0]?.trace_metadata, {
      "mlflow.trace_schema.version": "4",
      "mlflow.trace.user": "ada@example.com",
      "mlflow.trace.session": "thread-7",
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

describe("UC assessment trace ids", () => {
  it("uses the bare trace id when no UC prefix is configured", () => {
    assert.equal(mlflowAssessmentTraceId("tr-abc"), "tr-abc");
  });

  it("builds the UC URI Databricks assessments expect", () => {
    assert.equal(
      mlflowAssessmentTraceId("tr-abc", "trace:/reggie.mlflow_traces.demo_otel/"),
      "trace:/reggie.mlflow_traces.demo_otel/abc",
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
    process.env.DATABRICKS_WAREHOUSE_ID = "warehouse-1";
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
      return Response.json({ assessment_id: "a-1" });
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
      "https://workspace.example.com/api/4.0/mlflow/traces/cat.schema.prefix/abc/assessments?sql_warehouse_id=warehouse-1",
    );
    const body = bodies[0] as Record<string, unknown>;
    assert.deepEqual(
      {
        ...body,
        create_time: "<timestamp>",
        last_update_time: "<timestamp>",
      },
      {
        trace_id: "abc",
        assessment_name: "user_feedback",
        trace_location: {
          type: "UC_TABLE_PREFIX",
          uc_table_prefix: {
            catalog_name: "cat",
            schema_name: "schema",
            table_prefix: "prefix",
          },
        },
        source: { source_type: "HUMAN", source_id: "ada@example.com" },
        feedback: { value: true },
        create_time: "<timestamp>",
        last_update_time: "<timestamp>",
        valid: true,
      },
    );
    assert.match(String(body.create_time), /^\d{4}-\d{2}-\d{2}T/);
    assert.match(String(body.last_update_time), /^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the V3 assessment contract for non-UC traces", async () => {
    process.env.MLFLOW_UC_TRACE_PREFIX = "";
    delete process.env.MLFLOW_EXPERIMENT_ID;
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return Response.json({ assessment: { assessment_id: "a-2" } });
    };

    assert.equal(
      await logFeedback(workspaceClient(), {
        traceId: "tr-def",
        value: false,
        sourceId: "ada@example.com",
      }),
      "a-2",
    );
    assert.deepEqual(requests, [
      {
        url: "https://workspace.example.com/api/3.0/mlflow/traces/tr-def/assessments",
        body: {
          assessment: {
            trace_id: "tr-def",
            assessment_name: "user_feedback",
            source: { source_type: "HUMAN", source_id: "ada@example.com" },
            feedback: { value: false },
          },
        },
      },
    ]);
  });
});

describe("MLflow experiment manager link", () => {
  it("returns the experiment URL when the OBO client can read it", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/api/2.0/mlflow/experiments/get?experiment_id=123")) {
        return Response.json({ experiment: { experiment_id: "123", name: "demo" } });
      }
      return new Response(null, { status: 404 });
    };

    assert.equal(
      await mlflowExperimentViewerUrl(workspaceClient()),
      "https://workspace.example.com/ml/experiments/123",
    );
  });

  it("omits the experiment URL when the OBO client cannot read it", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    globalThis.fetch = async () => new Response(null, { status: 403 });

    assert.equal(await mlflowExperimentViewerUrl(workspaceClient()), undefined);
  });

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

  it("omits the link when effective view access cannot be established", async () => {
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
            all_permissions: [],
          },
        ],
      });
    };

    assert.equal(await mlflowExperimentManagerUrl(workspaceClient()), undefined);
  });

  it("uses the forwarded viewer identity when it has read access", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/2.0/preview/scim/v2/Me")) {
        return new Response(null, { status: 403 });
      }
      if (url.endsWith("/api/2.0/permissions/experiments/123")) {
        return Response.json({
          access_control_list: [
            {
              user_name: "viewer@example.com",
              all_permissions: [{ permission_level: "CAN_READ" }],
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    };

    assert.equal(
      await mlflowExperimentManagerUrl(workspaceClient(), { userName: "viewer@example.com" }),
      "https://workspace.example.com/ml/experiments/123",
    );
  });

  it("resolves a forwarded viewer id before checking experiment permissions", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/2.0/preview/scim/v2/Users/4739182178671968")) {
        return Response.json({
          id: "4739182178671968",
          userName: "viewer@example.com",
          groups: [{ display: "experiment-managers", value: "group-1" }],
        });
      }
      if (url.endsWith("/api/2.0/permissions/experiments/123")) {
        return Response.json({
          access_control_list: [
            {
              user_name: "viewer@example.com",
              all_permissions: [{ permission_level: "CAN_MANAGE" }],
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    };

    assert.equal(
      await mlflowExperimentManagerUrl(workspaceClient(), { userId: "4739182178671968" }),
      "https://workspace.example.com/ml/experiments/123",
    );
  });

  it("resolves a forwarded viewer's workspace groups through SCIM", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/2.0/preview/scim/v2/Users?filter=")) {
        return Response.json({
          Resources: [
            {
              userName: "viewer@example.com",
              groups: [{ display: "users", value: "group-users" }],
            },
          ],
        });
      }
      if (url.endsWith("/api/2.0/permissions/experiments/123")) {
        return Response.json({
          access_control_list: [
            {
              group_name: "users",
              all_permissions: [{ permission_level: "CAN_MANAGE" }],
            },
          ],
        });
      }
      return new Response(null, { status: 403 });
    };

    assert.equal(
      await mlflowExperimentManagerUrl(workspaceClient(), { userName: "viewer@example.com" }),
      "https://workspace.example.com/ml/experiments/123",
    );
  });

  it("does not infer workspace users access for an unverified tunnel identity", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/2.0/permissions/experiments/123")) {
        return Response.json({
          access_control_list: [
            {
              group_name: "users",
              all_permissions: [{ permission_level: "CAN_MANAGE" }],
            },
          ],
        });
      }
      return new Response(null, { status: 403 });
    };

    assert.equal(
      await mlflowExperimentManagerUrl(workspaceClient(), {
        userName: "reggie.pierce+test@databricks.com",
      }),
      undefined,
    );
  });

  it("uses the built-in users group only for a platform-authenticated workspace user", async () => {
    process.env.MLFLOW_EXPERIMENT_ID = "123";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/2.0/permissions/experiments/123")) {
        return Response.json({
          access_control_list: [
            {
              group_name: "users",
              all_permissions: [{ permission_level: "CAN_READ" }],
            },
          ],
        });
      }
      return new Response(null, { status: 403 });
    };

    assert.equal(
      await mlflowExperimentManagerUrl(workspaceClient(), {
        userName: "viewer@example.com",
        workspaceUser: true,
      }),
      "https://workspace.example.com/ml/experiments/123",
    );
  });
});

function workspaceClient(): WorkspaceClientLike {
  return {
    config: {
      getHost: async () => new URL("https://workspace.example.com"),
      authenticate: async () => {},
    },
  } as unknown as WorkspaceClientLike;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
