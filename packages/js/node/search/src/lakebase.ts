/**
 * Lakebase (Postgres) full-text runtime behind `lakebaseAiSearch`. It provisions
 * a single table per index alias, indexes a generated
 * `tsvector`, and answers queries with a prefix `to_tsquery` + `ts_rank`.
 *
 * Queries are compiled rather than passed through `websearch_to_tsquery`,
 * because a search box needs two things that function does not give:
 * punctuation-insensitivity (so `store-intelligence` matches the same rows as
 * `store intelligence`) and prefix matching (so `intel` reaches
 * `intelligence`). See {@link toSearchTerms} / {@link toTsQuery}.
 *
 * The whole point is parity: this backend returns the EXACT same
 * `@dbx-tools/shared-search` shapes (`SearchResult` / `SearchHit` /
 * `UpsertResult`) as the Vector Search backend, so the client, the Mastra
 * tools, the routes, and the React search box cannot tell which one answered.
 * A hit's `id` is the primary key, its `score` is the text-rank, and `fields`
 * is the stored document minus the internal columns.
 *
 * Standalone callers can supply a `PoolConfig` factory and let this backend own
 * the resulting pool. AppKit integrations instead supply the Lakebase plugin's
 * managed pool directly, preserving its routing and credential refresh.
 *
 * @module
 */

import { ExecutionError } from "@databricks/appkit";
import { log, object, string } from "@dbx-tools/shared-core";
import type {
  SearchDocument,
  SearchHit,
  SearchRequest,
  SearchResult,
  UpsertResult,
} from "@dbx-tools/shared-search";
import { Pool, type PoolClient, type PoolConfig } from "pg";

const logger = log.logger("search/lakebase");

/** The internal columns every search table carries, excluded from a hit's `fields`. */
const RESERVED_COLUMNS = new Set(["id", "search_text", "document", "search_vector"]);

/**
 * Split a search-box string into the terms a tsquery is built from, using the
 * shared `@dbx-tools/shared-core` tokenizer so the splitting rules stay
 * consistent with the rest of the toolkit.
 *
 * Splitting on punctuation is what makes `store-intelligence` behave like
 * `store intelligence`. Postgres indexes a hyphenated word as the compound
 * lexeme PLUS each of its parts, but compiles a hyphenated QUERY to the
 * compound alone - so `store-intelligence` demands a `store-intellig` lexeme
 * that a document titled `racetrac-store-intelligence` does not have, and the
 * search silently returns nothing while `store intelligence` returns
 * everything. Same for `.` and `_` in a table reference.
 *
 * `camelCase: false` is load-bearing rather than a default: the camelCase
 * splitter also breaks digit runs, turning `gpt4` into `gpt` + `4` and `s3`
 * into `s` + `3`. Postgres indexes each of those as ONE lexeme, so no lexeme
 * ever starts with the trailing digits and the precise pass could not match
 * them. Keeping punctuation as the only boundary mirrors how the index was
 * built.
 */
export function toSearchTerms(query: string): string[] {
  return [
    ...string.tokenizeWithOptions({ lowerCase: true, camelCase: false, distinct: true }, query),
  ];
}

/**
 * Compile terms into a `to_tsquery` input where every term is a PREFIX, so a
 * partially typed word still matches (`intel:*` reaches `intelligence`).
 *
 * Terms carry only letters and digits by construction, so none of tsquery's
 * operators (`& | ! ( ) : *`) can survive from user input into the compiled
 * string.
 */
export function toTsQuery(terms: readonly string[], operator: "&" | "|" = "&"): string {
  return terms.map((term) => `${term}:*`).join(` ${operator} `);
}

/** Options for a single-index Lakebase search (mirrors the client's `SearchOptions`). */
export interface LakebaseSearchOptions {
  limit?: number;
  filter?: SearchRequest["filter"];
  scoreThreshold?: number;
  signal?: AbortSignal;
}

