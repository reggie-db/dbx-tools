import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { LakebaseSearchBackend, toSearchTerms, toTsQuery } from "../src/lakebase.ts";

/** Lexemes a Postgres text-search parser would emit for a stored row. */
const lexemes = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * A fake pg pool that records every SQL statement and answers `SELECT`s from a
 * canned table. Enough to exercise provisioning, seeding, and search without a
 * real Postgres.
 *
 * Search emulates the parts of Postgres the backend actually relies on: a
 * `term:*` tsquery matches a row when some lexeme STARTS WITH `term` (which is
 * also why a hyphenated document is reachable by its parts), and an `ILIKE`
 * pattern matches anywhere in the row's text.
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
      if (text.includes("ORDER BY ID")) {
        // Empty-query browse: every row, oldest id first.
        return { rows: rows.map((r) => ({ id: r.id, document: r.document, score: 0 })) };
      }
      if (text.startsWith("SELECT ID, DOCUMENT")) {
        const tsquery = String(params[0] ?? "");
        const likes = Array.isArray(params[1]) ? (params[1] as string[]) : undefined;
        const terms = tsquery
          .split(/[&|]/)
          .map((term) => term.trim().replace(/:\*$/, ""))
          .filter(Boolean);
        const hasPrefix = (row: (typeof rows)[number], term: string) =>
          lexemes(row.search_text).some((lexeme) => lexeme.startsWith(term));
        const matches = rows.filter((row) => {
          // The relaxed pass is the one that carries ILIKE patterns.
          if (likes) {
            const haystack = row.search_text.toLowerCase();
            return (
              terms.some((term) => hasPrefix(row, term)) ||
              likes.some((like) => haystack.includes(like.replaceAll("%", "")))
            );
          }
          return terms.every((term) => hasPrefix(row, term));
        });
        return {
          rows: matches.map((r, i) => ({ id: r.id, document: r.document, score: 1 - i * 0.1 })),
        };
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

  it("provisions full-text indexes in a configured schema", async () => {
    const fake = fakePool();
    const be = new LakebaseSearchBackend(
      () => ({}),
      "compliance_engine",
      () => fake.pool,
    );
    await be.addDocuments("municipalities_ga", [{ id: "GA:1", text: "Atlanta Georgia" }]);
    const sql = fake.statements.map((statement) => statement.sql).join("\n");
    assert.match(sql, /CREATE SCHEMA IF NOT EXISTS "compliance_engine"/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "compliance_engine"\."municipalities_ga"/);
    assert.match(sql, /ALTER TABLE "compliance_engine"\."municipalities_ga"/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS search_vector/);
  });

  it("reuses a managed Lakebase pool without owning its lifecycle", async () => {
    const fake = fakePool();
    let ended = false;
    const managedPool = {
      connect: fake.pool.connect.bind(fake.pool),
      end: async () => {
        ended = true;
      },
    };
    const be = new LakebaseSearchBackend(managedPool);

    await be.addDocuments("support", [{ id: "1", text: "managed pool" }]);
    await be.close();

    assert.equal(fake.rows.length, 1);
    assert.equal(ended, false);
  });

  it("resolves a managed Lakebase pool lazily", async () => {
    const fake = fakePool();
    let resolved = 0;
    const be = new LakebaseSearchBackend({
      managedPool: () => {
        resolved += 1;
        return fake.pool;
      },
    });

    assert.equal(resolved, 0);
    await be.addDocuments("support", [{ id: "1", text: "lazy pool" }]);
    assert.equal(resolved, 1);
  });

  it("waits for AppKit to initialize its managed Lakebase pool", async () => {
    const fake = fakePool();
    let attempts = 0;
    const be = new LakebaseSearchBackend({
      managedPool: () => {
        attempts += 1;
        return attempts < 2 ? null : fake.pool;
      },
    });

    await be.addDocuments("support", [{ id: "1", text: "eventual pool" }]);
    assert.equal(attempts, 2);
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

  it("compiles AppKit scalar and array filters with bound parameters", async () => {
    const { be, fake } = backend();
    await be.provision("support", {
      seed: [{ id: "1", text: "billing support", locale: "en", category: "billing" }],
    });

    await be.search("support", "billing", {
      limit: 5,
      filter: { locale: "en", category: ["billing", "support"] },
    });

    const query = fake.statements.findLast((statement) =>
      statement.sql.includes("search_vector @@"),
    );
    assert.match(query?.sql ?? "", /document ->> \$2 = \$3/);
    assert.match(query?.sql ?? "", /document ->> \$4 = ANY\(\$5::text\[\]\)/);
    assert.deepEqual(query?.params, [
      "billing:*",
      "locale",
      "en",
      "category",
      ["billing", "support"],
      5,
    ]);
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

  it("destroys an aborted query client exactly once", async () => {
    const releases: unknown[] = [];
    let rejectQuery: ((reason: Error) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const client = {
      query: () =>
        new Promise<never>((_resolve, reject) => {
          rejectQuery = reject;
          markStarted?.();
        }),
      release: (destroy?: boolean) => {
        releases.push(destroy);
        if (destroy) rejectQuery?.(new Error("query aborted"));
      },
    };
    const pool = {
      connect: async () => client,
      end: async () => {},
    } as unknown as Pool;
    const be = new LakebaseSearchBackend(
      () => ({}),
      "public",
      () => pool,
    );
    const controller = new AbortController();
    const pending = be.search("docs", "query", { signal: controller.signal });

    await started;
    controller.abort();
    await assert.rejects(pending, /query aborted/);
    assert.deepEqual(releases, [true]);
  });
});

describe("lakebase query compilation", () => {
  it("splits a query on punctuation, not just whitespace", () => {
    assert.deepEqual(toSearchTerms("store-intelligence"), ["store", "intelligence"]);
    assert.deepEqual(toSearchTerms("entdata_pos_dev.gk_omnipos"), [
      "entdata",
      "pos",
      "dev",
      "gk",
      "omnipos",
    ]);
    assert.deepEqual(toSearchTerms("  Store   Intel  "), ["store", "intel"]);
    assert.deepEqual(toSearchTerms("---"), []);
  });

  it("keeps a trailing digit run attached, as the index does", () => {
    // The camelCase splitter would yield `gpt` + `4`, but Postgres indexes
    // `gpt4` as one lexeme - no lexeme starts with `4`, so the split form
    // could never match.
    assert.deepEqual(toSearchTerms("gpt4"), ["gpt4"]);
    assert.deepEqual(toSearchTerms("s3 bucket"), ["s3", "bucket"]);
  });

  it("drops repeated terms", () => {
    assert.deepEqual(toSearchTerms("store STORE store-intelligence"), ["store", "intelligence"]);
  });

  it("compiles every term as a prefix", () => {
    assert.equal(toTsQuery(["store", "intel"]), "store:* & intel:*");
    assert.equal(toTsQuery(["store", "intel"], "|"), "store:* | intel:*");
  });

  it("cannot carry tsquery operators out of user input", () => {
    // Splitting on non-alphanumerics is what makes injection impossible.
    const compiled = toTsQuery(toSearchTerms("a & b | !c (d):* '"));
    assert.equal(compiled, "a:* & b:* & c:* & d:*");
  });
});

describe("lakebase search permissiveness", () => {
  const seeded = async () => {
    const { be, fake } = backend();
    await be.provision("docs", {
      seed: [
        { id: "1", title: "racetrac-store-intelligence", text: "store intelligence for racetrac" },
        { id: "2", title: "billing", text: "invoice and billing" },
      ],
    });
    return { be, fake };
  };

  it("matches a hyphenated document from a partial, spaced query", async () => {
    const { be } = await seeded();
    const result = await be.search("docs", "store intel");
    assert.deepEqual(
      result.hits.map((h) => h.id),
      ["1"],
    );
  });

  it("treats a hyphenated query the same as a spaced one", async () => {
    const { be } = await seeded();
    const hyphenated = await be.search("docs", "store-intelligence");
    const spaced = await be.search("docs", "store intelligence");
    assert.deepEqual(
      hyphenated.hits.map((h) => h.id),
      spaced.hits.map((h) => h.id),
    );
    assert.equal(hyphenated.count, 1);
  });

  it("matches a single partial term", async () => {
    const { be } = await seeded();
    const result = await be.search("docs", "intel");
    assert.deepEqual(
      result.hits.map((h) => h.id),
      ["1"],
    );
  });

  it("relaxes to any term when no row matches all of them", async () => {
    const { be, fake } = await seeded();
    const before = fake.statements.length;
    const result = await be.search("docs", "racetrac billing");

    // Both passes ran, and the relaxed one found each single-term match.
    assert.equal(fake.statements.length - before, 2);
    assert.deepEqual(result.hits.map((h) => h.id).sort(), ["1", "2"]);
  });

  it("stops after the precise pass when it finds something", async () => {
    const { be, fake } = await seeded();
    const before = fake.statements.length;
    await be.search("docs", "racetrac");
    assert.equal(fake.statements.length - before, 1);
  });

  it("falls back to a substring for a fragment that is not a prefix", async () => {
    const { be } = await seeded();
    const result = await be.search("docs", "telligence");
    assert.deepEqual(
      result.hits.map((h) => h.id),
      ["1"],
    );
  });

  it("returns rows for an empty or punctuation-only query", async () => {
    const { be } = await seeded();
    assert.equal((await be.search("docs", "")).count, 2);
    assert.equal((await be.search("docs", "  --  ")).count, 2);
  });
});
