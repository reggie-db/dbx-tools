/**
 * Lakebase → DuckDB + DuckPGQ bridge for lineage / tag / email graph demos.
 *
 * Resolves Lakebase host + OAuth token via the Databricks CLI, ATTACH's the
 * Postgres database, seeds entities / tags / users / lineage, mirrors those
 * tables into DuckDB memory (DuckPGQ cannot build a property graph on attached
 * Postgres tables), installs duckpgq, runs an initial demo, then loops on
 * stdin: an email runs the owner-lineage demo; anything else runs FTS + graph
 * (exact tag name still preferred when it matches).
 *
 * DuckPGQ requires DuckDB **v1.4.x** (not 1.5). Prefer:
 *   DUCKDB_BIN=~/.local/bin/duckdb-1.4.4
 * or install from https://github.com/duckdb/duckdb/releases/tag/v1.4.4
 *
 * Usage:
 *   tsx packages/node/databricks-map/src/lake-duck.ts \
 *     --profile DEFAULT \
 *     --endpoint projects/duck-base/branches/production/endpoints/primary
 *
 * Options: --database, --alias, --user, --port, --tag (first demo tag, default pii),
 * --no-seed, --no-demo, --dry-run.
 *
 * @module
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_DATABASE = "databricks_postgres";
const DEFAULT_ALIAS = "lakebase";
const DEFAULT_PORT = 5432;
const DEFAULT_TAG = "pii";
/** Printed by DuckDB when bootstrap / a search finishes so the prompt can run. */
const READY_MARKER = "--- lake-duck ready ---";
/** DuckPGQ ships for 1.4.x; brew's current bottle is 1.5 and returns HTTP 404. */
const REQUIRED_DUCKDB_MAJOR_MINOR = "v1.4";

/** Inputs for resolving Lakebase connectivity via the Databricks CLI. */
export interface LakeDuckOptions {
  /** Full endpoint resource path: `projects/.../branches/.../endpoints/...`. */
  endpoint: string;
  /** `~/.databrickscfg` profile. Required - never inferred. */
  profile: string;
  /** Postgres database name. */
  database?: string;
  /** DuckDB ATTACH alias. */
  alias?: string;
  /** Postgres role. Defaults to `databricks current-user me`. */
  user?: string;
  /** Postgres port. */
  port?: number;
  /** Tag name used in the lineage expansion demo. */
  tag?: string;
  /** Skip CREATE / INSERT seed (reuse existing Lakebase tables). */
  noSeed?: boolean;
  /** Skip printing the GRAPH_TABLE demos. */
  noDemo?: boolean;
  /** When true, print the SQL and exit without starting DuckDB. */
  dryRun?: boolean;
}

/** Resolved host + OAuth token ready for a Postgres connection string. */
export interface LakebaseCreds {
  host: string;
  password: string;
  user: string;
  database: string;
  port: number;
  endpoint: string;
}

/**
 * Run `databricks <args> -o json` and parse stdout.
 *
 * @throws when the CLI exits non-zero or stdout is not JSON
 */
function databricksJson<T>(args: string[], profile: string): T {
  const result = spawnSync("databricks", [...args, "--profile", profile, "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`failed to spawn databricks CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim() || `exit ${result.status}`;
    throw new Error(`databricks ${args.join(" ")} failed: ${err}`);
  }
  const text = (result.stdout ?? "").trim();
  if (!text) {
    throw new Error(`databricks ${args.join(" ")} returned empty stdout`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`databricks ${args.join(" ")} returned non-JSON stdout`, { cause });
  }
}

/** Pull a nested string field; throw when missing. */
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`expected non-empty string for ${label}`);
  }
  return value.trim();
}

/**
 * Fetch Lakebase host + OAuth password (token) + username via the CLI.
 *
 * - host: `postgres get-endpoint` → `status.hosts.host`
 * - password: `postgres generate-database-credential` → `token` (~1h TTL)
 * - user: option, else `current-user me` → `userName`
 */
