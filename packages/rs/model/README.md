# dbx-tools-model

Rust Model Serving discovery, capability policy, and endpoint resolution for
Databricks.

## Key features

- Lists live Databricks serving endpoints through the authenticated
  `dbx-tools-core` client.
- Caches the workspace catalogue on disk for five minutes.
- Parses provider, family, version, and model components.
- Classifies chat and embedding endpoints from live task and profile metadata.
- Ranks loose searches with deterministic short-string similarity.
- Refreshes the live catalogue once when a search misses.
- Resolves Codex gateway identities, Responses-only routing, reasoning efforts,
  and complete function-tool support.
- Refreshes Databricks retirement and model-capability documentation daily.
- Embeds committed retirement and capability snapshots for offline fallback.
- Builds OpenAI and Codex model-list envelopes from one catalogue.

## Resolve a serving endpoint

```rust
use dbx_tools_core::DatabricksClient;
use dbx_tools_model::ModelClient;

let databricks = DatabricksClient::new(Some("PROFILE".to_owned())).await?;
let models = ModelClient::new(databricks)?;
let endpoint = models.resolve_model("gpt").await?;
```

Use `resolve_serving_endpoint_for_class` when a route requires an embedding or
a specific chat capability class. The `gpt` family search excludes GPT OSS and
sorts matching endpoints by fuzzy score and descending model version. Sol ranks
above Luna when both variants have the same GPT version.

## Metadata refresh

`ModelStatusResolver` and `ModelCapabilitiesResolver` cache Databricks
documentation results for one day. A failed refresh uses the corresponding
embedded snapshot without blocking endpoint discovery.

Repository synthesis runs:

```sh
cargo run -p dbx-tools-model --example generate-model-metadata -- \
  packages/rs/model/assets/retired-models.json \
  packages/rs/model/assets/model-capabilities.json
```

Both JSON files are generated artifacts. Change the parsers or generator rather
than editing a snapshot by hand.

## Modules

- `models` contains model records, family parsing, service identities, and
  Responses-only policy.
- `classify` assigns model classes and tool support.
- `resolve` ranks searches and model queries.
- `client` owns authenticated catalogue discovery and caching.
- `reasoning` infers supported reasoning efforts.
- `model_status` parses retirement metadata.
- `capabilities` parses Responses, image, patch, and web-search support.
- `listing` builds OpenAI and Codex model-list responses.