/** One raw search row before it is shaped into a {@link SearchHit}. */
interface SearchRow {
  id: string;
  document: unknown;
  score: number;
}

/** The managed-pool surface needed by the search backend. */
export interface LakebaseSearchPool {
  connect(): Promise<PoolClient>;
}

type LakebasePoolSource = (() => Promise<PoolConfig> | PoolConfig) | LakebaseSearchPool;

/** Options for provisioning a Lakebase-backed index. */
export interface LakebaseProvisionOptions {
  /** Text column embedded into the search vector. Defaults to `text`. */
  textColumn?: string;
  /** Documents to seed when the table is empty. */
  seed?: SearchDocument[];
  signal?: AbortSignal;
}

/**
 * A Postgres full-text backend. One instance is shared across indexes; each
 * index maps to a table whose name is derived from the index reference.
 */
export class LakebaseSearchBackend {
  private pool: LakebaseSearchPool | undefined;
  private poolPromise: Promise<LakebaseSearchPool> | undefined;
  private ownsPool = false;
  private readonly provisioned = new Set<string>();

  constructor(
    private readonly poolSource: LakebasePoolSource,
    private readonly schema = "public",
    /** How a pool is built from the resolved config. Overridable for tests. */
    private readonly poolFactory: (config: PoolConfig) => Pool = (config) => new Pool(config),
  ) {}

  /** Lazily build (and cache) the pg pool from the resolved Lakebase config. */
  private async getPool(): Promise<LakebaseSearchPool> {
    if (this.pool) return this.pool;
    if (typeof this.poolSource !== "function") {
      this.pool = this.poolSource;
      return this.pool;
    }
    const pgConfigFactory = this.poolSource;
    this.poolPromise ??= (async () => {
      const config = await pgConfigFactory();
      const pool = this.poolFactory(config);
      this.pool = pool;
      this.ownsPool = true;
      return pool;
    })();
    return this.poolPromise;
  }

