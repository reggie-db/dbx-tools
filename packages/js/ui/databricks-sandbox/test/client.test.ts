import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SshClient } from "../src/react/client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SshClient", () => {
  it("surfaces AppKit error response messages", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "connect EHOSTUNREACH 192.168.200.10:2222" },
        { status: 500 },
      )) as typeof fetch;
    const client = new SshClient();

    await assert.rejects(client.start("machine-1"), /connect EHOSTUNREACH 192\.168\.200\.10:2222/);
  });

  it("creates and deletes the current user's sandboxes", async () => {
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(new URL(String(input), "http://localhost"), init);
      requests.push(request);
      if (request.method === "POST") {
        return Response.json({
          id: "machine-1",
          name: "project",
          provider: "databricks-sandbox",
          status: "running",
          expiresAt: "2026-10-13T00:00:00.000Z",
          projects: [],
          services: [],
          canStart: false,
          canStop: true,
          canConnect: true,
        });
      }
      return Response.json({ deleted: true });
    }) as typeof fetch;
    const client = new SshClient();

    await client.create();
    await client.delete("machine-1");

    assert.equal(requests[0]?.method, "POST");
    assert.deepEqual(await requests[0]?.json(), {});
    assert.equal(requests[1]?.method, "DELETE");
    assert.equal(requests[1]?.url, "http://localhost/api/databricks-sandbox/machines/machine-1");
  });

  it("returns the authenticated user's project prefix", async () => {
    globalThis.fetch = (async () =>
      Response.json({ pathPrefix: "/sandbox/22padc", projects: [] })) as typeof fetch;
    const client = new SshClient();

    assert.deepEqual(await client.listProjects(), {
      pathPrefix: "/sandbox/22padc",
      projects: [],
    });
  });

  it("creates a project with server-generated defaults", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(new URL(String(input), "http://localhost"), init);
      return Response.json({
        project: {
          id: "project-1",
          name: "project-a1b2c3",
          machineId: "machine-1",
          directory: "/home/sandbox/projects/project-a1b2c3",
          path: "/sandbox/22padc/project-a1b2c3",
          openUrl: "/sandbox/22padc/project-a1b2c3",
          port: 18080,
          stripPrefix: true,
          state: "ready",
        },
      });
    }) as typeof fetch;
    const client = new SshClient();

    const project = await client.addProject({ machineId: "machine-1" });

    assert.equal(project.port, 18080);
    assert.deepEqual(await request?.json(), { machineId: "machine-1" });
  });
});
