//! Databricks Lakebase resource discovery and selection.

use std::time::Duration;

use dbx_tools_core::{DatabricksClient as WorkspaceClient, ParsedAddress};
use mini_moka::sync::Cache;
use serde_json::Value;

use super::{session::DatabricksSessionCache, DatabricksError};

const API_BASE: &str = "/api/2.0/postgres";
const DEFAULT_DATABASE: &str = "databricks_postgres";
const DEFAULT_PROFILE_KEY: &str = "<default>";
const DISCOVERY_TTL: Duration = Duration::from_secs(30);
const READ_WRITE_ENDPOINT: &str = "READ_WRITE";
const READ_WRITE_ENDPOINT_TYPE: &str = "ENDPOINT_TYPE_READ_WRITE";

#[derive(Clone)]
pub(super) struct LakebaseDiscoveryCache {
    resolved: Cache<(String, String), ResolvedLakebase>,
}

impl LakebaseDiscoveryCache {
    pub(super) fn new() -> Self {
        Self {
            resolved: Cache::builder()
                .max_capacity(256)
                .time_to_live(DISCOVERY_TTL)
                .build(),
        }
    }

    pub(super) async fn resolve(
        &self,
        sessions: &DatabricksSessionCache,
        startup_user: Option<&str>,
        target: &ParsedAddress,
    ) -> Result<ResolvedLakebase, DatabricksError> {
        let profile = sessions.resolve_profile(startup_user)?;
        let key = (
            profile
                .clone()
                .unwrap_or_else(|| DEFAULT_PROFILE_KEY.to_owned()),
            format!("{target:?}"),
        );
        if let Some(cached) = self.resolved.get(&key) {
            return Ok(cached);
        }
        let resolved = resolve_lakebase_resources(sessions, profile.as_deref(), target).await?;
        self.resolved.insert(key, resolved.clone());
        Ok(resolved)
    }
}

/// Concrete Lakebase resources and Postgres connection parameters.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedLakebase {
    /// Writable Lakebase endpoint hostname.
    pub host: String,
    /// PostgreSQL server port.
    pub port: u16,
    /// PostgreSQL database name.
    pub database: String,
    /// Databricks user name used for PostgreSQL authentication.
    pub user: String,
    /// Canonical Lakebase endpoint resource path.
    pub endpoint: String,
    /// Lakebase project identifier.
    pub project: String,
    /// Lakebase branch identifier.
    pub branch: String,
}

