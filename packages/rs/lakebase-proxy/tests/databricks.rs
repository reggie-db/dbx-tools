use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use dbx_tools_core::{parse_lakebase_address, DatabricksAuthOptions};
use dbx_tools_lakebase_proxy::databricks::LakebaseClient;
use wiremock::{
    matchers::{method, path, query_param},
    Match, Mock, MockServer, Request, Respond, ResponseTemplate,
};

#[tokio::test]
async fn discovers_paginated_resources_and_refreshes_one_unauthorized_credential() {
    let server = MockServer::start().await;
    let project_path = "/api/2.0/postgres/projects/project";
    Mock::given(method("GET"))
        .and(path(project_path))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "projects/project",
            "status": {"default_branch": "projects/project/branches/production"}
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{project_path}/branches")))
        .and(MissingPageToken)
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "branches": [{
                "name": "projects/project/branches/archived",
                "status": {"current_state": "ARCHIVED"}
            }],
            "next_page_token": "second page"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{project_path}/branches")))
        .and(query_param("page_token", "second page"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "branches": [{
                "name": "projects/project/branches/production",
                "status": {"default": true, "current_state": "READY"}
            }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "{project_path}/branches/production/endpoints"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "endpoints": [
                {
                    "name": "projects/project/branches/production/endpoints/disabled",
                    "status": {"endpoint_type": "READ_WRITE", "current_state": "DISABLED"}
                },
                {
                    "name": "projects/project/branches/production/endpoints/primary",
                    "status": {
                        "endpoint_type": "READ_WRITE",
                        "current_state": "READY",
                        "hosts": {"host": "primary.example.com"}
                    }
                }
            ]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "{project_path}/branches/production/databases"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "databases": [{
                "name": "projects/project/branches/production/databases/databricks-postgres",
                "status": {"postgres_database": "databricks_postgres"}
            }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/2.0/preview/scim/v2/Me"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "userName": "user@example.com"
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/2.0/postgres/credentials"))
        .respond_with(UnauthorizedOnce::default())
        .expect(3)
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("databrickscfg");
    std::fs::write(
        &config,
        format!(
            "[PROFILE]\nhost = {}\nauth_type = pat\ntoken = profile-token\n",
            server.uri()
        ),
    )
    .unwrap();
    let client = LakebaseClient::with_auth_options(DatabricksAuthOptions {
        config_file: Some(config.to_string_lossy().into_owned()),
        ..Default::default()
    });
    let resolved = client
        .resolve_lakebase(Some("PROFILE"), &parse_lakebase_address("project").unwrap())
        .await
        .unwrap();

    assert_eq!(resolved.host, "primary.example.com");
    assert_eq!(resolved.database, "databricks_postgres");
    assert_eq!(resolved.user, "user@example.com");
    assert_eq!(
        client
            .generate_database_credential(Some("PROFILE"), &resolved.endpoint)
            .await
            .unwrap(),
        "database-token"
    );
    assert_eq!(
        client
            .generate_database_credential(Some("PROFILE"), &resolved.endpoint)
            .await
            .unwrap(),
        "database-token"
    );
    let credential_requests = server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|request| request.url.path() == "/api/2.0/postgres/credentials")
        .collect::<Vec<_>>();
    assert_eq!(credential_requests.len(), 3);
    for request in credential_requests {
        assert_eq!(
            request
                .headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer profile-token")
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
            serde_json::json!({
                "endpoint": "projects/project/branches/production/endpoints/primary"
            })
        );
    }
}

struct MissingPageToken;

impl Match for MissingPageToken {
    fn matches(&self, request: &Request) -> bool {
        !request
            .url
            .query_pairs()
            .any(|(name, _)| name == "page_token")
    }
}

#[derive(Clone, Default)]
struct UnauthorizedOnce {
    requests: Arc<AtomicUsize>,
}

impl Respond for UnauthorizedOnce {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        if self.requests.fetch_add(1, Ordering::SeqCst) == 0 {
            ResponseTemplate::new(401)
        } else {
            ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "token": "database-token"
            }))
        }
    }
}
