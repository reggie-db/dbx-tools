import { defaultBrandContext } from "@dbx-tools/shared-core";
import type {
  BrandPackage,
  GeneratedSchema,
  GeneratorPlan,
  GeneratorRequest,
} from "@dbx-tools/shared-generator";

export const request: GeneratorRequest = {
  company: "Acme",
  purpose: "support operations",
  queries: ["Which support channels are missing SLA targets?"],
  presentation: "dashboard",
  rowCount: 50_000,
};

export const location: GeneratedSchema = {
  catalog: "reggie_pierce_aws_catalog",
  schema: "reggie_acme_support_operations",
  fullName: "reggie_pierce_aws_catalog.reggie_acme_support_operations",
  principal: "reggie@databricks.com",
};

export const plan: GeneratorPlan = {
  table: "support_events",
  rowCount: 50_000,
  columns: [
    { name: "event_id", generator: "id", description: "Stable event identifier." },
    {
      name: "event_date",
      generator: "date",
      description: "Support event date.",
      days: 365,
    },
    {
      name: "channel",
      generator: "category",
      description: "Support channel.",
      values: ["email", "chat", "phone"],
    },
    {
      name: "resolution_hours",
      generator: "number",
      description: "Resolution duration.",
      minimum: 0.5,
      maximum: 48,
      decimals: 2,
    },
  ],
  metrics: [
    {
      name: "avg_resolution_hours",
      label: "Average resolution hours",
      definition: "Mean elapsed time to resolution.",
      unit: "duration",
      targetDirection: "lower",
      sourceUrls: ["https://example.com/kpi"],
      aggregation: "average",
      column: "resolution_hours",
    },
  ],
  story: "A channel-specific incident increases resolution time for eight percent of events.",
  sampleQuestions: [
    "What is average resolution time?",
    "Which channel is slowest?",
    "When did the anomaly begin?",
  ],
};

export const brand: BrandPackage = {
  brand: defaultBrandContext,
  sources: [{ url: "https://dbx.tools/", fetched: true }],
  visualReferences: [],
};
