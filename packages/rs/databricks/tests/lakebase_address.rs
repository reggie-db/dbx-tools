use dbx_tools_databricks::{
    connection_url, parse_address, parse_lakebase_address, parse_resource_path, SslMode,
};

#[test]
fn parses_postgres_urls_hosts_and_projects_like_node() {
    let url = parse_address(Some(
        "postgresql://user%40example.com@endpoint.database.example.com:5433/app?sslmode=require"
            .to_owned(),
    ));
    assert_eq!(url.user.as_deref(), Some("user@example.com"));
    assert_eq!(url.host.as_deref(), Some("endpoint.database.example.com"));
    assert_eq!(url.port, Some(5433));
    assert_eq!(url.database.as_deref(), Some("app"));
    assert_eq!(url.ssl_mode, Some(SslMode::Require));
    assert_eq!(
        parse_address(Some("endpoint.database.example.com".to_owned()))
            .host
            .as_deref(),
        Some("endpoint.database.example.com")
    );
    assert_eq!(
        parse_address(Some("sample-project".to_owned()))
            .project
            .as_deref(),
        Some("sample-project")
    );
    assert_eq!(
        parse_address(Some("not a valid address".to_owned())),
        Default::default()
    );
}

#[test]
fn parses_canonical_lakebase_resource_paths() {
    let endpoint = parse_resource_path(Some(
        "projects/sample-project/branches/production/endpoints/primary".to_owned(),
    ));
    assert_eq!(endpoint.project.as_deref(), Some("sample-project"));
    assert_eq!(endpoint.branch.as_deref(), Some("production"));
    assert_eq!(endpoint.endpoint_id.as_deref(), Some("primary"));
    assert_eq!(
        endpoint.endpoint.as_deref(),
        Some("projects/sample-project/branches/production/endpoints/primary")
    );
    let endpoint_url = parse_address(Some(
        "postgresql://profile@localhost:5432/projects/sample-project/branches/production/endpoints/primary?sslmode=disable".to_owned(),
    ));
    assert_eq!(endpoint_url.project.as_deref(), Some("sample-project"));
    assert_eq!(endpoint_url.branch.as_deref(), Some("production"));
    assert_eq!(endpoint_url.endpoint_id.as_deref(), Some("primary"));
    assert_eq!(endpoint_url.user.as_deref(), Some("profile"));

    let database = parse_resource_path(Some(
        "projects/sample-project/branches/production/databases/application".to_owned(),
    ));
    assert_eq!(
        database.database_resource_id.as_deref(),
        Some("application")
    );
    assert_eq!(
        parse_resource_path(Some("projects/sample-project/branches".to_owned())),
        Default::default()
    );
}

#[test]
fn formats_local_urls_with_the_original_resource_path() {
    let target = "projects/sample-project/branches/production/endpoints/primary";
    assert_eq!(
        connection_url(target, "localhost", 5432).unwrap(),
        "postgresql://localhost:5432/projects/sample-project/branches/production/endpoints/primary?sslmode=disable"
    );
    assert!(parse_lakebase_address("not a valid address").is_err());
}