async fn resolve_lakebase_resources(
    sessions: &DatabricksSessionCache,
    profile: Option<&str>,
    target: &ParsedAddress,
) -> Result<ResolvedLakebase, DatabricksError> {
    let session = sessions.get(profile).await?;
    let mut project = target.project.clone();
    let mut branch = target.branch.clone();
    let mut endpoint_id = target.endpoint_id.clone();
    if project.is_none() {
        if let Some(host) = target.host.as_deref() {
            if let Some(found) = find_postgres_endpoint_by_host(&session, host).await? {
                project = Some(found.0);
                branch = Some(found.1);
                endpoint_id = Some(found.2);
            }
        }
    }
    if project.is_none() {
        project = Some(select_project(&list_projects(&session).await?)?);
    }
    let project_id = project
        .as_deref()
        .ok_or_else(|| DatabricksError::Discovery("could not resolve a Lakebase project".into()))?;
    let project_path = format!("{API_BASE}/projects/{project_id}");
    let project = session.request(&project_path, None, None).await?;
    let branch = select_branch(
        &project,
        &list_branches(&session, &project_path).await?,
        branch.as_deref(),
    )?;
    let branch_id = postgres_resource_id(&branch, "branches")
        .ok_or_else(|| DatabricksError::InvalidResponse("branch has no resource name".into()))?;
    let branch_path = format!("{project_path}/branches/{branch_id}");

    let endpoint = select_endpoint(
        &list_endpoints(&session, &branch_path).await?,
        endpoint_id.as_deref(),
        target.host.as_deref(),
    )?;
    let endpoint_id = postgres_resource_id(&endpoint, "endpoints")
        .ok_or_else(|| DatabricksError::InvalidResponse("endpoint has no resource name".into()))?;
    let endpoint_path =
        format!("projects/{project_id}/branches/{branch_id}/endpoints/{endpoint_id}");
    let host = endpoint
        .pointer("/status/hosts/host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            DatabricksError::InvalidResponse(format!("endpoint {endpoint_id} has no writable host"))
        })?
        .to_owned();
    let port = endpoint
        .pointer("/status/hosts/port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .unwrap_or(5432);

    let database = select_database(
        &list_databases(&session, &branch_path).await?,
        target
            .database_resource_id
            .as_deref()
            .or(target.database.as_deref()),
    )?;
    let user = session
        .request("/api/2.0/preview/scim/v2/Me", None, None)
        .await?
        .get("userName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DatabricksError::InvalidResponse("current user has no userName".into()))?
        .to_owned();

    Ok(ResolvedLakebase {
        host,
        port,
        database,
        user,
        endpoint: endpoint_path,
        project: project_id.to_owned(),
        branch: branch_id,
    })
}

async fn list_projects(client: &WorkspaceClient) -> Result<Vec<Value>, DatabricksError> {
    list_postgres_resources(client, &format!("{API_BASE}/projects"), "projects").await
}

async fn list_branches(
    client: &WorkspaceClient,
    project_path: &str,
) -> Result<Vec<Value>, DatabricksError> {
    list_postgres_resources(client, &format!("{project_path}/branches"), "branches").await
}

async fn list_endpoints(
    client: &WorkspaceClient,
    branch_path: &str,
) -> Result<Vec<Value>, DatabricksError> {
    list_postgres_resources(client, &format!("{branch_path}/endpoints"), "endpoints").await
}

async fn list_databases(
    client: &WorkspaceClient,
    branch_path: &str,
) -> Result<Vec<Value>, DatabricksError> {
    list_postgres_resources(client, &format!("{branch_path}/databases"), "databases").await
}

async fn list_postgres_resources(
    client: &WorkspaceClient,
    path: &str,
    response_key: &str,
) -> Result<Vec<Value>, DatabricksError> {
    let mut resources = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let page_path = match page_token.as_deref() {
            Some(token) => format!(
                "{path}?page_token={}",
                url::form_urlencoded::byte_serialize(token.as_bytes()).collect::<String>()
            ),
            None => path.to_owned(),
        };
        let response = client
            .request(&page_path, None, None)
            .await
            .map_err(DatabricksError::Client)?;
        resources.extend(
            response
                .get(response_key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        page_token = response
            .get("next_page_token")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|token| !token.is_empty());
        if page_token.is_none() {
            return Ok(resources);
        }
    }
}

fn select_project(projects: &[Value]) -> Result<String, DatabricksError> {
    let usable = projects
        .iter()
        .filter(|project| is_usable_postgres_resource(project))
        .filter_map(|project| postgres_resource_id(project, "projects"))
        .collect::<Vec<_>>();
    if usable.len() == 1 {
        Ok(usable[0].clone())
    } else {
        Err(DatabricksError::Discovery(format!(
            "could not choose project; candidates: {}",
            if usable.is_empty() {
                "none".to_owned()
            } else {
                usable.join(", ")
            }
        )))
    }
}

fn select_branch(
    project: &Value,
    branches: &[Value],
    explicit: Option<&str>,
) -> Result<Value, DatabricksError> {
    let usable = branches
        .iter()
        .filter(|branch| is_usable_postgres_resource(branch))
        .cloned()
        .collect::<Vec<_>>();
    if let Some(explicit) = explicit {
        return select_named_postgres_resource(usable, "branches", explicit, "branch");
    }
    if usable.len() == 1 {
        return Ok(usable[0].clone());
    }
    if let Some(default) = project
        .pointer("/status/default_branch")
        .and_then(Value::as_str)
        .and_then(|value| {
            postgres_resource_path_id(value, "branches").or_else(|| Some(value.to_owned()))
        })
    {
        if let Ok(branch) =
            select_named_postgres_resource(usable.clone(), "branches", &default, "branch")
        {
            return Ok(branch);
        }
    }
    let defaults = usable
        .iter()
        .filter(|branch| branch.pointer("/status/default").and_then(Value::as_bool) == Some(true))
        .cloned()
        .collect::<Vec<_>>();
    if defaults.len() == 1 {
        return Ok(defaults[0].clone());
    }
    Err(ambiguous_postgres_resource("branch", &usable, "branches"))
}

fn select_endpoint(
    endpoints: &[Value],
    explicit: Option<&str>,
    host: Option<&str>,
) -> Result<Value, DatabricksError> {
    let usable = endpoints
        .iter()
        .filter(|endpoint| {
            is_usable_postgres_resource(endpoint)
                && endpoint
                    .pointer("/status/disabled")
                    .and_then(Value::as_bool)
                    != Some(true)
                && endpoint
                    .pointer("/status/endpoint_type")
                    .and_then(Value::as_str)
                    .is_some_and(|value| {
                        value.eq_ignore_ascii_case(READ_WRITE_ENDPOINT)
                            || value.eq_ignore_ascii_case(READ_WRITE_ENDPOINT_TYPE)
                    })
        })
        .cloned()
        .collect::<Vec<_>>();
    if let Some(explicit) = explicit {
        return select_named_postgres_resource(usable, "endpoints", explicit, "endpoint");
    }
    if let Some(host) = host {
        let matches = usable
            .iter()
            .filter(|endpoint| postgres_endpoint_hosts(endpoint).any(|candidate| candidate == host))
            .cloned()
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            return Ok(matches[0].clone());
        }
    }
    if usable.len() == 1 {
        Ok(usable[0].clone())
    } else {
        Err(ambiguous_postgres_resource(
            "endpoint",
            &usable,
            "endpoints",
        ))
    }
}

