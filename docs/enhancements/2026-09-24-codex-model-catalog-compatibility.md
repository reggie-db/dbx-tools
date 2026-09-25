# Codex model catalogue compatibility plan

Created: September 24, 2026.

Status: Partially implemented. Schema corrections and unit coverage are present
in committed source; automatic discovery and live rollout remain unverified.

## Goal

Make every eligible model returned by the proxy's Codex catalogue available in
Codex's `/model` picker, without changing the configured Databricks profile,
claiming unsupported capabilities, or replacing live discovery with a permanent
static catalogue.

## Verified diagnosis

The investigation used Codex CLI `0.148.0` and the proxy on
`http://localhost:4000/v1`.

- A normal `GET /v1/models` returned 296 entries in an OpenAI `data` envelope.
- The same request with `originator: codex_cli_rs` returned 41 entries in a
  Codex `models` envelope. These are different contracts.
- The proxy's Codex response contained two incompatible metadata fields:
  - `web_search_tool_type: null` was rejected with
    `invalid type: null, expected string or map`.
  - `supported_reasoning_levels: ["low", ...]` was rejected with
    `invalid type: string "low", expected struct ReasoningEffortPreset`.
- Loading a captured response through Codex's `model_catalog_json` setting
  reproduced both failures. Correcting both fields made the same CLI accept
  all 41 entries.
- The bundled catalogue contained eight entries, of which five had
  `visibility: "list"`. Falling back to it explains missing proxy models.

These counts are observations, not permanent expectations: discovery and model
retirement can change them. Parser compatibility is confirmed; successful
automatic HTTP discovery after the correction is not yet confirmed.

The provider configuration changed between localhost and a direct Databricks
AI Gateway URL during the investigation. Gateway results must not be used as
evidence that localhost discovery works.

## Scope and ownership

- `packages/rs/model/src/listing.rs`: catalogue serialization and Codex filters.
- `packages/rs/model/src/reasoning.rs`: reasoning-effort values; reuse this enum.
- `packages/rs/model/tests/model.rs`: catalogue regression tests.
- `packages/rs/model-proxy/src/routes.rs`: response selection by `originator`.
- `AGENTS.md`: catalogue compatibility requirements for maintainers.

Do not remove filters simply to make the OpenAI and Codex counts match. The
current Codex filter excludes Claude, Gemini, embedding families, unrecognized
identities, and names without the required `databricks-` prefix. Supporting
excluded models requires separate upstream protocol and tool-use validation.

## Implementation plan

### 1. Correct the metadata contract

Already present in committed source, including commit `bccff2cb`:

- [x] Serialize reasoning levels as `{ effort, description }` objects.
- [x] Emit the non-null enum value `web_search_tool_type: "text"`.
- [x] Emit `supports_search_tool` separately, using discovered capabilities.
  Unsupported native search remains disabled.
- [x] Preserve empty reasoning arrays for models without reasoning controls.
- [x] Preserve OpenAI identities, Codex `system.ai.*` identities, ordering,
  visibility, and existing eligibility filters.
- [x] Update regression tests for reasoning presets and enabled/disabled search.
- [x] Record the contract in `AGENTS.md`.

Do not reapply or revert these changes while executing the remaining plan.

### 2. Add a real-client discovery regression check

- [ ] Add a bounded opt-in check that exercises actual
  `models_payload_with_capabilities` output with a supported Codex CLI version.
  Avoid a separately maintained copy of the schema or response.
- [ ] Cover parser acceptance and automatic HTTP discovery. Loading a
  `model_catalog_json` file alone does not prove remote refresh works.
- [ ] Use a loopback-only ephemeral HTTP server, synthetic authentication, and
  a temporary `CODEX_HOME`. Do not change the user's config, auth, or model cache;
  the fixture server does not need a Databricks profile or workspace credentials.
- [ ] Verify the expected model-list request and that every eligible fixture
  slug appears in `codex debug models`. Compare slug sets, not total counts,
  because Codex may merge its bundled entries.
- [ ] Include models with and without reasoning controls and native search.
  Preserve the existing family-filter tests.
- [ ] Enforce a timeout and clean up the server and child processes. Keep
  ordinary Rust tests independent of whether Codex is installed.

If no request is made, inspect provider/auth refresh requirements separately.
If the request is made but models are missing, inspect the response and refresh
errors. Do not assume cache staleness without evidence.

### 3. Activate the fixed proxy safely

- [x] Run the model-crate tests: all 18 integration tests passed.
- [x] Build `dbx-model-proxy` successfully from the corrected source.
- [ ] Identify the current port-4000 listener and supervisor; do not reuse an
  old PID without checking it.
- [ ] Coordinate the restart with the existing stack's owner. The observed
  proxy was supervised with other services; terminating it directly could stop
  the entire stack.
- [ ] Preserve host, port, profile, authentication, and rate-limit settings.
  Do not automatically choose a replacement Databricks profile.
- [ ] Confirm the restarted process serves the corrected metadata. Building
  an executable does not update a process that is already running.
- [ ] Restart or refresh Codex as needed. Verify its effective provider URL
  points to localhost before checking `/model`.

No live-service restart was performed as part of the confirmed validation.

### 4. Document and close out

- [ ] Add troubleshooting guidance to the owning documentation source,
  respecting generated-README rules. Explain the two envelopes, the `originator`
  header, and bundled fallback after invalid metadata.
- [ ] Explain why embeddings and unsupported families remain absent even when
  discovery works. Do not describe all custom-provider discovery as unsupported.
- [ ] Record the automatic-discovery and live-picker results here. Archive the
  plan under `docs/archived/enhancements` with its final status and archive date
  when the tracked work is complete.

## Validation commands

From the repository root:

```sh
cargo test -p dbx-tools-model --test model codex --offline
cargo test -p dbx-tools-model --offline
cargo build -p dbx-tools-model-proxy --bin dbx-model-proxy --offline
```

The local compiler-cache wrapper failed during the investigation. Tests and
build succeeded with `RUSTC_WRAPPER=` set for those invocations only; do not
change global Cargo settings to work around that local issue.

Inspect the live Codex catalogue without requesting inference:

```sh
curl -sS --max-time 15 \
  -H 'originator: codex_cli_rs' \
  http://localhost:4000/v1/models |
  jq '.models[] | {
    slug,
    supported_reasoning_levels,
    web_search_tool_type,
    supports_search_tool,
    visibility
  }'
```

After checking the active provider configuration:

```sh
codex debug models | jq '.models[] | {slug, visibility}'
codex debug models --bundled | jq '.models[] | {slug, visibility}'
```

For an isolated parser check, capture the live Codex response in a temporary
file and pass its absolute path as `model_catalog_json` under a temporary
`CODEX_HOME`. Do not install that diagnostic override permanently instead of
fixing discovery.

## Acceptance criteria

- The live proxy's Codex response parses successfully in the supported CLI.
- Automatic discovery includes every eligible proxy slug; bundled models may
  also appear.
- `/model` visibly contains representative discovered GPT and non-GPT entries,
  with reasoning descriptions where supported.
- Models without native search do not gain it as a side effect.
- Standard OpenAI listing, eligibility filters, and ordering remain unchanged.
- No permanent provider, profile, authentication, or cache override is required.

Listing success does not prove inference or tool compatibility for every model.
Any inference smoke test is separate, explicitly scoped, and uses the user's
selected profile and approved model.
