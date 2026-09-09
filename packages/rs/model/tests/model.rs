use std::{collections::BTreeMap, time::Duration};

use dbx_tools_core::{DatabricksAuthOptions, DatabricksClient, FileCache};
use dbx_tools_model::{
    endpoints_from_response, is_responses_only, lookup_models, model_search_query,
    model_service_names, models_payload, models_payload_with_capabilities,
    parse_model_capabilities, parse_model_name, parse_retired_models, rank_model_id,
    reasoning_efforts_by_family, status_from_names, version_tuple, ModelCapabilitiesResolver,
    ModelClass, ModelClient, ModelFamily, ModelQuery, ModelStatus, ModelStatusResolver,
    ParsedModelName, ReasoningEffort, ServingEndpointSummary,
};
use serde_json::json;
use wiremock::{
    matchers::{header, method, path},
    Mock, MockServer, ResponseTemplate,
};

const RETIREMENT_HTML: &str = r#"
<html>
  <table>
    <tr><th>Partner model</th><th>Retirement date</th></tr>
    <tr><td>Gemini <strong>2.5</strong> Pro</td><td>October 2, 2026</td></tr>
  </table>
  <table>
    <tr><th>Open model</th><th>Retirement date</th></tr>
    <tr><td>DBRX / DBRX Instruct</td><td>April 30, 2025</td></tr>
  </table>
</html>
"#;

#[test]
fn parses_provider_family_version_and_model() {
    for (value, family, version, model) in [
        (
            "databricks-gpt-5-6-sol ",
            ModelFamily::Gpt,
            vec![5, 6],
            vec!["sol"],
        ),
        (
            "databricks-claude-sonnet-4-6",
            ModelFamily::Claude,
            vec![4, 6],
            vec!["sonnet"],
        ),
        (
            "databricks-qwen35-122b-a10b",
            ModelFamily::Qwen,
            vec![3, 5],
            vec!["122b", "a10b"],
        ),
        (
            "qwen3.5-122B-A10B",
            ModelFamily::Qwen,
            vec![3, 5],
            vec!["122b", "a10b"],
        ),
        (
            "databricks-meta-llama-3-3-70b-instruct",
            ModelFamily::Llama,
            vec![3, 3],
            vec!["70b", "instruct"],
        ),
    ] {
        assert_eq!(
            parse_model_name(value),
            Some(ParsedModelName {
                source: value.trim().to_owned(),
                family,
                version,
                model: model.into_iter().map(str::to_owned).collect(),
            })
        );
    }
}

#[test]
fn routed_names_need_no_prefix_registry() {
    assert_eq!(
        model_search_query("dbx/databricks/responses/databricks-gpt-5-6-sol").as_deref(),
        Some("gpt 5 6 sol")
    );
    assert_eq!(version_tuple("databricks-qwen35-122b-a10b"), [35, 122, 0]);
    assert_eq!(
        model_service_names("databricks-gpt-5-6-sol")
            .get("openai")
            .map(String::as_str),
        Some("gpt-5.6-sol")
    );
    assert_eq!(
        model_service_names("databricks-qwen35-122b-a10b")
            .get("alibaba")
            .map(String::as_str),
        Some("qwen3.5-122b-a10b")
    );
}

#[test]
fn gpt_search_returns_the_highest_version_and_excludes_gpt_oss() {
    let endpoints = [
        endpoint("databricks-gpt-5-4", ModelClass::ChatBalanced),
        endpoint("databricks-gpt-5-6-luna", ModelClass::ChatBalanced),
        endpoint("databricks-gpt-5-6-sol", ModelClass::ChatBalanced),
        endpoint("databricks-gpt-oss-120b", ModelClass::ChatBalanced),
    ];

    let resolved = rank_model_id(&endpoints, "gpt", 0.4);

    assert!(resolved.matched);
    assert_eq!(resolved.model_id, "databricks-gpt-5-6-sol");
}

