# dbx-tools-model

Rust model discovery and fuzzy endpoint resolution for Databricks.

Key features:

- Lists live Databricks serving endpoints.
- Caches the catalogue on disk with `dbx-tools-databricks`.
- Refreshes Databricks retirement metadata daily with a generated fallback.
- Parses provider, family, version, and model components.
- Classifies chat and embedding endpoints.
- Ranks loose searches with Python-compatible `difflib` similarity.
- Refreshes the live catalogue once when a search misses.

```rust
use dbx_tools_model::ModelClient;

let models = ModelClient::new("https://workspace.example.com")?;
let endpoint = models.resolve("Bearer token", "gpt").await?;
```

The `gpt` family search excludes GPT OSS and sorts matching GPT endpoints by
fuzzy score and descending model version. When both GPT 5.6 variants are
deployed, Sol ranks above Luna.
