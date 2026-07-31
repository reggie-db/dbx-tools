import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { LakebaseSearchBackend } from "../src/lakebase.ts";

/**
 * A fake pg pool that records every SQL statement and answers `SELECT`s from a
 * canned table. Enough to exercise provisioning, seeding, and search without a
 * real Postgres.
 */
function fakePool() {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const rows: Array<{ id: string; search_text: string; document: unknown }> = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      statements.push({ sql, params });
      const text = sql.trim().toUpperCase();
      if (text.startsWith("SELECT COUNT")) {
        return { rows: [{ count: String(rows.length) }] };
      }
      if (text.startsWith("INSERT INTO")) {
        const [id, searchText, document] = params as [string, string, string];
        const existing = rows.find((r) => r.id === id);
        const doc = JSON.parse(document);
        if (existing) Object.assign(existing, { search_text: searchText, document: doc });
        else rows.push({ id, search_text: searchText, document: doc });
        return { rows: [] };
      }
      if (text.startsWith("SELECT ID, DOCUMENT")) {
        // Search: return rows whose search_text contains the query term.
        const term = String((params as string[])[0] ?? "").toLowerCase();
        const hits = rows
          .filter((r) => r.search_text.toLowerCase().includes(term))
          .map((r, i) => ({ id: r.id, document: r.document, score: 1 - i * 0.1 }));
        return { rows: hits };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    end: async () => {},
  } as unknown as Pool;
  return { pool, statements, rows };
}

function backend() {
  const fake = fakePool();
  const be = new LakebaseSearchBackend(
    () => ({}),
    "public",
    () => fake.pool,
  );
  return { be, fake };
}

describe("lakebase search backend", () => {
  it("provisions a table + GIN index and seeds when empty", async () => {
    const { be, fake } = backend();
    const seeded = await be.provision("main.docs.support", {
      seed: [
        { id: "1", title: "Reset password", text: "How to reset your password" },
        { id: "2", title: "Billing", text: "Update your billing information" },
      ],
    });
    assert.equal(seeded, 2);
    const sql = fake.statements.map((s) => s.sql).join("\n");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "public"\."support"/);
    assert.match(sql, /USING gin \(search_vector\)/);
    assert.equal(fake.rows.length, 2);
  });

  it("returns hits shaped { id, score, fields } identical to Vector Search", async () => {
    const { be } = backend();
    await be.provision("support", {
      seed: [
        { id: "1", title: "Reset password", text: "reset your password here", url: "/reset" },
        { id: "2", title: "Billing", text: "billing information", url: "/billing" },
      ],
    });
    const result = await be.search("support", "password", { limit: 5 });
    assert.equal(result.index, "support");
    assert.equal(result.query, "password");
    assert.equal(result.count, 1);
    const [hit] = result.hits;
    assert.equal(hit.id, "1");
    assert.equal(typeof hit.score, "number");
    // `fields` carries the document minus the internal columns.
    assert.equal(hit.fields.title, "Reset password");
    assert.equal(hit.fields.url, "/reset");
    assert.equal(hit.fields.search_vector, undefined);
  });

  it("does not re-seed a table that already has rows", async () => {
    const { be } = backend();
    await be.provision("support", { seed: [{ id: "1", text: "first" }] });
    const count = await be.provision("support", { seed: [{ id: "2", text: "second" }] });
    assert.equal(count, 1);
  });

  it("upserts by primary key on addDocuments", async () => {
    const { be, fake } = backend();
    await be.addDocuments("support", [{ id: "1", text: "one" }]);
    await be.addDocuments("support", [{ id: "1", text: "one updated" }]);
    assert.equal(fake.rows.length, 1);
    assert.equal(fake.rows[0].search_text.includes("one updated"), true);
  });
});