#[test]
fn model_listing_uses_openai_format_and_stable_lookup_ordering() {
    let mut sol = endpoint("databricks-gpt-5-6-sol", ModelClass::ChatBalanced);
    sol.display_name = Some("GPT 5.6 Sol".to_owned());
    sol.service_names
        .insert("openai".to_owned(), "gpt-5.6-sol".to_owned());
    let endpoints = [
        endpoint("databricks-gpt-5-6-luna", ModelClass::ChatBalanced),
        sol,
        endpoint("databricks-gpt-5-4", ModelClass::ChatBalanced),
    ];

    let standard = models_payload(&endpoints, Some("gpt"), false, false);
    let extended = models_payload(&endpoints, Some("gpt"), true, false);

    assert_eq!(
        standard["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "databricks-gpt-5-6-sol",
            "databricks-gpt-5-6-luna",
            "databricks-gpt-5-4",
        ]
    );
    assert!(standard["data"][0].get("score").is_none());
    assert_eq!(extended["data"][0]["score"], 0.0);
    assert_eq!(extended["data"][0]["serviceNames"]["openai"], "gpt-5.6-sol");
}

#[test]
fn responses_and_reasoning_policy_follow_model_identity() {
    assert!(!is_responses_only("databricks-gpt-5-3"));
    assert!(is_responses_only("databricks-gpt-5-4"));
    assert!(is_responses_only("databricks-gpt-6"));
    assert!(!is_responses_only("databricks-gpt-oss-120b"));
    assert!(is_responses_only("databricks-gpt-5-3-codex"));
    assert_eq!(
        reasoning_efforts_by_family("databricks-gpt-5-6-sol"),
        vec![
            ReasoningEffort::None,
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ]
    );
    assert_eq!(
        reasoning_efforts_by_family("databricks-gpt-5-5-pro"),
        vec![
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
        ]
    );
}

#[test]
fn codex_originators_receive_the_codex_model_envelope() {
    let mut gpt = endpoint("databricks-gpt-5-6-sol", ModelClass::ChatBalanced);
    gpt.model_service_name = Some("system.ai.databricks-gpt-5-6-sol".to_owned());
    gpt.reasoning_efforts = reasoning_efforts_by_family(&gpt.name);
    let endpoints = [
        gpt,
        endpoint("databricks-claude-sonnet-4-6", ModelClass::ChatBalanced),
    ];

    let payload = models_payload(&endpoints, None, false, true);

    assert!(payload.get("data").is_none());
    assert_eq!(payload["models"][0]["slug"], "system.ai.gpt-5-6-sol");
    assert_eq!(payload["models"][0]["priority"], 1);
    assert_eq!(payload["models"][0]["shell_type"], "unified_exec");
    assert_eq!(
        payload["models"][0]["supported_reasoning_levels"],
        json!(["none", "low", "medium", "high", "xhigh", "max"])
    );
    assert!(payload["models"][0]["apply_patch_tool_type"].is_null());
    assert!(payload["models"][0]["web_search_tool_type"].is_null());
    assert_eq!(payload["models"][0]["input_modalities"], json!(["text"]));
    assert_eq!(payload["models"].as_array().unwrap().len(), 1);
}

#[test]
fn codex_listing_excludes_unsupported_model_families() {
    let endpoints = [
        endpoint("databricks-gpt-oss-120b", ModelClass::ChatBalanced),
        endpoint("databricks-qwen35-122b-a10b", ModelClass::ChatBalanced),
        endpoint("databricks-claude-sonnet-4-6", ModelClass::ChatBalanced),
        endpoint("databricks-gemini-3-5-flash", ModelClass::ChatFast),
        endpoint("databricks-inkling-1", ModelClass::ChatBalanced),
        endpoint("databricks-bge-large-en", ModelClass::Embedding),
        endpoint("databricks-gte-large-en", ModelClass::Embedding),
    ];

    let payload = models_payload(&endpoints, None, false, true);
    let slugs = payload["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| model["slug"].as_str().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(
        slugs,
        ["system.ai.gpt-oss-120b", "system.ai.qwen35-122b-a10b"]
    );
}

