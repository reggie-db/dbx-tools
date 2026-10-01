import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createAuthStorage, resolveAuthStorageConfig } from "../src/auth-storage.ts";
import { createPasswordlessAuth } from "../src/auth.ts";

describe("auth storage", () => {
  it("uses a platform data path unless explicitly configured", () => {
    const automatic = resolveAuthStorageConfig({});
    assert.equal(automatic.mode, "auto");
    assert.match(automatic.sqlitePath, /dbx-tools.*auth.*auth\.sqlite/);
    assert.deepEqual(
      resolveAuthStorageConfig({ storage: "sqlite", sqlitePath: "/tmp/auth.sqlite" }),
      { mode: "sqlite", sqlitePath: "/tmp/auth.sqlite" },
    );
  });

  it("prefers a supplied Lakebase pool in auto mode", async () => {
    const pool = {
      connect: async () => {
        throw new Error("not used");
      },
      query: async () => ({ rows: [], rowCount: 0 }),
    };
    const storage = await createAuthStorage({ storage: "auto" }, pool);
    assert.equal(storage.kind, "lakebase");
    assert.equal(storage.database, pool);
  });

  it("falls back to the in-memory adapter in auto mode when sqlite cannot open", async () => {
    // An unwritable sqlite path (a file where a directory is expected) makes the
    // sqlite open fail; auto mode must degrade to memory rather than throw.
    const storage = await createAuthStorage({
      storage: "auto",
      sqlitePath: "/dev/null/auth.sqlite",
    });
    assert.equal(storage.kind, "memory");
    await storage.close();
  });

  it("still throws for explicit sqlite mode when sqlite cannot open", async () => {
    await assert.rejects(
      createAuthStorage({ storage: "sqlite", sqlitePath: "/dev/null/auth.sqlite" }),
    );
  });
});

