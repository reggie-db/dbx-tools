# TypeScript-to-Python opportunities identified from dbx-value-ontology

Date: 2026-08-04

## Purpose

This document records only opportunities to translate existing `dbx-tools` TypeScript behavior
into Python. It does not propose application-specific refactors in `dbx-value-ontology`; those are
documented in that repository.

The review used `dbx-value-ontology` as a demand signal. Its Python collector has production use
cases for model serving, Lakebase, workspace content, Genie inventory, bounded retries, and stable
cross-runtime contracts. The goal is not to mirror every TypeScript package. The goal is to port
small, reusable surfaces that already have at least one real Python consumer.

## Existing Python baseline

Three Python packages already demonstrate the desired pattern:

- `packages/py/core` translates the cross-runtime identifier, stable-key, and FNV hash contracts.
- `packages/py/postgres` translates Lakebase address parsing and connection resolution.
- `packages/py/bus` translates the Node Postgres topic-bus envelope and lifecycle.

They use shared fixtures under `packages/test/polyglot`, support direct Git `#subdirectory`
installation, and avoid dragging Node-only dependencies into Python. New ports should follow the
same shape.

## Recommended translation backlog

### P0: Model Serving client and model selection

**Proposed package:** `packages/py/model`

**TypeScript sources**

- `packages/js/node/model/src/invoke.ts`
- `packages/js/node/model/src/serving.ts`
- `packages/js/node/model/src/resolve.ts`
- `packages/js/node/model/src/classes.ts`
- `packages/js/node/model/src/fallback.ts`
- `packages/js/shared/model/src/model.ts`
- `packages/js/shared/model/src/openai-chat.ts`

**Demand observed in Python**

`dbx-value-ontology/python/packages/collect/src/lakespan_collect/serving.py` implements Databricks
authentication, invocation payloads, response decoding, endpoint-specific behavior, and a
Pydantic-AI adapter locally. Its summary and investigation stages depend on that code.

**Translate first**

1. Invocation URL construction and endpoint-name escaping.
2. Authenticated JSON invocation through a structural `WorkspaceClientLike` protocol.
3. Serving endpoint listing into a stable Pydantic model rather than returning SDK internals.
4. Model-class classification and fallback model identifiers.
5. Exact and fuzzy endpoint resolution with deterministic ranking.
6. OpenAI chat-message sanitization and text extraction.
7. Embedding response extraction and dimension validation.

**Do not translate initially**

- AppKit `CacheManager` integration. Begin with uncached functions and an optional Python TTL
  wrapper; preserve the observable result contract rather than the Node cache implementation.
- Mastra-specific adapters.
- Browser-facing schemas that have no Python consumer.

**Polyglot fixtures**

- `packages/test/polyglot/fixtures/model/classification.json`
- `packages/test/polyglot/fixtures/model/resolution.json`
- `packages/test/polyglot/fixtures/model/invocation-urls.json`
- `packages/test/polyglot/fixtures/model/chat-sanitization.json`

This is the highest-value port because it removes repeated endpoint quirks from every Python agent
or collector that calls Databricks Model Serving.

### P0: PostgreSQL advisory locks

**Target package:** extend `packages/py/postgres`

**TypeScript source**

- `packages/js/node/postgres/src/advisory-lock.ts`

**Demand observed in Python**

Python services create schemas, cache tables, and run idempotent materialization steps against
Lakebase. They currently coordinate those operations locally or rely on `CREATE IF NOT EXISTS`.
The Node implementation already defines stable structured lock identities and correct
connection-scoped lock ownership.

**Translate**

- `advisoryLockId` using the same stable-key canonicalization and signed 64-bit SHA-256 prefix.
- session and transaction lock acquisition;
- try-lock variants;
- callback/context-manager helpers that hold one checked-out SQLAlchemy connection for the entire
  critical section;
- explicit unlock behavior and failure handling.

**Polyglot fixtures**

Add structured lock keys and expected signed 64-bit identifiers. Include object key reordering,
mixed scalar types, arrays, Unicode, and invalid cyclic/non-finite inputs.

### P1: Databricks workspace runtime and identity helpers

**Proposed package:** `packages/py/databricks`

**TypeScript sources**

- `packages/js/node/databricks/src/workspace.ts`
- `packages/js/node/appkit/src/databricks.ts`
- `packages/js/node/appkit/src/identity.ts`
- selected environment resolution from `packages/js/node/appkit/src/config.ts`

**Demand observed in Python**