#[test]
fn codex_capabilities_follow_discovered_databricks_documentation() {
    let capabilities = parse_model_capabilities(
        r#"
        <html><body>
          <h3 id="databricks-hosted-foundation-models">Models</h3>
          <ul>
            <li><code>databricks-gpt-5-6-sol</code></li>
            <li><code>databricks-gpt-7-future</code></li>
          </ul>
          <h2 id="supported-input-types">Supported input types</h2>
          <p>OpenAI GPT models on Databricks accept text and image inputs.</p>
          <h2 id="limitations">Limitations</h2>
          <code>apply_patch</code>
        </body></html>
        "#,
        r#"
        <html><body>
          <h3 id="openai-models">OpenAI models</h3>
          <ul><li><code>databricks-gpt-7-future</code></li></ul>
        </body></html>
        "#,
    )
    .unwrap();
    let endpoints = [
        endpoint("databricks-gpt-5-6-sol", ModelClass::ChatBalanced),
        endpoint("databricks-gpt-7-future", ModelClass::ChatBalanced),
        endpoint("databricks-qwen35-122b-a10b", ModelClass::ChatBalanced),
    ];

    let payload =
        models_payload_with_capabilities(&endpoints, None, false, true, Some(&capabilities));
    let models = payload["models"].as_array().unwrap();

    assert_eq!(models[0]["input_modalities"], json!(["text", "image"]));
    assert_eq!(models[0]["apply_patch_tool_type"], "freeform");
    assert!(models[0]["web_search_tool_type"].is_null());
    assert_eq!(models[1]["input_modalities"], json!(["text", "image"]));
    assert_eq!(models[1]["apply_patch_tool_type"], "freeform");
    assert_eq!(models[1]["web_search_tool_type"], "text");
    assert_eq!(models[2]["input_modalities"], json!(["text"]));
    assert!(models[2]["apply_patch_tool_type"].is_null());
}

#[test]
fn lookup_can_include_deprecated_models() {
    let mut retired = endpoint("databricks-gemini-2-5-pro", ModelClass::ChatThinking);
    retired.status.deprecated = true;
    let endpoints = [
        endpoint("databricks-gemini-3-1-pro", ModelClass::ChatThinking),
        retired,
    ];

    let current = lookup_models(&endpoints, &ModelQuery::default());
    let including = lookup_models(
        &endpoints,
        &ModelQuery {
            include_deprecated: true,
            ..Default::default()
        },
    );

    assert_eq!(current.len(), 1);
    assert_eq!(including.len(), 2);
}

#[test]
fn retirement_parser_and_identity_matching_follow_python_behavior() {
    let names = parse_retired_models(RETIREMENT_HTML).unwrap();
    let retired = names.iter().cloned().collect();

    assert_eq!(names, ["DBRX", "DBRX Instruct", "Gemini 2.5 Pro"]);
    assert!(
        status_from_names(["custom-endpoint", "system.ai.gemini-2-5-pro"], &retired).deprecated
    );
    assert!(!status_from_names(["databricks-gemini-3-1-pro"], &retired).deprecated);
}

#[test]
fn discovery_extracts_profiles_and_classifies_models() {
    let response = json!({
        "endpoints": [{
            "name": "databricks-claude-sonnet-4-6",
            "task": "llm/v1/chat",
            "state": {"ready": "READY"},
            "description": "Balanced chat",
            "config": {
                "served_entities": [{
                    "entity_name": "databricks-claude-sonnet-4-6",
                    "foundation_model": {
                        "name": "system.ai.claude-sonnet-4-6",
                        "ai_gateway_model_profile": {"quality": 5, "speed": 4, "cost": 3}
                    }
                }]
            }
        }]
    });

    let endpoints = endpoints_from_response(&response).unwrap();

    assert_eq!(endpoints[0].profile.as_ref().unwrap().quality, Some(5.0));
    assert_eq!(endpoints[0].model_class, Some(ModelClass::ChatThinking));
    assert_eq!(
        endpoints[0]
            .service_names
            .get("anthropic")
            .map(String::as_str),
        Some("claude-sonnet-4-6")
    );
    assert_eq!(
        endpoints[0].model_service_name.as_deref(),
        Some("system.ai.claude-sonnet-4-6")
    );
}

