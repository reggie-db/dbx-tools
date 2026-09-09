//! Databricks authentication selection and session caching.

use std::{path::Path, sync::Arc, time::Duration};

use dbx_tools_databricks::{
    config_profile_exists, is_databricks_app, DatabricksAuthOptions,
    DatabricksClient as WorkspaceClient, DatabricksClientError,
};
use mini_moka::sync::Cache;

use super::DatabricksError;

const DEFAULT_SESSION_KEY: &str = "<default>";
const SESSION_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
pub(super) struct DatabricksSessionCache {
    auth_options: DatabricksAuthOptions,
    sessions: Cache<String, Arc<WorkspaceClient>>,
}

impl DatabricksSessionCache {
    pub(super) fn new(auth_options: DatabricksAuthOptions) -> Self {
        Self {
            auth_options,
            sessions: Cache::builder()
                .max_capacity(32)
                .time_to_live(SESSION_TTL)
                .build(),
        }
    }

    pub(super) async fn get(
        &self,
        profile: Option<&str>,
    ) -> Result<Arc<WorkspaceClient>, DatabricksError> {
        let key = profile.unwrap_or(DEFAULT_SESSION_KEY).to_owned();
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

    pub(super) fn resolve_profile(
        &self,
        startup_user: Option<&str>,
    ) -> Result<Option<String>, DatabricksError> {
        if self.auth_options.profile.is_some() {
            return Ok(self.auth_options.profile.clone());
        }
        if is_databricks_app() {
            return Ok(None);
        }
        let Some(startup_user) = startup_user
            .map(str::trim)
            .filter(|startup_user| !startup_user.is_empty())
        else {
            return Ok(None);
        };
        let config_file = self.auth_options.config_file.as_deref().map(Path::new);
        config_profile_exists(startup_user, config_file)
            .map(|exists| {
                tracing::debug!(
                    startup_user,
                    configured_profile = exists,
                    "resolved startup user profile"
                );
                exists.then(|| startup_user.to_owned())
            })
            .map_err(|error| {
                DatabricksError::Client(DatabricksClientError::Authentication(error.to_string()))
            })
    }
}

#[cfg(test)]
mod tests {
    use dbx_tools_databricks::DatabricksAuthOptions;

    use super::DatabricksSessionCache;

    #[test]
    fn startup_user_only_overrides_auth_when_it_is_a_configured_profile() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("databrickscfg");
        std::fs::write(
            &config,
            "[DEFAULT]\nhost = https://workspace.example\nauth_type = databricks-cli\n",
        )
        .unwrap();
        let sessions = DatabricksSessionCache::new(DatabricksAuthOptions {
            config_file: Some(config.to_string_lossy().into_owned()),
            ..Default::default()
        });

        assert_eq!(
            sessions
                .resolve_profile(Some("DEFAULT"))
                .unwrap()
                .as_deref(),
            Some("DEFAULT")
        );
        assert_eq!(sessions.resolve_profile(Some("os-user")).unwrap(), None);
        assert_eq!(sessions.resolve_profile(None).unwrap(), None);
    }
}
