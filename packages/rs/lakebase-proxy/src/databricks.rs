//! Databricks Lakebase discovery and per-connection credentials.

use std::{path::Path, sync::Arc, time::Duration};

use dbx_tools_databricks::{
    config_profile_exists, is_databricks_app, DatabricksAuthOptions,
    DatabricksClient as WorkspaceClient, DatabricksClientError, ParsedAddress,
};
use mini_moka::sync::Cache;
use serde_json::{json, Value};

const API_BASE: &str = "/api/2.0/postgres";
const DEFAULT_DATABASE: &str = "databricks_postgres";
const READ_WRITE_ENDPOINT: &str = "READ_WRITE";
const READ_WRITE_ENDPOINT_TYPE: &str = "ENDPOINT_TYPE_READ_WRITE";
const DISCOVERY_TTL: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct LakebaseClient {
    auth_options: DatabricksAuthOptions,
    sessions: Cache<String, Arc<WorkspaceClient>>,
    discovery: Cache<(String, String), ResolvedLakebase>,
}

impl LakebaseClient {
    pub fn new() -> Self {
        Self {
            auth_options: DatabricksAuthOptions::default(),
            sessions: session_cache(),
            discovery: discovery_cache(),
        }
    }

    pub fn with_auth_options(auth_options: DatabricksAuthOptions) -> Self {
        Self {
            auth_options,
            sessions: session_cache(),
            discovery: discovery_cache(),
        }
    }

    pub async fn discover(
        &self,
        profile: Option<&str>,
        target: &ParsedAddress,
    ) -> Result<ResolvedLakebase, DatabricksError> {
        let profile = self.profile_override(profile)?;
        let key = (
            profile.clone().unwrap_or_else(|| "<default>".into()),
            format!("{target:?}"),
        );
        if let Some(cached) = self.discovery.get(&key) {
            return Ok(cached);
        }
        let value = self.discover_uncached(profile.as_deref(), target).await?;
        self.discovery.insert(key, value.clone());
        Ok(value)
    }

    async fn discover_uncached(
        &self,
        profile: Option<&str>,
        target: &ParsedAddress,
    ) -> Result<ResolvedLakebase, DatabricksError> {
        let session = self.session(profile).await?;
        let mut project = target.project.clone();
        let mut branch = target.branch.clone();
        let mut endpoint_id = target.endpoint_id.clone();
        if project.is_none() {
            if let Some(host) = target.host.as_deref() {
                if let Some(found) = find_endpoint_by_host(&session, host).await? {
                    project = Some(found.0);
                    branch = Some(found.1);
                    endpoint_id = Some(found.2);
                }
            }
        }
        if project.is_none() {
            let projects = list(&session, &format!("{API_BASE}/projects"), "projects").await?;
            project = Some(select_project(&projects)?);
        }
        let project_id = project.as_deref().ok_or_else(|| {
            DatabricksError::Discovery("could not resolve a Lakebase project".into())
        })?;
        let project_path = format!("{API_BASE}/projects/{project_id}");
        let project = session.get(&project_path).await?;
        let branches = list(&session, &format!("{project_path}/branches"), "branches").await?;
        let branch = select_branch(&project, &branches, branch.as_deref())?;
        let branch_id = resource_part(&branch, "branches").ok_or_else(|| {
            DatabricksError::InvalidResponse("branch has no resource name".into())
        })?;
        let branch_path = format!("{project_path}/branches/{branch_id}");

        let endpoints = list(&session, &format!("{branch_path}/endpoints"), "endpoints").await?;
        let endpoint = select_endpoint(&endpoints, endpoint_id.as_deref(), target.host.as_deref())?;
        let endpoint_id = resource_part(&endpoint, "endpoints").ok_or_else(|| {
            DatabricksError::InvalidResponse("endpoint has no resource name".into())
        })?;
        let endpoint_path =
            format!("projects/{project_id}/branches/{branch_id}/endpoints/{endpoint_id}");
        let host = endpoint
            .pointer("/status/hosts/host")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                DatabricksError::InvalidResponse(format!(
                    "endpoint {endpoint_id} has no writable host"
                ))
            })?
            .to_owned();
        let port = endpoint
            .pointer("/status/hosts/port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .unwrap_or(5432);

        let databases = list(&session, &format!("{branch_path}/databases"), "databases").await?;
        let database = select_database(
            &databases,
            target
                .database_resource_id
                .as_deref()
                .or(target.database.as_deref()),
        )?;
        let user = session
            .get("/api/2.0/preview/scim/v2/Me")
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

    pub async fn credential(
        &self,
        profile: Option<&str>,
        endpoint: &str,
    ) -> Result<String, DatabricksError> {
        let profile = self.profile_override(profile)?;
        let session = self.session(profile.as_deref()).await?;
        let response = session
            .post(
                &format!("{API_BASE}/credentials"),
                json!({
                    "endpoint": endpoint,
                }),
            )
            .await?;
        response
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                DatabricksError::InvalidResponse("credential response did not contain token".into())
            })
    }

    async fn session(
        &self,
        profile: Option<&str>,
    ) -> Result<Arc<WorkspaceClient>, DatabricksError> {
        let key = profile.unwrap_or("<default>").to_owned();
        if let Some(session) = self.sessions.get(&key) {
            return Ok(session);
        }
        let mut options = self.auth_options.clone();
        options.profile = profile.map(str::to_owned);
        let session = Arc::new(
            WorkspaceClient::with_options(options)
                .await
                .map_err(DatabricksError::Client)?,
        );
        self.sessions.insert(key, Arc::clone(&session));
        Ok(session)
    }

    fn profile_override(&self, candidate: Option<&str>) -> Result<Option<String>, DatabricksError> {
        if self.auth_options.profile.is_some() {
            return Ok(self.auth_options.profile.clone());
        }
        if is_databricks_app() {
            return Ok(None);
        }
        let Some(candidate) = candidate
            .map(str::trim)
            .filter(|candidate| !candidate.is_empty())
        else {
            return Ok(None);
        };
        let config_file = self.auth_options.config_file.as_deref().map(Path::new);
        config_profile_exists(candidate, config_file)
            .map(|exists| {
                tracing::debug!(
                    startup_user = candidate,
                    configured_profile = exists,
                    "resolved startup user profile"
                );
                exists.then(|| candidate.to_owned())
            })
            .map_err(|error| {
                DatabricksError::Client(DatabricksClientError::Authentication(error.to_string()))
            })
    }
}

