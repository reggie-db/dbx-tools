import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SEARCH_DEFAULT_BASE_PATH,
  SEARCH_PLUGIN_NAME,
  SEARCH_ROUTES,
  searchSchemas,
} from "../index.ts";

describe("search route contract", () => {
  it("derives the default base path from the plugin name", () => {
    assert.equal(SEARCH_DEFAULT_BASE_PATH, `/api/${SEARCH_PLUGIN_NAME}`);
  });

  it("joins published base paths and shared route segments without duplicate slashes", () => {
    assert.equal(
      searchSchemas.searchRoute("/custom/search/", SEARCH_ROUTES.universal),
      "/custom/search/universal",
    );
  });

  it("defaults an omitted client-config base path to the shared owner", () => {
    assert.equal(
      searchSchemas.searchClientConfigSchema.parse({ indexes: [], pageSize: 10 }).basePath,
      SEARCH_DEFAULT_BASE_PATH,
    );
  });
});
