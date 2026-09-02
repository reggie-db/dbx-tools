import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ensureBrokerTls, ensureClientTls } from "../src/tls.ts";
import { memorySecretStore } from "./support/memory-secrets.ts";

describe("token broker mTLS", () => {
  let directory: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "dbx-token-tls-"));
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("issues CA-signed server and client certificates", async () => {
    const secrets = memorySecretStore();
    const broker = await ensureBrokerTls(directory, ["127.0.0.1", "::1"], secrets);
    const client = await ensureClientTls(directory, "container-client", secrets);
    const ca = new X509Certificate(await readFile(broker.ca));
    const serverCertificate = new X509Certificate(await readFile(broker.cert));
    const clientCertificate = new X509Certificate(await readFile(client.cert));

    assert.equal(serverCertificate.verify(ca.publicKey), true);
    assert.equal(clientCertificate.verify(ca.publicKey), true);
    assert.match(serverCertificate.subjectAltName ?? "", /host\.docker\.internal/);
    assert.match(serverCertificate.subjectAltName ?? "", /host\.containers\.internal/);
    assert.match(clientCertificate.subject, /CN=container-client/);
    assert.equal((await stat(client.key)).mode & 0o777, 0o600);
    await assert.rejects(() => readFile(join(directory, "tls", "ca.key")), /ENOENT/);
    await assert.rejects(() => readFile(join(directory, "tls", "server.key")), /ENOENT/);
  });
});