impl Default for LakebaseClient {
    fn default() -> Self {
        Self::new()
    }
}

fn session_cache() -> Cache<String, Arc<WorkspaceClient>> {
    Cache::builder()
        .max_capacity(32)
        .time_to_live(Duration::from_secs(10 * 60))
        .build()
}

fn discovery_cache() -> Cache<(String, String), ResolvedLakebase> {
    Cache::builder()
        .max_capacity(256)
        .time_to_live(DISCOVERY_TTL)
        .build()
}

async fn list(
    client: &WorkspaceClient,
    path: &str,
    key: &str,
) -> Result<Vec<Value>, DatabricksError> {
    let mut values = Vec::new();
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
            .get(&page_path)
            .await
            .map_err(DatabricksError::Client)?;
        values.extend(
            response
                .get(key)
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
            return Ok(values);
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedLakebase {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub endpoint: String,
    pub project: String,
    pub branch: String,
}

fn select_project(projects: &[Value]) -> Result<String, DatabricksError> {
    let usable = projects
        .iter()
        .filter(|project| usable_state(project))
        .filter_map(|project| resource_part(project, "projects"))
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
        .filter(|branch| usable_state(branch))
        .cloned()
        .collect::<Vec<_>>();
    if let Some(explicit) = explicit {
        return unique_named(usable, "branches", explicit, "branch");
    }
    if usable.len() == 1 {
        return Ok(usable[0].clone());
    }
    if let Some(default) = project
        .pointer("/status/default_branch")
        .and_then(Value::as_str)
        .and_then(|value| resource_value(value, "branches").or_else(|| Some(value.to_owned())))
    {
        if let Ok(branch) = unique_named(usable.clone(), "branches", &default, "branch") {
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
    Err(ambiguous("branch", &usable, "branches"))
}

fn select_endpoint(
    endpoints: &[Value],
    explicit: Option<&str>,
    host: Option<&str>,
) -> Result<Value, DatabricksError> {
    let usable = endpoints
        .iter()
        .filter(|endpoint| {
            usable_state(endpoint)
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
        return unique_named(usable, "endpoints", explicit, "endpoint");
    }
    if let Some(host) = host {
        let matches = usable
            .iter()
            .filter(|endpoint| endpoint_hosts(endpoint).any(|candidate| candidate == host))
            .cloned()
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            return Ok(matches[0].clone());
        }
    }
    if usable.len() == 1 {
        Ok(usable[0].clone())
    } else {
        Err(ambiguous("endpoint", &usable, "endpoints"))
    }
}

async fn find_endpoint_by_host(
    session: &WorkspaceClient,
    host: &str,
) -> Result<Option<(String, String, String)>, DatabricksError> {
    for project in list(session, &format!("{API_BASE}/projects"), "projects").await? {
        let Some(project_id) = resource_part(&project, "projects") else {
            continue;
        };
        for branch in list(
            session,
            &format!("{API_BASE}/projects/{project_id}/branches"),
            "branches",
        )
        .await?
        .into_iter()
        .filter(usable_state)
        {
            let Some(branch_id) = resource_part(&branch, "branches") else {
                continue;
            };
            for endpoint in list(
                session,
                &format!("{API_BASE}/projects/{project_id}/branches/{branch_id}/endpoints"),
                "endpoints",
            )
            .await?
            {
                if endpoint_hosts(&endpoint).any(|candidate| candidate == host) {
                    if let Some(endpoint_id) = resource_part(&endpoint, "endpoints") {
                        return Ok(Some((project_id, branch_id, endpoint_id)));
                    }
                }
            }
        }
    }
    Ok(None)
}

fn endpoint_hosts(endpoint: &Value) -> impl Iterator<Item = &str> {
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
                resource_part(database, "databases").as_deref() == Some(explicit)
                    || database
                        .pointer("/status/postgres_database")
                        .and_then(Value::as_str)
                        == Some(explicit)
            })
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            return postgres_database(matches[0]);
        }
        return Err(ambiguous("database", databases, "databases"));
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
        return postgres_database(&databases[0]);
    }
    Err(ambiguous("database", databases, "databases"))
}

