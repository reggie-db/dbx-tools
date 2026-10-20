import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { brand } from "./fixtures.ts";
import { updateBrandHistory } from "../src/brand-history.ts";
import { normalizeBrandGenerationRequest } from "../src/schema.ts";

describe("brand generation input and history", () => {
  it("extracts a normalized HTTPS website from free-form brand information", () => {
    assert.deepEqual(
      normalizeBrandGenerationRequest({
        prompt: "Databricks\ndatabricks.com",
      }),
      {
        prompt: "Databricks\ndatabricks.com",
        website: "https://databricks.com/",
      },
    );
  });

  it("preserves free-form information when no website is present", () => {
    assert.deepEqual(
      normalizeBrandGenerationRequest({
        prompt: "A regional restaurant brand with a warm family voice",
      }),
      {
        prompt: "A regional restaurant brand with a warm family voice",
      },
    );
  });

  it("keeps generated brands newest-first, deduplicated, and bounded", () => {
    const firstRequest = { prompt: "First\nfirst.example" };
    const secondRequest = { prompt: "Second\nsecond.example" };
    const first = updateBrandHistory([], firstRequest, brand, 2, new Date("2026-01-01T00:00:00Z"));
    const second = updateBrandHistory(
      first,
      secondRequest,
      brand,
      2,
      new Date("2026-01-02T00:00:00Z"),
    );
    const refreshed = updateBrandHistory(
      second,
      firstRequest,
      brand,
      2,
      new Date("2026-01-03T00:00:00Z"),
    );

    assert.deepEqual(
      refreshed.map(({ request, generatedAt }) => ({ request, generatedAt })),
      [
        { request: firstRequest, generatedAt: "2026-01-03T00:00:00.000Z" },
        { request: secondRequest, generatedAt: "2026-01-02T00:00:00.000Z" },
      ],
    );
  });
});