export function resolveLakebaseCreds(options: LakeDuckOptions): LakebaseCreds {
  const { endpoint, profile } = options;
  if (!endpoint.trim()) throw new Error("--endpoint is required");
  if (!profile.trim()) throw new Error("--profile is required");

  const endpointJson = databricksJson<{
    status?: { hosts?: { host?: string } };
  }>(["postgres", "get-endpoint", endpoint], profile);
  const host = requireString(endpointJson.status?.hosts?.host, "status.hosts.host");

  const credJson = databricksJson<{ token?: string }>(
    ["postgres", "generate-database-credential", endpoint],
    profile,
  );
  const password = requireString(credJson.token, "token");

  let user = options.user?.trim();
  if (!user) {
    const me = databricksJson<{ userName?: string }>(["current-user", "me"], profile);
    user = requireString(me.userName, "userName");
  }

  return {
    host,
    password,
    user,
    database: options.database?.trim() || DEFAULT_DATABASE,
    port: options.port ?? DEFAULT_PORT,
    endpoint,
  };
}

/**
 * Build a Postgres URI for DuckDB ATTACH.
 *
 * URI form keeps the password out of libpq `password='...'` quoting, which
 * would otherwise terminate the surrounding SQL string literal. User emails
 * (`a@b.com`) and token specials are percent-encoded.
 */
export function postgresConnString(creds: LakebaseCreds): string {
  const user = encodeURIComponent(creds.user);
  const password = encodeURIComponent(creds.password);
  const database = encodeURIComponent(creds.database);
  return `postgresql://${user}:${password}@${creds.host}:${creds.port}/${database}?sslmode=require`;
}

/**
 * Pick a DuckDB binary that can load duckpgq (v1.4.x).
 *
 * Order: `DUCKDB_BIN`, `~/.local/bin/duckdb-1.4.4`, then `duckdb` on PATH
 * (rejected if not 1.4.x).
 */
export function resolveDuckdbBin(): string {
  const candidates = [
    process.env.DUCKDB_BIN?.trim(),
    join(homedir(), ".local", "bin", "duckdb-1.4.4"),
    "duckdb",
  ].filter((v): v is string => Boolean(v));

  for (const bin of candidates) {
    if (bin !== "duckdb" && !existsSync(bin)) continue;
    const version = duckdbVersion(bin);
    if (!version) continue;
    if (version.startsWith(REQUIRED_DUCKDB_MAJOR_MINOR)) return bin;
    if (bin === process.env.DUCKDB_BIN?.trim()) {
      throw new Error(
        `${bin} reports ${version}; duckpgq needs DuckDB ${REQUIRED_DUCKDB_MAJOR_MINOR}.x ` +
          `(brew's duckdb is often 1.5+). Install v1.4.4 from ` +
          `https://github.com/duckdb/duckdb/releases/tag/v1.4.4 ` +
          `and set DUCKDB_BIN, or place it at ~/.local/bin/duckdb-1.4.4`,
      );
    }
  }

  throw new Error(
    `no DuckDB ${REQUIRED_DUCKDB_MAJOR_MINOR}.x binary found for duckpgq. ` +
      `Install from https://github.com/duckdb/duckdb/releases/tag/v1.4.4 ` +
      `→ ~/.local/bin/duckdb-1.4.4 (or set DUCKDB_BIN)`,
  );
}

/** `duckdb --version` first token, or undefined if spawn fails. */
function duckdbVersion(bin: string): string | undefined {
  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return undefined;
  const token = (result.stdout || "").trim().split(/\s+/)[0];
  return token || undefined;
}

/** Escape a SQL string literal (single quotes doubled). */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * DDL + seed rows written into the ATTACH'd Lakebase database.
 *
 * Graph shape:
 *   Tag <-tagged_with- Entity -flows_to-> Entity
 *   Entity -owned_by-> AppUser
 */