fn unique_named(
    values: Vec<Value>,
    kind: &str,
    explicit: &str,
    label: &str,
) -> Result<Value, DatabricksError> {
    let matches = values
        .iter()
        .filter(|value| resource_part(value, kind).as_deref() == Some(explicit))
        .cloned()
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        Ok(matches[0].clone())
    } else {
        Err(ambiguous(label, &values, kind))
    }
}

fn postgres_database(value: &Value) -> Result<String, DatabricksError> {
    value
        .pointer("/status/postgres_database")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| DatabricksError::InvalidResponse("database has no postgres name".into()))
}

fn usable_state(value: &Value) -> bool {
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

fn resource_part(value: &Value, kind: &str) -> Option<String> {
    value
        .get("name")
        .and_then(Value::as_str)
        .and_then(|name| resource_value(name, kind))
}

fn resource_value(name: &str, kind: &str) -> Option<String> {
    let parts = name.split('/').collect::<Vec<_>>();
    parts
        .windows(2)
        .find(|pair| pair[0] == kind)
        .map(|pair| pair[1].to_owned())
}

fn ambiguous(label: &str, values: &[Value], kind: &str) -> DatabricksError {
    let candidates = values
        .iter()
        .filter_map(|value| resource_part(value, kind))
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

#[derive(Debug, thiserror::Error)]
pub enum DatabricksError {
    #[error(transparent)]
    Client(#[from] DatabricksClientError),
    #[error("Databricks discovery failed: {0}")]
    Discovery(String),
    #[error("Databricks API response is invalid: {0}")]
    InvalidResponse(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_user_only_overrides_auth_when_it_is_a_configured_profile() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("databrickscfg");
        std::fs::write(
            &config,
            "[DEFAULT]\nhost = https://workspace.example\nauth_type = databricks-cli\n",
        )
        .unwrap();
        let client = LakebaseClient::with_auth_options(DatabricksAuthOptions {
            config_file: Some(config.to_string_lossy().into_owned()),
            ..Default::default()
        });

        assert_eq!(
            client.profile_override(Some("DEFAULT")).unwrap().as_deref(),
            Some("DEFAULT")
        );
        assert_eq!(client.profile_override(Some("os-user")).unwrap(), None);
        assert_eq!(client.profile_override(None).unwrap(), None);
    }

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
            resource_part(
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
            resource_part(
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
            resource_part(
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