Collectors repeatedly instantiate `WorkspaceClient`, resolve profiles, obtain current-user
identity, and normalize workspace host/id behavior. A small package would make Python services use
the same precedence rules as Node applications.

**Translate**

- default/profile-aware workspace-client construction;
- current-user name and email resolution;
- normalized workspace host URL and workspace-id extraction;
- identity mode constants and header names;
- structural protocols so tests can use lightweight fakes.

Keep this package independent of Spark and collector-specific configuration.

### P1: Databricks workspace filesystem and path normalization

**Proposed package:** add filesystem/path modules to `packages/py/databricks`

**TypeScript sources**

- `packages/js/node/databricks/src/databricks-fs.ts`
- `packages/js/node/databricks/src/databricks-path.ts`
- reusable path contracts from `packages/js/shared/fs`
- selected ignore/match behavior from `packages/js/node/path`

**Demand observed in Python**

Python collectors enumerate and download workspace files and notebooks, cap bytes and file counts,
and apply exclusion rules. Those operations need consistent path normalization and root-boundary
checks more than they need a full Node filesystem abstraction.

**Translate first**

- Databricks home-relative and absolute path normalization;
- workspace/file backend selection where the Python SDK exposes both;
- bounded recursive listing;
- byte-limited download helpers;
- root containment and traversal rejection;
- portable path-match fixtures for exclusions.

Do not port local Node watch/glob behavior unless a Python consumer appears.

### P1: Genie read/chat driver

**Proposed package:** `packages/py/genie`

**TypeScript sources**

- `packages/js/node/genie/src/chat.ts`
- `packages/js/node/genie/src/space.ts`
- contracts from `packages/js/shared/genie`

**Demand observed in Python**

Python inventory and investigation code needs Genie space metadata and may later run questions for
evidence collection. SDK coverage changes by Databricks runtime, so a stable REST-based driver is
useful across languages.

**Translate**

- get-space normalization;
- start-conversation, create-message, and poll-to-terminal flows;
- typed async event/message models;
- snapshot diffing and attachment/query-result normalization;
- cancellation and bounded polling.

Space creation, patching, and permissions should remain a separate follow-up because they are not
part of the current Node Genie package's public contract.

### P2: Small shared-core runtime subset

**Target package:** extend `packages/py/core` only when two Python packages consume each helper

**TypeScript sources**

- `packages/js/shared/core/src/error.ts`
- `packages/js/shared/core/src/env.ts`
- `packages/js/shared/core/src/json.ts`
- selected polling/cancellation behavior from `packages/js/shared/core/src/async.ts`

**Candidate translations**

- consistent error-message extraction and structured error context;
- environment aliases plus positive integer/number parsing;
- JSON-safe coercion and deterministic JSON values;
- bounded polling with timeout, interval, and cancellation.

Avoid a wholesale shared-core mirror. Port a helper only after another Python package needs the
same contract, then place the behavior in shared polyglot fixtures.

### P2: Search contracts, not the full search runtime

**Possible target:** `packages/py/search`

**TypeScript sources**

- `packages/js/shared/search`
- narrowly reusable result schemas from `packages/js/node/search`

The current demand is for stable search documents, hits, filters, and pagination contracts. The
Node runtime is tightly integrated with AppKit, Model Serving, and JavaScript plugin lifecycles, so
translating the entire implementation would be speculative. Start only when a Python service must
produce or consume the same search wire format.

## Translation order

1. `py/model` invocation, schemas, classification, and endpoint resolution.
2. Python advisory locks in `py/postgres`.
3. `py/databricks` workspace identity/configuration.
4. `py/databricks` filesystem/path subset.
5. `py/genie` read/chat driver.
6. Demand-driven additions to `py/core` and shared search contracts.

## Definition of done for each port

- The Python API has snake_case names plus compatibility aliases only where the existing Python
  packages already follow that convention.
- TypeScript and Python consume the same JSON fixtures for deterministic behavior.
- Network clients are structural protocols and can be tested without a live workspace.
- Package metadata is generated from the root projen configuration.
- The package is directly installable from the repository Git URL and subdirectory.
- The README states which TypeScript contract is mirrored and which Node-only behavior is omitted.
- At least one real Python consumer adopts the package before additional surface is translated.

## Explicit non-goals

- Translating React/UI packages.
- Translating Mastra internals into a competing Python agent framework.
- Mirroring every utility in `shared-core`.
- Moving application-specific ontology, collection, scoring, or artifact schemas into `dbx-tools`.
