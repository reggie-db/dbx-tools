import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createPasswordlessAuth } from "../src/auth.ts";
import { createAuthStorage, resolveAuthStorageConfig } from "../src/storage.ts";

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

  it("accepts a send from a foreign origin (the tunnel binds arbitrary hosts)", async () => {
    let sends = 0;
    const runtime = await createPasswordlessAuth({
      storage: await createAuthStorage({
        storage: "sqlite",
        sqlitePath: join(directory, "origin.sqlite"),
      }),
      baseURL: "http://localhost",
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

    // A browser on the overlay sends Origin: http://<overlay-ip>:6969, which is
    // not the configured baseURL. Before trusting the request's own origin this
    // was rejected with 403 INVALID_ORIGIN and no code was ever sent.
    const response = await runtime.handler(
      jsonRequest(
        "/email-otp/send-verification-otp",
        { email: "user@example.com", type: "sign-in" },
        "http://172.30.212.215:6969",
      ),
    );
    assert.equal(response.status, 200);
    assert.equal(sends, 1);
    await runtime.close();
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
