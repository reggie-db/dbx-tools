import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brand, location, plan, request } from "./fixtures.ts";
import { createGeneratorWorkflow, type GeneratorWorkflowOperations } from "../src/workflow.ts";

function fakeOperations(calls: string[]): GeneratorWorkflowOperations {
  const kpiResearch = {
    kpis: plan.metrics.map(({ aggregation: _aggregation, column: _column, ...metric }) => metric),
    sources: [{ url: "https://example.com/kpi", fetched: true }],
  };
  return {
    async generateBrand() {
      calls.push("brand");
      return brand;
    },
    async researchKpis() {
      calls.push("kpis");
      return kpiResearch;
    },
    async planData() {
      calls.push("plan");
      return plan;
    },
    async provisionSchema() {
      calls.push("schema");
      return location;
    },
    async materializeData() {
      calls.push("data");
      return {
        tables: [`${location.fullName}.${plan.table}`],
        validationStatements: { avg_resolution_hours: "statement-1" },
      };
    },
    async createDashboard() {
      calls.push("dashboard");
      return { dashboardId: "dashboard-1", companionGenie: "AUTO" };
    },
    async createGenie() {
      calls.push("genie");
      return { spaceId: "space-1", title: "Acme support operations" };
    },
  };
}

async function runApproved(presentation: "dashboard" | "genie") {
  const calls: string[] = [];
  const workflow = createGeneratorWorkflow(fakeOperations(calls), { approval: false });
  const run = await workflow.createRun();
  const result = await run.start({
    inputData: { ...request, presentation },
  });
  assert.equal(result.status, "success");
  return { calls, result: result.status === "success" ? result.result : undefined };
}

describe("generator workflow", () => {
  it("suspends before mutations by default", async () => {
    const calls: string[] = [];
    const workflow = createGeneratorWorkflow(fakeOperations(calls));
    const run = await workflow.createRun();
    const result = await run.start({ inputData: request });
    assert.equal(result.status, "suspended");
    assert.deepEqual(calls, ["brand", "kpis", "plan"]);
  });

  it("uses dashboard companion Genie after approval", async () => {
    const { calls, result } = await runApproved("dashboard");
    assert.deepEqual(calls, ["brand", "kpis", "plan", "schema", "data", "dashboard"]);
    assert.equal(result?.dashboard?.companionGenie, "AUTO");
    assert.equal(result?.genie, undefined);
  });

  it("creates standalone Genie only when no dashboard is requested", async () => {
    const { calls, result } = await runApproved("genie");
    assert.deepEqual(calls, ["brand", "kpis", "plan", "schema", "data", "genie"]);
    assert.equal(result?.dashboard, undefined);
    assert.equal(result?.genie?.spaceId, "space-1");
  });
});