  /** Close the pool so a restarted app rebuilds it. */
  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    this.poolPromise = undefined;
    this.provisioned.clear();
    if (pool && this.ownsPool) await (pool as Pool).end();
    this.ownsPool = false;
  }

  /**
   * Search a Lakebase-backed index. Returns hits sorted most-relevant-first,
   * shaped identically to the Vector Search backend.
   */
  async search(
    index: string,
    query: string,
    options: LakebaseSearchOptions = {},
  ): Promise<SearchResult> {
    const text = string.trimToEmpty(query);
    const table = this.tableFor(index);
    const limit = options.limit ?? 10;
    const pool = await this.getPool();
    const terms = toSearchTerms(text);

    // An empty (or punctuation-only) box returns rows rather than nothing, so
    // the UI shows content before the user types - as a keyword index would.
    if (terms.length === 0) {
      const filter = this.filterClause(options.filter, 1);
      const limitPosition = filter.params.length + 1;
      const { rows } = await this.query<SearchRow>(
        pool,
        `SELECT id, document, 0::float4 AS score
           FROM ${table}
          WHERE TRUE${filter.sql}
          ORDER BY id
          LIMIT $${limitPosition}`,
        [...filter.params, limit],
        options.signal,
      );
      return this.toResult(text, index, rows, options);
    }

    // Precise pass: every term must match, each as a prefix.
    const strictFilter = this.filterClause(options.filter, 2);
    const strictLimitPosition = strictFilter.params.length + 2;
    const strict = await this.query<SearchRow>(
      pool,
      `SELECT id, document, ts_rank(search_vector, to_tsquery('english', $1)) AS score
         FROM ${table}
        WHERE search_vector @@ to_tsquery('english', $1)
          ${strictFilter.sql}
        ORDER BY score DESC
        LIMIT $${strictLimitPosition}`,
      [toTsQuery(terms), ...strictFilter.params, limit],
      options.signal,
    );
    if (strict.rows.length > 0) return this.toResult(text, index, strict.rows, options);

    // Nothing matched EVERY term, so relax rather than return an empty box:
    // any one term is enough, and an `ILIKE` pass additionally catches a
    // fragment that is not a prefix (`telligence`) or a token the text-search
    // parser split differently than expected. Substring matching cannot use
    // the GIN index, which is why it only runs once the indexed pass fails.
    const relaxedFilter = this.filterClause(options.filter, 3);
    const relaxedLimitPosition = relaxedFilter.params.length + 3;
    const relaxed = await this.query<SearchRow>(
      pool,
      `SELECT id, document, ts_rank(search_vector, to_tsquery('english', $1)) AS score
         FROM ${table}
        WHERE (search_vector @@ to_tsquery('english', $1)
           OR search_text ILIKE ANY($2::text[]))
          ${relaxedFilter.sql}
        ORDER BY score DESC
        LIMIT $${relaxedLimitPosition}`,
      [toTsQuery(terms, "|"), terms.map((term) => `%${term}%`), ...relaxedFilter.params, limit],
      options.signal,
    );
    return this.toResult(text, index, relaxed.rows, options);
  }

  /** Shape raw rows into the `SearchResult` both backends return. */
  private toResult(
    query: string,
    index: string,
    rows: SearchRow[],
    options: LakebaseSearchOptions,
  ): SearchResult {
    const hits: SearchHit[] = rows
      .map((row) => ({
        id: String(row.id),
        score: Number(row.score) || 0,
        fields: this.toFields(row.document),
      }))
      .filter((hit) => options.scoreThreshold === undefined || hit.score >= options.scoreThreshold);
    return { query, index, hits, count: hits.length };
  }

  /**
   * Ensure the table + full-text index exist and seed documents when empty.
   * Idempotent, so it is safe to call on every boot.
   */
  async provision(index: string, options: LakebaseProvisionOptions = {}): Promise<number> {
    const table = this.tableFor(index);
    const pool = await this.getPool();
    await this.ensureTable(pool, table, options.signal);

    const { rows } = await this.query<{ count: string }>(
      pool,
      `SELECT count(*)::text AS count FROM ${table}`,
      [],
      options.signal,
    );
    const existing = Number(rows[0]?.count ?? "0");
    const seed = options.seed ?? [];
    if (existing === 0 && seed.length > 0) {
      await this.upsert(pool, table, seed, options.textColumn ?? "text", options.signal);
      logger.info("index-seeded", { index, table, count: seed.length });
      return seed.length;
    }
    return existing;
  }

  /** Add or update documents by primary key. */
  async addDocuments(
    index: string,
    documents: SearchDocument[],
    textColumn = "text",
    signal?: AbortSignal,
  ): Promise<UpsertResult> {
    const table = this.tableFor(index);
    const pool = await this.getPool();
    await this.ensureTable(pool, table, signal);
    await this.upsert(pool, table, documents, textColumn, signal);
    return { index, count: documents.length };
  }

  /** Delete documents by primary key. */
  async deleteDocuments(
    index: string,
    ids: Array<string | number>,
    signal?: AbortSignal,
  ): Promise<UpsertResult> {
    const table = this.tableFor(index);
    const pool = await this.getPool();
    await this.query(pool, `DELETE FROM ${table} WHERE id = ANY($1)`, [ids.map(String)], signal);
    return { index, count: ids.length };
  }

  /** Create the table + GIN index once per table (memoized across calls). */
  private async ensureTable(
    pool: LakebaseSearchPool,
    table: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.provisioned.has(table)) return;
    // `document` holds the whole row; `search_text` is the indexed text; the
    // generated `search_vector` keeps the tsvector in lockstep with it so a
    // write never has to compute the vector by hand.
    await this.query(pool, `CREATE SCHEMA IF NOT EXISTS ${this.ident(this.schema)}`, [], signal);
    await this.query(
      pool,
      `CREATE TABLE IF NOT EXISTS ${table} (
         id text PRIMARY KEY,
         search_text text NOT NULL DEFAULT '',
         document jsonb NOT NULL DEFAULT '{}'::jsonb,
         search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED
       )`,
      [],
      signal,
    );
    await this.query(
      pool,
      `ALTER TABLE ${table}
         ADD COLUMN IF NOT EXISTS search_vector tsvector
         GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED`,
      [],
      signal,
    );
    await this.query(
      pool,
      `CREATE INDEX IF NOT EXISTS ${this.ident(`${this.bareName(table)}_fts`)}
         ON ${table} USING gin (search_vector)`,
      [],
      signal,
    );
    this.provisioned.add(table);
    logger.info("index-created", { table });
  }

  /** Upsert rows: the whole document as jsonb + a flattened text blob to index. */
  private async upsert(
    pool: LakebaseSearchPool,
    table: string,
    documents: SearchDocument[],
    textColumn: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const doc of documents) {
      const id = string.trimToNull(String(doc.id ?? doc.ID ?? "")) ?? undefined;
      if (id === undefined) {
        throw new ExecutionError("search (lakebase): a document is missing an `id`", {
          context: { operation: "addDocuments" },
        });
      }
      const searchText = this.searchText(doc, textColumn);
      await this.query(
        pool,
        `INSERT INTO ${table} (id, search_text, document)
           VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (id) DO UPDATE
           SET search_text = EXCLUDED.search_text, document = EXCLUDED.document`,
        [id, searchText, JSON.stringify(doc)],
        signal,
      );
    }
  }

  /** The text a row is indexed by: the text column first, then any other string field. */
  private searchText(doc: SearchDocument, textColumn: string): string {
    const primary = string.trimToEmpty(String(doc[textColumn] ?? ""));
    const rest = Object.entries(doc)
      .filter(([key, value]) => key !== textColumn && key !== "id" && typeof value === "string")
      .map(([, value]) => value as string);
    return [primary, ...rest].filter(Boolean).join("\n");
  }

  /** A hit's `fields`: the stored document minus the reserved/internal keys. */
  private toFields(document: unknown): Record<string, unknown> {
    if (!object.isRecord(document)) return {};
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document)) {
      if (RESERVED_COLUMNS.has(key)) continue;
      fields[key] = value;
    }
    return fields;
  }

  /** Compile AppKit scalar/array filters against the stored JSON document. */
  private filterClause(
    filter: SearchRequest["filter"],
    startPosition: number,
  ): { sql: string; params: unknown[] } {
    if (!filter || Object.keys(filter).length === 0) return { sql: "", params: [] };
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(filter)) {
      const keyPosition = startPosition + params.length;
      params.push(key);
      const valuePosition = startPosition + params.length;
      if (Array.isArray(value)) {
        params.push(value.map(String));
        clauses.push(`document ->> $${keyPosition} = ANY($${valuePosition}::text[])`);
      } else {
        params.push(String(value));
        clauses.push(`document ->> $${keyPosition} = $${valuePosition}`);
      }
    }
    return { sql: ` AND ${clauses.join(" AND ")}`, params };
  }

  /** The fully-qualified table name for an index reference. */
  private tableFor(index: string): string {
    return `${this.ident(this.schema)}.${this.ident(this.bareName(index))}`;
  }

  /** A safe bare table name derived from an index reference. */
  private bareName(reference: string): string {
    const last = reference.split(".").filter(Boolean).pop() ?? reference;
    const slug = string.toSlug(last).replace(/-/g, "_");
    return slug.length > 0 ? slug : "documents";
  }

  /** Quote a Postgres identifier. */
  private ident(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /** Run one query under external cancellation. */
  private async query<T>(
    pool: LakebaseSearchPool,
    sql: string,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<{ rows: T[] }> {
    if (signal?.aborted) throw ExecutionError.canceled();
    const client = await pool.connect();
    let released = false;
    const onAbort = () => {
      if (released) return;
      released = true;
      client.release(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (!released) client.release();
    }
  }
}