async fn find_postgres_endpoint_by_host(
    session: &WorkspaceClient,
    host: &str,
) -> Result<Option<(String, String, String)>, DatabricksError> {
    for project in list_projects(session).await? {
        let Some(project_id) = postgres_resource_id(&project, "projects") else {
            continue;
        };
        let project_path = format!("{API_BASE}/projects/{project_id}");
        for branch in list_branches(session, &project_path)
            .await?
            .into_iter()
            .filter(is_usable_postgres_resource)
        {
            let Some(branch_id) = postgres_resource_id(&branch, "branches") else {
                continue;
            };
            let branch_path = format!("{project_path}/branches/{branch_id}");
            for endpoint in list_endpoints(session, &branch_path).await? {
                if postgres_endpoint_hosts(&endpoint).any(|candidate| candidate == host) {
                    if let Some(endpoint_id) = postgres_resource_id(&endpoint, "endpoints") {
                        return Ok(Some((project_id, branch_id, endpoint_id)));
                    }
                }
            }
        }
    }
    Ok(None)
}

fn postgres_endpoint_hosts(endpoint: &Value) -> impl Iterator<Item = &str> {
    ["host", "read_write_pooled_host", "read_only_host"]
        .into_iter()
        .filter_map(|name| {
            endpoint
                .pointer(&format!("/status/hosts/{name}"))
                .and_then(Value::as_str)
        })
}

fn select_database(databases: &[Value], explicit: Option<&str>) -> Result<String, DatabricksError> {
    if let Some(explicit) = explicit {
        let matches = databases
            .iter()
            .filter(|database| {
                postgres_resource_id(database, "databases").as_deref() == Some(explicit)
                    || database
                        .pointer("/status/postgres_database")
                        .and_then(Value::as_str)
                        == Some(explicit)
            })
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            return postgres_database_name(matches[0]);
        }
        return Err(ambiguous_postgres_resource(
            "database",
            databases,
            "databases",
        ));
    }
    if databases.iter().any(|database| {
        database
            .pointer("/status/postgres_database")
            .and_then(Value::as_str)
            == Some(DEFAULT_DATABASE)
    }) {
        return Ok(DEFAULT_DATABASE.to_owned());
    }
    if databases.len() == 1 {
        return postgres_database_name(&databases[0]);
    }
    Err(ambiguous_postgres_resource(
        "database",
        databases,
        "databases",
    ))
}

fn select_named_postgres_resource(
    resources: Vec<Value>,
    kind: &str,
    explicit: &str,
    label: &str,
) -> Result<Value, DatabricksError> {
    let matches = resources
        .iter()
        .filter(|resource| postgres_resource_id(resource, kind).as_deref() == Some(explicit))
        .cloned()
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        Ok(matches[0].clone())
    } else {
        Err(ambiguous_postgres_resource(label, &resources, kind))
    }
}

fn postgres_database_name(value: &Value) -> Result<String, DatabricksError> {
    value
        .pointer("/status/postgres_database")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| DatabricksError::InvalidResponse("database has no postgres name".into()))
}

