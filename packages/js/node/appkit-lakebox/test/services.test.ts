import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  builtInDefinition,
  idleBuiltInService,
  imageDefinition,
  serviceRoute,
  toLakeboxService,
  withServiceOrigin,
} from "../src/services.ts";
import { lakeboxServicePort, lakeboxUser } from "../src/user.ts";

const user = lakeboxUser("person@example.com", "/lakebox");

describe("Lakebox service definitions", () => {
  it("injects reserved variables and resolves mounts beneath the user's home", () => {
    const definition = imageDefinition(
      {
        name: "hello",
        image: "docker.io/library/python:3.12-alpine",
        env: { GREETING: "hi" },
        mounts: [{ source: "data/", target: "/example", readOnly: true }],
      },
      user,
    );
    const port = lakeboxServicePort(user.hash, "hello");
    assert.equal(definition.port, port);
    assert.deepEqual(definition.env, {
      GREETING: "hi",
      SERVICE_NAME: "hello",
      SERVICE_PATH: `/lakebox/${user.hash}/hello`,
      SERVICE_PORT: String(port),
      PORT: String(port),
    });
    assert.deepEqual(definition.mounts, [
      { source: `${user.home}/data`, target: "/example", readOnly: true },
    ]);
    assert.equal(definition.autostart, true);
    assert.equal(definition.readiness, "tcp");
  });

  it("rejects reserved, credential, built-in, and escaping inputs", () => {
    const base = { name: "app", image: "docker.io/library/alpine:3.22" };
    assert.throws(() => imageDefinition({ ...base, env: { SERVICE_PORT: "1" } }, user), /injected/);
    assert.throws(() => imageDefinition({ ...base, env: { DATABRICKS_TOKEN: "x" } }, user));
    assert.throws(() => imageDefinition({ ...base, name: "terminal" }, user), /built-in/);
    assert.throws(() =>
      imageDefinition({ ...base, mounts: [{ source: "../other", target: "/x" }] }, user),
    );
    assert.throws(() =>
      imageDefinition({ ...base, mounts: [{ source: "/etc", target: "/x" }] }, user),
    );
  });

  it("builds host-environment terminal and desktop services on derived ports", () => {
    const terminal = builtInDefinition("terminal", user);
    assert.equal(terminal.kind, "terminal");
    assert.ok(terminal.command?.includes(String(lakeboxServicePort(user.hash, "terminal"))));
    assert.equal(terminal.autostart, false);
    const desktop = builtInDefinition("desktop", user);
    assert.ok(desktop.env.DBX_TOOLS_DESKTOP_WALLPAPER_BASE64);
    assert.ok(serviceRoute(desktop).htmlHead);
    const service = idleBuiltInService("desktop", user, "/lakebox");
    assert.equal(service.state, "stopped");
    assert.match(service.openUrl ?? "", /^\/lakebox\/[0-9a-v]{7}\/desktop\/\?autoconnect=1/);
  });

  it("maps controller reports to routed services", () => {
    const definition = imageDefinition(
      { name: "site", image: "docker.io/library/nginx:1", openPath: "/index.html" },
      user,
    );
    const service = toLakeboxService(
      { name: "site", state: "ready", definition, log: "ok" },
      user,
      "/lakebox",
    );
    assert.equal(service.path, `/lakebox/${user.hash}/site`);
    assert.equal(service.openUrl, `/lakebox/${user.hash}/site/index.html`);
    assert.equal(service.openPath, "index.html");
    assert.equal(service.log, "ok");
    assert.equal(
      withServiceOrigin(
        service,
        "https://dbx-tools-demo-7474652124440999.aws.databricksapps.com/chat",
      ).openUrl,
      `https://dbx-tools-demo-7474652124440999.aws.databricksapps.com/lakebox/${user.hash}/site/index.html`,
    );
  });
});
