import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brand, location, plan } from "./fixtures.ts";
import { buildGeneratorDashboard } from "../src/dashboard.ts";
import { buildGeneratorGenieSpace } from "../src/genie.ts";

describe("generator presentation artifacts", () => {
  it("builds an asset-backed dashboard with automatic companion Genie", () => {
    const dashboard = buildGeneratorDashboard({
      location,
      plan,
      brand: brand.brand,
      warehouseId: "warehouse-1",
      company: "Acme",
      purpose: "support operations",
    });
    assert.equal(dashboard.datasets[0]?.asset_name, `${location.fullName}.${plan.table}`);
    assert.deepEqual(dashboard.uiSettings.genieSpace, {
      isEnabled: true,
      enablementMode: "AUTO",
    });
    assert.equal(dashboard.pages[0]?.layoutVersion, "GRID_V1");
  });

  it("builds standalone Genie only from generated tables and questions", () => {
    const genie = buildGeneratorGenieSpace({
      location,
      plan,
      warehouseId: "warehouse-1",
      company: "Acme",
      purpose: "support operations",
    });
    assert.equal(genie.data_sources.tables[0]?.identifier, `${location.fullName}.${plan.table}`);
    assert.equal(genie.config.sample_questions.length, 3);
  });
});