fn is_usable_postgres_resource(value: &Value) -> bool {
    !value
        .pointer("/status/current_state")
        .and_then(Value::as_str)
        .is_some_and(|state| {
            matches!(
                state.to_ascii_uppercase().as_str(),
                "ARCHIVED" | "DELETED" | "DELETING" | "DISABLED"
            )
        })
}

fn postgres_resource_id(value: &Value, kind: &str) -> Option<String> {
    value
        .get("name")
        .and_then(Value::as_str)
        .and_then(|name| postgres_resource_path_id(name, kind))
}

fn postgres_resource_path_id(name: &str, kind: &str) -> Option<String> {
    let parts = name.split('/').collect::<Vec<_>>();
    parts
        .windows(2)
        .find(|pair| pair[0] == kind)
        .map(|pair| pair[1].to_owned())
}

fn ambiguous_postgres_resource(label: &str, resources: &[Value], kind: &str) -> DatabricksError {
    let candidates = resources
        .iter()
        .filter_map(|resource| postgres_resource_id(resource, kind))
        .collect::<Vec<_>>();
    DatabricksError::Discovery(format!(
        "could not choose {label}; candidates: {}",
        if candidates.is_empty() {
            "none".to_owned()
        } else {
            candidates.join(", ")
        }
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{postgres_resource_id, select_branch, select_database, select_endpoint};

    #[test]
    fn branch_selection_ignores_archived_and_uses_project_default() {
        let project = json!({
            "status": {"default_branch": "projects/project/branches/production"}
        });
        let branches = vec![
            json!({
                "name": "projects/project/branches/archived",
                "status": {"current_state": "ARCHIVED", "default": true}
            }),
            json!({
                "name": "projects/project/branches/production",
                "status": {"current_state": "READY"}
            }),
            json!({
                "name": "projects/project/branches/development",
                "status": {"current_state": "READY"}
            }),
        ];

        assert_eq!(
            postgres_resource_id(
                &select_branch(&project, &branches, None).unwrap(),
                "branches"
            )
            .as_deref(),
            Some("production")
        );
    }

    #[test]
    fn branch_selection_uses_unique_status_default_after_project_default() {
        let branches = vec![
            json!({
                "name": "projects/project/branches/one",
                "status": {"current_state": "READY"}
            }),
            json!({
                "name": "projects/project/branches/two",
                "status": {"current_state": "READY", "default": true}
            }),
        ];

        assert_eq!(
            postgres_resource_id(
                &select_branch(&json!({}), &branches, None).unwrap(),
                "branches"
            )
            .as_deref(),
            Some("two")
        );
    }

    #[test]
    fn endpoint_selection_requires_one_enabled_read_write_endpoint() {
        let endpoints = vec![
            json!({
                "name": "projects/project/branches/branch/endpoints/read-only",
                "status": {"current_state": "READY", "endpoint_type": "READ_ONLY"}
            }),
            json!({
                "name": "projects/project/branches/branch/endpoints/disabled",
                "status": {"current_state": "DISABLED", "endpoint_type": "READ_WRITE"}
            }),
            json!({
                "name": "projects/project/branches/branch/endpoints/primary",
                "status": {"current_state": "READY", "endpoint_type": "READ_WRITE"}
            }),
        ];

        assert_eq!(
            postgres_resource_id(
                &select_endpoint(&endpoints, None, None).unwrap(),
                "endpoints"
            )
            .as_deref(),
            Some("primary")
        );
        assert!(select_endpoint(&endpoints, Some("disabled"), None).is_err());
    }

    #[test]
    fn database_selection_matches_resource_or_postgres_name() {
        let databases = vec![
            json!({
                "name": "projects/project/branches/branch/databases/application",
                "status": {"postgres_database": "application_db"}
            }),
            json!({
                "name": "projects/project/branches/branch/databases/databricks-postgres",
                "status": {"postgres_database": "databricks_postgres"}
            }),
        ];

        assert_eq!(
            select_database(&databases, Some("application")).unwrap(),
            "application_db"
        );
        assert_eq!(
            select_database(&databases, Some("application_db")).unwrap(),
            "application_db"
        );
        assert_eq!(
            select_database(&databases, None).unwrap(),
            "databricks_postgres"
        );
        assert!(select_database(&databases, Some("missing")).is_err());
    }
}