describe("Better Auth runtime", () => {
  let directory: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "dbx-tools-auth-"));
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("bootstraps an authorized user by OTP and exposes passkey APIs", async () => {
    let sentCode = "";
    let resolveSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      resolveSent = resolve;
    });
    const runtime = await createPasswordlessAuth({
      storage: await createAuthStorage({
        storage: "sqlite",
        sqlitePath: join(directory, "auth.sqlite"),
      }),
      baseURL: "http://localhost",
      basePath: "/api/email/auth",
      logoutRedirectPath: "/login",
      appName: "Test app",
      secret: "test-secret-at-least-thirty-two-characters",
      sessionTtlSeconds: 3600,
      codeTtlSeconds: 600,
      maxAttempts: 5,
      authorizeIdentity: (email) => email.endsWith("@example.com"),
      sendCode: async (_email, code) => {
        sentCode = code;
        resolveSent();
      },
    });

    // OTP send + verify go through better-auth's native emailOTP endpoints
    // (there is no compatibility wrapper).
    const request = await runtime.handler(
      jsonRequest("/email-otp/send-verification-otp", {
        email: "Ada@Example.com",
        type: "sign-in",
      }),
    );
    assert.equal(request.status, 200);
    await sent;
    assert.match(sentCode, /^\d{6}$/);

    const verify = await runtime.handler(
      jsonRequest("/sign-in/email-otp", {
        email: "ada@example.com",
        otp: sentCode,
        name: "ada",
      }),
    );
    assert.equal(verify.status, 200);
    const cookie = verify.headers.getSetCookie()[0]?.split(";")[0];
    assert.ok(cookie);

    const status = await runtime.handler(authRequest("/status", { cookie }));
    assert.deepEqual(await status.json(), {
      authenticated: true,
      email: "ada@example.com",
      enabled: true,
      passkeysEnabled: true,
    });

    const passkeys = await runtime.handler(authRequest("/passkey/list-user-passkeys", { cookie }));
    assert.equal(passkeys.status, 200);

    const foreignLogout = await runtime.handler(
      authRequest("/logout", { cookie, origin: "https://untrusted.example" }, "POST"),
    );
    assert.equal(foreignLogout.status, 403);
    const foreignRefererLogout = await runtime.handler(
      new Request("http://localhost/api/email/auth/logout", {
        method: "POST",
        headers: { cookie, referer: "https://untrusted.example/account" },
      }),
    );
    assert.equal(foreignRefererLogout.status, 403);

    const logout = await runtime.handler(authRequest("/logout", { cookie }, "POST"));
    assert.deepEqual(await logout.json(), { ok: true, redirectTo: "/login" });
    const loggedOutStatus = await runtime.handler(authRequest("/status", { cookie }));
    assert.deepEqual(await loggedOutStatus.json(), {
      authenticated: false,
      enabled: true,
      passkeysEnabled: true,
    });
    await runtime.close();
  });

  it("does not deliver an OTP for an unauthorized identity", async () => {
    let sends = 0;
    const runtime = await createPasswordlessAuth({
      storage: await createAuthStorage({
        storage: "sqlite",
        sqlitePath: join(directory, "unauthorized.sqlite"),
      }),
      baseURL: "http://localhost",
      basePath: "/api/email/auth",
      appName: "Test app",
      secret: "test-secret-at-least-thirty-two-characters",
      sessionTtlSeconds: 3600,
      codeTtlSeconds: 600,
      maxAttempts: 5,
      authorizeIdentity: () => false,
      sendCode: async () => {
        sends++;
      },
    });

    const response = await runtime.handler(
      jsonRequest("/email-otp/send-verification-otp", {
        email: "person@outside.example",
        type: "sign-in",
      }),
    );
    // better-auth still answers 200 (it must not reveal whether an address is
    // allowed), but the unauthorized identity means no code is sent.
    assert.equal(response.status, 200);
    assert.equal(sends, 0);
    await runtime.close();
  });

  it("accepts configured overlay origins and rejects arbitrary origins", async () => {
    let sends = 0;
    const runtime = await createPasswordlessAuth({
      storage: await createAuthStorage({
        storage: "sqlite",
        sqlitePath: join(directory, "origin.sqlite"),
      }),
      baseURL: "http://localhost",
      trustedOrigins: ["http://172.30.212.215:6969"],
      basePath: "/api/email/auth",
      appName: "Test app",
      secret: "test-secret-at-least-thirty-two-characters",
      sessionTtlSeconds: 3600,
      codeTtlSeconds: 600,
      maxAttempts: 5,
      authorizeIdentity: () => true,
      sendCode: async () => {
        sends++;
      },
    });

    const response = await runtime.handler(
      jsonRequest(
        "/email-otp/send-verification-otp",
        { email: "user@example.com", type: "sign-in" },
        "http://172.30.212.215:6969",
      ),
    );
    assert.equal(response.status, 200);
    assert.equal(sends, 1);
    const untrusted = await runtime.handler(
      jsonRequest(
        "/email-otp/send-verification-otp",
        { email: "user@example.com", type: "sign-in" },
        "https://untrusted.example",
      ),
    );
    assert.equal(untrusted.status, 403);
    assert.equal(sends, 1);
    await runtime.close();
  });

  it("automatically accepts Databricks Apps origins only inside an App", async () => {
    const previous = process.env.DBX_TOOLS_DATABRICKS_APP_ENV;
    process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "true";
    let sends = 0;
    const runtime = await createPasswordlessAuth({
      storage: await createAuthStorage({
        storage: "sqlite",
        sqlitePath: join(directory, "databricks-app-origin.sqlite"),
      }),
      baseURL: "https://demo.apps.dbx.tools",
      basePath: "/api/email/auth",
      appName: "Test app",
      secret: "test-secret-at-least-thirty-two-characters",
      sessionTtlSeconds: 3600,
      codeTtlSeconds: 600,
      maxAttempts: 5,
      authorizeIdentity: () => true,
      sendCode: async () => {
        sends++;
      },
    });
    try {
      const platform = await runtime.handler(
        jsonRequest(
          "/email-otp/send-verification-otp",
          { email: "user@example.com", type: "sign-in" },
          "https://dbx-tools-demo-123.aws.databricksapps.com",
        ),
      );
      assert.equal(platform.status, 200);
      assert.equal(sends, 1);
      const arbitrary = await runtime.handler(
        jsonRequest(
          "/email-otp/send-verification-otp",
          { email: "user@example.com", type: "sign-in" },
          "https://untrusted.example",
        ),
      );
      assert.equal(arbitrary.status, 403);
      assert.equal(sends, 1);
    } finally {
      await runtime.close();
      if (previous === undefined) delete process.env.DBX_TOOLS_DATABRICKS_APP_ENV;
      else process.env.DBX_TOOLS_DATABRICKS_APP_ENV = previous;
    }
  });

  it("serializes concurrent startup migrations for one SQLite file", async () => {
    const path = join(directory, "concurrent.sqlite");
    const options = (storage: Awaited<ReturnType<typeof createAuthStorage>>) => ({
      storage,
      baseURL: "http://localhost",
      appName: "Test app",
      secret: "test-secret-at-least-thirty-two-characters",
      sessionTtlSeconds: 3600,
      codeTtlSeconds: 600,
      maxAttempts: 5,
      authorizeIdentity: () => true,
      sendCode: async () => undefined,
    });
    const firstStorage = await createAuthStorage({ storage: "sqlite", sqlitePath: path });
    const secondStorage = await createAuthStorage({ storage: "sqlite", sqlitePath: path });

    const [first, second] = await Promise.all([
      createPasswordlessAuth(options(firstStorage)),
      createPasswordlessAuth(options(secondStorage)),
    ]);

    await first.close();
    await second.close();
  });
});

function authRequest(path: string, headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`http://localhost/api/email/auth${path}`, {
    method,
    headers: { origin: "http://localhost", ...headers },
  });
}

function jsonRequest(path: string, body: unknown, origin = "http://localhost"): Request {
  return new Request(`http://localhost/api/email/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}