#[tokio::test]
async fn client_discovers_resolves_and_caches_the_live_catalogue() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/2.0/serving-endpoints"))
        .and(header("authorization", "Bearer token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "endpoints": [
                {"name": "databricks-gpt-5-4", "task": "llm/v1/chat"},
                {"name": "databricks-gpt-5-6-luna", "task": "llm/v1/chat"},
                {
                    "name": "databricks-gpt-5-6-sol",
                    "task": "llm/v1/chat",
                    "config": {
                        "served_entities": [{
                            "entity_name": "databricks-gpt-5-6-sol",
                            "foundation_model": {"name": "system.ai.gpt-5-6-sol"}
                        }]
                    }
                },
                {
                    "name": "databricks-gemini-2-5-pro",
                    "task": "llm/v1/chat",
                    "config": {
                        "served_entities": [{
                            "foundation_model": {"name": "system.ai.gemini-2-5-pro"}
                        }]
                    }
                },
                {"name": "databricks-gte-large-en", "task": "llm/v1/embeddings"}
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/retired-models"))
        .respond_with(ResponseTemplate::new(200).set_body_string(RETIREMENT_HTML))
        .expect(1)
        .mount(&server)
        .await;
    let directory = tempfile::tempdir().unwrap();
    let status = ModelStatusResolver::with_cache_url(
        FileCache::new(
            directory.path().join("retired.json"),
            Duration::from_secs(60),
        ),
        format!("{}/retired-models", server.uri()),
    );
    let config_file = directory.path().join("databrickscfg");
    std::fs::write(
        &config_file,
        format!(
            "[DEFAULT]\nhost = {}\nauth_type = pat\ntoken = token\n",
            server.uri()
        ),
    )
    .unwrap();
    let databricks = DatabricksClient::with_options(DatabricksAuthOptions {
        profile: Some("DEFAULT".into()),
        config_file: Some(config_file.to_string_lossy().into_owned()),
        cache_dir: Some(directory.path().join("auth").to_string_lossy().into_owned()),
        prefer_user_to_machine: false,
        ..Default::default()
    })
    .await
    .unwrap();
    let client = ModelClient::with_cache_and_status(
        databricks,
        FileCache::new(
            directory.path().join("models.json"),
            Duration::from_secs(60),
        ),
        status,
    );

    assert_eq!(
        client.resolve_model("gpt").await.unwrap(),
        "databricks-gpt-5-6-sol"
    );
    assert_eq!(
        client.resolve_model("gpt").await.unwrap(),
        "databricks-gpt-5-6-sol"
    );
    assert_eq!(
        client
            .resolve_serving_endpoint("gpt")
            .await
            .unwrap()
            .unwrap()
            .model_service_name
            .as_deref(),
        Some("system.ai.gpt-5-6-sol")
    );
    assert_eq!(
        client
            .resolve_serving_endpoint_for_class("gte", ModelClass::Embedding)
            .await
            .unwrap()
            .unwrap()
            .name,
        "databricks-gte-large-en"
    );
    assert!(
        client
            .list_serving_endpoints(false)
            .await
            .unwrap()
            .iter()
            .find(|model| model.name == "databricks-gemini-2-5-pro")
            .unwrap()
            .status
            .deprecated
    );
}

#[tokio::test]
async fn retirement_refresh_failure_is_cached_with_the_generated_fallback() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/retired-models"))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&server)
        .await;
    let directory = tempfile::tempdir().unwrap();
    let status = ModelStatusResolver::with_cache_url(
        FileCache::new(
            directory.path().join("retired.json"),
            Duration::from_secs(60),
        ),
        format!("{}/retired-models", server.uri()),
    );

    let first = status.retired_model_names().await.unwrap();
    let second = status.retired_model_names().await.unwrap();

    assert!(first.contains("DBRX"));
    assert_eq!(first, second);
}

#[tokio::test]
async fn capability_refresh_failure_uses_the_embedded_snapshot() {
    let server = MockServer::start().await;
    for path_value in ["/responses", "/web-search"] {
        Mock::given(method("GET"))
            .and(path(path_value))
            .respond_with(ResponseTemplate::new(500))
            .expect(1)
            .mount(&server)
            .await;
    }
    let directory = tempfile::tempdir().unwrap();
    let resolver = ModelCapabilitiesResolver::with_cache_urls(
        FileCache::new(
            directory.path().join("capabilities.json"),
            Duration::from_secs(60),
        ),
        format!("{}/responses", server.uri()),
        format!("{}/web-search", server.uri()),
    );
    let capabilities = resolver.capabilities().await.unwrap();
    let endpoint = endpoint("databricks-gpt-5-4", ModelClass::ChatBalanced);

    assert!(capabilities.supports_responses(&endpoint));
    assert!(capabilities.supports_image_input(&endpoint));
    assert!(capabilities.supports_apply_patch(&endpoint));
    assert!(capabilities.supports_web_search(&endpoint));
}

fn endpoint(name: &str, model_class: ModelClass) -> ServingEndpointSummary {
    ServingEndpointSummary {
        name: name.to_owned(),
        display_name: None,
        task: Some("llm/v1/chat".to_owned()),
        state: None,
        description: None,
        supports_tools: None,
        profile: None,
        model_class: Some(model_class),
        service_names: BTreeMap::new(),
        model_service_name: None,
        reasoning_efforts: Vec::new(),
        status: ModelStatus::default(),
    }
}
