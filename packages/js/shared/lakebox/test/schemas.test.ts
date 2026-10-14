import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLakeboxServiceRequestSchema,
  lakeboxCommandRequestSchema,
  LAKEBOX_ROUTES,
  lakeboxSummarySchema,
} from "../index.ts";
import { lakeboxRoute, lakeboxServicePath } from "../src/client.ts";

describe("shared Lakebox contracts", () => {
  it("applies service defaults and rejects reserved or credential environment", () => {
    const parsed = createLakeboxServiceRequestSchema.parse({
      name: "web",
      image: "docker.io/library/nginx:1",
    });
    assert.deepEqual(
      { route: parsed.route, stripPrefix: parsed.stripPrefix, pull: parsed.pull, env: parsed.env },
      { route: true, stripPrefix: true, pull: "missing", env: {} },
    );
    for (const env of [{ PORT: "1" }, { SERVICE_PATH: "/x" }, { DATABRICKS_HOST: "h" }]) {
      assert.equal(
        createLakeboxServiceRequestSchema.safeParse({ name: "web", image: "x", env }).success,
        false,
      );
    }
    assert.equal(
      createLakeboxServiceRequestSchema.safeParse({ name: "Web App", image: "x" }).success,
      false,
    );
  });

  it("keeps commands to one executable token", () => {
    assert.equal(lakeboxCommandRequestSchema.safeParse({ command: "ls -la" }).success, false);
    assert.deepEqual(lakeboxCommandRequestSchema.parse({ command: "ls" }).args, []);
  });

  it("builds routes from shared templates", () => {
    assert.equal(lakeboxRoute(LAKEBOX_ROUTES.serviceLogs, { name: "a b" }), "/services/a%20b/logs");
    assert.equal(lakeboxServicePath("/lakebox/", "abc1234", "web"), "/lakebox/abc1234/web");
  });

  it("marks last-known service lists as stale wire data", () => {
    const summary = lakeboxSummarySchema.parse({
      supported: true,
      auto: true,
      status: "stopped",
      name: "Lakebox",
      user: {
        hash: "abc1234",
        name: "lakebox-abc1234",
        uid: 20_000,
        home: "/home/lakebox-abc1234",
        routePrefix: "/lakebox/abc1234",
      },
      services: [],
      servicesStale: true,
      servicesObservedAt: "2026-10-14T16:00:00.000Z",
      canStart: true,
      canStop: false,
    });

    assert.equal(summary.servicesStale, true);
  });
});