export function buildSeedSql(alias: string): string {
  return `
-- Persist demo graph into Lakebase (Postgres).
USE ${alias};

CREATE TABLE IF NOT EXISTS entity (
  id BIGINT PRIMARY KEY,
  name VARCHAR NOT NULL,
  kind VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS tag (
  id BIGINT PRIMARY KEY,
  name VARCHAR NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS app_user (
  id BIGINT PRIMARY KEY,
  email VARCHAR NOT NULL UNIQUE,
  display_name VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_tag (
  entity_id BIGINT NOT NULL REFERENCES entity(id),
  tag_id BIGINT NOT NULL REFERENCES tag(id),
  PRIMARY KEY (entity_id, tag_id)
);

CREATE TABLE IF NOT EXISTS entity_owner (
  entity_id BIGINT NOT NULL REFERENCES entity(id),
  user_id BIGINT NOT NULL REFERENCES app_user(id),
  PRIMARY KEY (entity_id, user_id)
);

CREATE TABLE IF NOT EXISTS lineage (
  src_entity_id BIGINT NOT NULL REFERENCES entity(id),
  dst_entity_id BIGINT NOT NULL REFERENCES entity(id),
  PRIMARY KEY (src_entity_id, dst_entity_id)
);

DELETE FROM lineage;
DELETE FROM entity_owner;
DELETE FROM entity_tag;
DELETE FROM app_user;
DELETE FROM tag;
DELETE FROM entity;

INSERT INTO entity (id, name, kind) VALUES
  (1,  'raw.customers',           'table'),
  (2,  'raw.orders',              'table'),
  (3,  'raw.payments',            'table'),
  (4,  'stg.customers',           'table'),
  (5,  'stg.orders',              'table'),
  (6,  'stg.payments',            'table'),
  (7,  'mart.customer_360',       'table'),
  (8,  'mart.revenue_daily',      'table'),
  (9,  'feat.churn_signals',      'feature_table'),
  (10, 'model.churn_v2',          'model'),
  (11, 'dash.executive_kpis',     'dashboard'),
  (12, 'dash.compliance_pii',     'dashboard'),
  (13, 'raw.support_tickets',     'table'),
  (14, 'stg.support_tickets',     'table'),
  (15, 'mart.support_sla',        'table');

INSERT INTO tag (id, name) VALUES
  (1,  'pii'),
  (2,  'finance'),
  (3,  'ml'),
  (4,  'customer'),
  (5,  'ops'),
  (6,  'raw'),
  (7,  'staging'),
  (8,  'mart'),
  (9,  'gold'),
  (10, 'silver'),
  (11, 'bronze'),
  (12, 'sensitive'),
  (13, 'gdpr'),
  (14, 'hipaa'),
  (15, 'sox'),
  (16, 'revenue'),
  (17, 'orders'),
  (18, 'payments'),
  (19, 'support'),
  (20, 'sla'),
  (21, 'churn'),
  (22, 'features'),
  (23, 'model-serving'),
  (24, 'dashboard'),
  (25, 'executive'),
  (26, 'compliance'),
  (27, 'realtime'),
  (28, 'batch'),
  (29, 'critical'),
  (30, 'deprecated');

INSERT INTO app_user (id, email, display_name) VALUES
  (1, 'alice@example.com',   'Alice Analytics'),
  (2, 'bob@example.com',     'Bob Platform'),
  (3, 'carol@example.com',   'Carol Compliance'),
  (4, 'dave@example.com',    'Dave ML');

INSERT INTO entity_tag (entity_id, tag_id) VALUES
  -- raw.customers
  (1, 1), (1, 4), (1, 6), (1, 11), (1, 12), (1, 13), (1, 28),
  -- raw.orders
  (2, 4), (2, 6), (2, 11), (2, 17), (2, 28),
  -- raw.payments
  (3, 2), (3, 6), (3, 11), (3, 15), (3, 18), (3, 12), (3, 28),
  -- stg.customers
  (4, 1), (4, 4), (4, 7), (4, 10), (4, 12), (4, 13), (4, 28),
  -- stg.orders
  (5, 4), (5, 7), (5, 10), (5, 17), (5, 28),
  -- stg.payments
  (6, 2), (6, 7), (6, 10), (6, 15), (6, 18), (6, 28),
  -- mart.customer_360
  (7, 1), (7, 4), (7, 8), (7, 9), (7, 12), (7, 13), (7, 29),
  -- mart.revenue_daily
  (8, 2), (8, 8), (8, 9), (8, 16), (8, 15), (8, 29),
  -- feat.churn_signals
  (9, 3), (9, 4), (9, 21), (9, 22), (9, 27),
  -- model.churn_v2
  (10, 3), (10, 21), (10, 23), (10, 29),
  -- dash.executive_kpis
  (11, 24), (11, 25), (11, 16), (11, 4), (11, 29),
  -- dash.compliance_pii
  (12, 1), (12, 12), (12, 13), (12, 24), (12, 26), (12, 14),
  -- raw.support_tickets
  (13, 5), (13, 6), (13, 11), (13, 19), (13, 28),
  -- stg.support_tickets
  (14, 5), (14, 7), (14, 10), (14, 19), (14, 28),
  -- mart.support_sla
  (15, 5), (15, 8), (15, 9), (15, 19), (15, 20), (15, 29);

INSERT INTO entity_owner (entity_id, user_id) VALUES
  (1, 2), (2, 2), (3, 2),
  (4, 1), (5, 1), (6, 1),
  (7, 1), (8, 1),
  (9, 4), (10, 4),
  (11, 1), (12, 3),
  (13, 2), (14, 1), (15, 1);

-- Upstream -> downstream (data flows left to right).
INSERT INTO lineage (src_entity_id, dst_entity_id) VALUES
  (1, 4), (2, 5), (3, 6),
  (4, 7), (5, 7), (5, 8), (6, 8),
  (7, 9), (9, 10),
  (7, 11), (8, 11),
  (7, 12), (10, 12),
  (13, 14), (14, 15), (15, 11);
`.trim();
}

/**
 * Mirror Lakebase tables into `memory` and bind the DuckPGQ property graph.
 *
 * DuckPGQ cannot CREATE PROPERTY GRAPH on ATTACH'd Postgres relations.
 */
export function buildGraphBindSql(alias: string): string {
  return `
-- DuckPGQ needs local (memory) tables, not ATTACH'd Postgres relations.
USE memory;

CREATE OR REPLACE TABLE entity AS SELECT * FROM ${alias}.entity;
CREATE OR REPLACE TABLE tag AS SELECT * FROM ${alias}.tag;
CREATE OR REPLACE TABLE app_user AS SELECT * FROM ${alias}.app_user;
CREATE OR REPLACE TABLE entity_tag AS SELECT * FROM ${alias}.entity_tag;
CREATE OR REPLACE TABLE entity_owner AS SELECT * FROM ${alias}.entity_owner;
CREATE OR REPLACE TABLE lineage AS SELECT * FROM ${alias}.lineage;

INSTALL duckpgq FROM community;
LOAD duckpgq;
INSTALL fts;
LOAD fts;

CREATE OR REPLACE PROPERTY GRAPH map
VERTEX TABLES (
  entity LABEL Entity,
  tag LABEL Tag,
  app_user LABEL AppUser
)
EDGE TABLES (
  entity_tag
    SOURCE KEY (entity_id) REFERENCES entity (id)
    DESTINATION KEY (tag_id) REFERENCES tag (id)
    LABEL tagged_with,
  entity_owner
    SOURCE KEY (entity_id) REFERENCES entity (id)
    DESTINATION KEY (user_id) REFERENCES app_user (id)
    LABEL owned_by,
  lineage
    SOURCE KEY (src_entity_id) REFERENCES entity (id)
    DESTINATION KEY (dst_entity_id) REFERENCES entity (id)
    LABEL flows_to
);

-- BM25 over entity name/kind and tag name; rebuilt each session after the mirror.
PRAGMA create_fts_index('entity', 'id', 'name', 'kind', overwrite=1);
PRAGMA create_fts_index('tag', 'id', 'name', overwrite=1);
`.trim();
}

/** Example GRAPH_TABLE queries: tag → tagged entities → lineage closure. */
export function buildDemoSql(tag: string): string {
  const tagLit = sqlString(tag);
  const tagLabel = tag.replace(/'/g, "");
  return `
.print ''
.print '=== counts ==='
SELECT 'entity' AS t, count(*)::BIGINT AS n FROM entity
UNION ALL SELECT 'tag', count(*)::BIGINT FROM tag
UNION ALL SELECT 'app_user', count(*)::BIGINT FROM app_user
UNION ALL SELECT 'entity_tag', count(*)::BIGINT FROM entity_tag
UNION ALL SELECT 'lineage', count(*)::BIGINT FROM lineage
ORDER BY t;

.print ''
.print '=== entities tagged ${tagLabel} ==='
FROM GRAPH_TABLE (map
  MATCH (e:Entity)-[tw:tagged_with]->(t:Tag)
  WHERE t.name = ${tagLit}
  COLUMNS (e.id AS entity_id, e.name AS entity, e.kind, t.name AS tag)
)
ORDER BY entity_id;

.print ''
.print '=== tag ${tagLabel} -> tagged entities -> downstream via lineage (1..8 hops) ==='
SELECT
  tag,
  tagged_entity,
  tagged_kind,
  downstream,
  downstream_kind,
  path_hops - 1 AS lineage_hops
FROM (
  FROM GRAPH_TABLE (map
    MATCH p = ANY SHORTEST (t:Tag)<-[tw:tagged_with]-(src:Entity)-[f:flows_to]->{1,8}(dst:Entity)
    WHERE t.name = ${tagLit}
    COLUMNS (
      t.name AS tag,
      src.name AS tagged_entity,
      src.kind AS tagged_kind,
      dst.name AS downstream,
      dst.kind AS downstream_kind,
      path_length(p) AS path_hops
    )
  )
)
ORDER BY tagged_entity, lineage_hops, downstream;

.print ''
.print '=== tag ${tagLabel}: distinct reachable downstream entities ==='
SELECT DISTINCT downstream, downstream_kind
FROM (
  FROM GRAPH_TABLE (map
    MATCH (t:Tag)<-[tw:tagged_with]-(src:Entity)-[f:flows_to]->{1,8}(dst:Entity)
    WHERE t.name = ${tagLit}
    COLUMNS (dst.name AS downstream, dst.kind AS downstream_kind)
  )
)
ORDER BY downstream;

.print ''
.print '=== owners of entities tagged ${tagLabel} ==='
FROM GRAPH_TABLE (map
  MATCH (e:Entity)-[tw:tagged_with]->(t:Tag),
        (e:Entity)-[ob:owned_by]->(u:AppUser)
  WHERE t.name = ${tagLit}
  COLUMNS (e.name AS entity, t.name AS tag, u.email AS owner_email, u.display_name AS owner)
)
ORDER BY entity, owner_email;

.print ''
.print 'Tip: enter a tag, entity name fragment (e.g. churn customer), or owner email; quit to exit.'
.print ''
.print '${READY_MARKER}'
`.trim();
}

/**
 * Resolve a free-text prompt into graph seeds, then expand lineage.
 *
 * Priority:
 * 1. Exact tag name → all entities with that tag
 * 2. Else BM25 over entity name/kind + fuzzy tag hits → those entities
 * Then walk `flows_to` from the seed set.
 */
export function buildSearchSql(query: string): string {
  const qLit = sqlString(query);
  const qLabel = query.replace(/'/g, "");
  return `
CREATE OR REPLACE TEMP TABLE search_seeds AS
WITH q AS (SELECT ${qLit} AS query),
exact_tag AS (
  SELECT t.id AS tag_id, t.name AS tag_name
  FROM tag t, q
  WHERE lower(t.name) = lower(q.query)
),
from_exact_tag AS (
  SELECT
    e.id AS entity_id,
    e.name AS entity,
    e.kind,
    'tag:' || etag.tag_name AS via,
    1000.0 AS score
  FROM entity e
  JOIN entity_tag xt ON xt.entity_id = e.id
  JOIN exact_tag etag ON etag.tag_id = xt.tag_id
),
from_entity_fts AS (
  SELECT
    e.id AS entity_id,
    e.name AS entity,
    e.kind,
    'fts:entity' AS via,
    fts_main_entity.match_bm25(e.id, (SELECT query FROM q))::DOUBLE AS score
  FROM entity e, q
  WHERE NOT EXISTS (SELECT 1 FROM exact_tag)
    AND fts_main_entity.match_bm25(e.id, q.query) IS NOT NULL
),
from_tag_fts AS (
  SELECT
    e.id AS entity_id,
    e.name AS entity,
    e.kind,
    'fts:tag:' || t.name AS via,
    fts_main_tag.match_bm25(t.id, (SELECT query FROM q))::DOUBLE AS score
  FROM tag t
  JOIN entity_tag xt ON xt.tag_id = t.id
  JOIN entity e ON e.id = xt.entity_id
  CROSS JOIN q
  WHERE NOT EXISTS (SELECT 1 FROM exact_tag)
    AND fts_main_tag.match_bm25(t.id, q.query) IS NOT NULL
)
SELECT
  entity_id,
  entity,
  kind,
  string_agg(via, ', ' ORDER BY via) AS via,
  max(score) AS score
FROM (
  SELECT * FROM from_exact_tag
  UNION ALL
  SELECT * FROM from_entity_fts
  UNION ALL
  SELECT * FROM from_tag_fts
)
GROUP BY entity_id, entity, kind;

.print ''
.print '=== search hits for ${qLabel} ==='
SELECT entity_id, entity, kind, via, round(score, 3) AS score
FROM search_seeds
ORDER BY score DESC, entity_id;

.print ''
.print '=== ${qLabel} seeds -> downstream via lineage (1..8 hops) ==='
FROM GRAPH_TABLE (map
  MATCH p = ANY SHORTEST (src:Entity)-[f:flows_to]->{1,8}(dst:Entity)
  WHERE src.id IN (SELECT entity_id FROM search_seeds)
  COLUMNS (
    src.name AS seed_entity,
    src.kind AS seed_kind,
    dst.name AS downstream,
    dst.kind AS downstream_kind,
    path_length(p) AS lineage_hops
  )
)
ORDER BY seed_entity, lineage_hops, downstream;

.print ''
.print '=== ${qLabel}: distinct reachable downstream entities ==='
SELECT DISTINCT downstream, downstream_kind
FROM (
  FROM GRAPH_TABLE (map
    MATCH (src:Entity)-[f:flows_to]->{1,8}(dst:Entity)
    WHERE src.id IN (SELECT entity_id FROM search_seeds)
    COLUMNS (dst.name AS downstream, dst.kind AS downstream_kind)
  )
)
ORDER BY downstream;

.print ''
.print '=== owners of search hits for ${qLabel} ==='
FROM GRAPH_TABLE (map
  MATCH (e:Entity)-[ob:owned_by]->(u:AppUser)
  WHERE e.id IN (SELECT entity_id FROM search_seeds)
  COLUMNS (e.name AS entity, u.email AS owner_email, u.display_name AS owner)
)
ORDER BY entity, owner_email;

.print ''
.print 'Tip: exact tag name, entity text (e.g. "churn customer"), or owner email.'
.print ''
.print '${READY_MARKER}'
`.trim();
}

/** Owner-email lineage demo: owned entities + everything they flow to. */
export function buildEmailDemoSql(email: string): string {
  const emailLit = sqlString(email);
  const emailLabel = email.replace(/'/g, "");
  return `
.print ''
.print '=== entities owned by ${emailLabel} ==='
FROM GRAPH_TABLE (map
  MATCH (e:Entity)-[ob:owned_by]->(u:AppUser)
  WHERE u.email = ${emailLit}
  COLUMNS (e.id AS entity_id, e.name AS entity, e.kind, u.email AS owner_email, u.display_name AS owner)
)
ORDER BY entity_id;

.print ''
.print '=== email ${emailLabel} -> owned entities -> downstream via lineage (1..8 hops) ==='
SELECT
  owner_email,
  owned_entity,
  owned_kind,
  downstream,
  downstream_kind,
  path_hops - 1 AS lineage_hops
FROM (
  FROM GRAPH_TABLE (map
    MATCH p = ANY SHORTEST (u:AppUser)<-[ob:owned_by]-(src:Entity)-[f:flows_to]->{1,8}(dst:Entity)
    WHERE u.email = ${emailLit}
    COLUMNS (
      u.email AS owner_email,
      src.name AS owned_entity,
      src.kind AS owned_kind,
      dst.name AS downstream,
      dst.kind AS downstream_kind,
      path_length(p) AS path_hops
    )
  )
)
ORDER BY owned_entity, lineage_hops, downstream;

.print ''
.print '=== email ${emailLabel}: distinct reachable downstream entities ==='
SELECT DISTINCT downstream, downstream_kind
FROM (
  FROM GRAPH_TABLE (map
    MATCH (u:AppUser)<-[ob:owned_by]-(src:Entity)-[f:flows_to]->{1,8}(dst:Entity)
    WHERE u.email = ${emailLit}
    COLUMNS (dst.name AS downstream, dst.kind AS downstream_kind)
  )
)
ORDER BY downstream;

.print ''
.print '=== tags on entities owned by ${emailLabel} ==='
FROM GRAPH_TABLE (map
  MATCH (e:Entity)-[ob:owned_by]->(u:AppUser),
        (e:Entity)-[tw:tagged_with]->(t:Tag)
  WHERE u.email = ${emailLit}
  COLUMNS (e.name AS entity, t.name AS tag, u.email AS owner_email)
)
ORDER BY entity, tag;

.print ''
.print '${READY_MARKER}'
`.trim();
}

/** True when input looks like an email address. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Full DuckDB init script: extensions, ATTACH, optional seed, optional first demo.
 * Ends with a ready marker the Node prompt loop watches for.
 */
export function buildInitSql(creds: LakebaseCreds, options: LakeDuckOptions): string {
  const alias = options.alias?.trim() || DEFAULT_ALIAS;
  const tag = options.tag?.trim() || DEFAULT_TAG;
  const conn = postgresConnString(creds).replace(/'/g, "''");

  const parts = [
    "INSTALL postgres;",
    "LOAD postgres;",
    `ATTACH '${conn}' AS ${alias} (TYPE postgres);`,
  ];

  if (!options.noSeed) {
    parts.push(buildSeedSql(alias));
  }

  parts.push(buildGraphBindSql(alias));

  if (!options.noDemo) {
    parts.push(buildDemoSql(tag));
  } else {
    parts.push(`.print '${READY_MARKER}'`);
  }

  return parts.join("\n\n");
}

/**
 * Resolve credentials, bootstrap DuckDB (seed + duckpgq), then loop on stdin:
 * email → owner lineage demo, otherwise → tag lineage demo. `quit` / `exit` / `q` ends.
 */
export function startLakeDuck(options: LakeDuckOptions): void {
  const duckdbBin = resolveDuckdbBin();
  const creds = resolveLakebaseCreds(options);
  const sql = buildInitSql(creds, options);

  if (options.dryRun) {
    const redacted = sql.replace(/:([^@/'\s]+)@/, ":***@");
    process.stdout.write(`${redacted}\n`);
    return;
  }

  const initPath = join(tmpdir(), `lake-duck-${process.pid}.sql`);
  writeFileSync(initPath, sql, { mode: 0o600 });

  const cleanup = () => {
    try {
      unlinkSync(initPath);
    } catch {
      // ignore - best-effort cleanup of the credential-bearing init file
    }
  };

  process.stderr.write(`using ${duckdbBin} (${duckdbVersion(duckdbBin)})\n`);

  const child = spawn(duckdbBin, ["-init", initPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const queue: string[] = [];
  let busy = true;
  let stdinEnded = false;
  let stdoutBuf = "";

  const finish = () => {
    child.stdin?.write(".quit\n");
  };

  const showPrompt = () => {
    process.stdout.write("search> ");
  };

  const drain = () => {
    if (busy) return;
    const raw = queue.shift();
    if (raw === undefined) {
      if (stdinEnded) {
        finish();
        return;
      }
      showPrompt();
      return;
    }

    const line = raw.trim();
    if (!line) {
      drain();
      return;
    }
    if (/^(quit|exit|q|\.quit)$/i.test(line)) {
      finish();
      return;
    }

    busy = true;
    const searchSql = looksLikeEmail(line) ? buildEmailDemoSql(line) : buildSearchSql(line);
    child.stdin?.write(`${searchSql}\n`);
  };

  process.stdout.write(
    "Enter a tag, name fragment (e.g. churn customer), or owner email. quit to exit.\n",
  );

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  rl.on("line", (line) => {
    queue.push(line);
    drain();
  });
  rl.on("close", () => {
    stdinEnded = true;
    drain();
  });

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    process.stdout.write(text);
    stdoutBuf += text;
    if (stdoutBuf.includes(READY_MARKER)) {
      stdoutBuf = "";
      busy = false;
      drain();
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    process.stderr.write(chunk);
  });

  child.on("exit", (code, signal) => {
    cleanup();
    rl.close();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    cleanup();
    process.stderr.write(`failed to spawn duckdb: ${err.message}\n`);
    process.exit(1);
  });
}

/** Minimal argv parser for the CLI entry. */
function parseArgs(argv: string[]): LakeDuckOptions {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run" || arg === "--no-seed" || arg === "--no-demo") {
      out[arg.slice(2)] = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    out[key] = value;
  }

  const profile =
    (typeof out.profile === "string" && out.profile) ||
    process.env.DATABRICKS_CONFIG_PROFILE?.trim() ||
    "";
  const endpoint =
    (typeof out.endpoint === "string" && out.endpoint) ||
    process.env.LAKEBASE_ENDPOINT?.trim() ||
    "";

  if (!profile || !endpoint) {
    process.stderr.write(
      [
        "Usage: lake-duck --profile <PROFILE> --endpoint <ENDPOINT> [options]",
        "",
        "  --profile     ~/.databrickscfg profile (or DATABRICKS_CONFIG_PROFILE)",
        "  --endpoint    projects/.../branches/.../endpoints/... (or LAKEBASE_ENDPOINT)",
        "  --database    Postgres db name (default: databricks_postgres)",
        "  --alias       DuckDB ATTACH alias (default: lakebase)",
        "  --user        Postgres role (default: current-user me)",
        "  --port        Postgres port (default: 5432)",
        "  --tag         First demo tag to expand via lineage (default: pii)",
        "  --no-seed     Skip CREATE/INSERT (reuse existing Lakebase tables)",
        "  --no-demo     Skip the initial GRAPH_TABLE demo (still enters the prompt loop)",
        "  --dry-run     Print SQL (password redacted) and exit",
        "",
        "After bootstrap, prompts for input: an email runs the owner-lineage demo;",
        "anything else full-text-searches entity/tag names then expands lineage",
        "(an exact tag name still prefers the tag path). Type quit to exit.",
        "",
        "Requires DuckDB v1.4.x for duckpgq (not brew's 1.5). Prefer:",
        "  DUCKDB_BIN=~/.local/bin/duckdb-1.4.4",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }

  return {
    profile,
    endpoint,
    ...(typeof out.database === "string" ? { database: out.database } : {}),
    ...(typeof out.alias === "string" ? { alias: out.alias } : {}),
    ...(typeof out.user === "string" ? { user: out.user } : {}),
    ...(typeof out.port === "string" ? { port: Number(out.port) } : {}),
    ...(typeof out.tag === "string" ? { tag: out.tag } : {}),
    ...(out["no-seed"] === true ? { noSeed: true } : {}),
    ...(out["no-demo"] === true ? { noDemo: true } : {}),
    ...(out["dry-run"] === true ? { dryRun: true } : {}),
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
}

if (isMainModule()) {
  try {
    startLakeDuck(parseArgs(process.argv.slice(2)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
