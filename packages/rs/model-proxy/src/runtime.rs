//! Atomic Databricks runtime generations for safe profile switching.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
    time::Duration,
};

use dbx_tools_core::{
    config_profile_exists, invalidate_config_file, is_databricks_app, list_config_profiles,
    AuthKind, DatabricksAuthOptions, DatabricksClient, DatabricksClientError,
    DatabricksProfileSummary,
};
use dbx_tools_model::{ModelClient, ModelError};
use dbx_tools_service::{PersistenceMode, SettingsStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::throttle::{RequestThrottle, ThrottleConfig, ThrottlePool};

const PROFILE_SETTING: &str = "databricks.runtime-selection";
const DEFAULT_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);

/// Profile source accepted by the runtime manager.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, schemars::JsonSchema, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "profile")]
pub(crate) enum RuntimeSelection {
    /// Resolve the normal ambient Databricks authentication chain.
    Ambient,
    /// Resolve one exact named Databricks CLI profile.
    Profile(String),
}

impl RuntimeSelection {
    pub(crate) fn exact_profile(profile: Option<String>) -> Result<Self, RuntimeError> {
        profile.map_or(Ok(Self::Ambient), |profile| {
            let profile = profile.trim();
            if profile.is_empty() {
                Err(RuntimeError::InvalidSelection(
                    "profile name must not be empty".into(),
                ))
            } else {
                Ok(Self::Profile(profile.to_owned()))
            }
        })
    }

    fn normalized(self) -> Result<Self, RuntimeError> {
        match self {
            Self::Ambient => Ok(Self::Ambient),
            Self::Profile(profile) => Self::exact_profile(Some(profile)),
        }
    }
}

/// Secret-free status for one committed runtime generation.
#[derive(Clone, Debug, Eq, PartialEq, schemars::JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStatus {
    /// Monotonic runtime generation identifier.
    pub(crate) generation: u64,
    /// Requested source used to resolve Databricks authentication.
    pub(crate) selection: RuntimeSelection,
    /// Resolved Databricks CLI profile name.
    pub(crate) profile: String,
    /// Resolved Databricks workspace or account host.
    pub(crate) host: String,
    /// Resolved workspace identifier when configured.
    pub(crate) workspace_id: Option<String>,
    /// Secret-free authentication kind label.
    pub(crate) auth_kind: String,
    /// Persistence mode used for service settings and aggregate metrics.
    pub(crate) persistence: PersistenceMode,
    /// Whether this process permits runtime profile switching.
    pub(crate) switching_enabled: bool,
    #[serde(skip)]
    #[schemars(skip)]
    pub(crate) storage_key: String,
}

/// One immutable request runtime that drains after it is replaced.
pub(crate) struct RuntimeGeneration {
    pub(crate) id: u64,
    pub(crate) selection: RuntimeSelection,
    pub(crate) storage_key: String,
    pub(crate) databricks: DatabricksClient,
    pub(crate) models: ModelClient,
    pub(crate) throttle: RequestThrottle,
}

impl RuntimeGeneration {
    fn status(&self, persistence: PersistenceMode, switching_enabled: bool) -> RuntimeStatus {
        RuntimeStatus {
            generation: self.id,
            selection: self.selection.clone(),
            profile: self.databricks.profile(),
            host: self.databricks.host().to_owned(),
            workspace_id: self.databricks.workspace_id().map(str::to_owned),
            auth_kind: auth_kind_label(self.databricks.auth_kind()).to_owned(),
            persistence,
            switching_enabled,
            storage_key: self.storage_key.clone(),
        }
    }
}

/// Immutable settings used while constructing every runtime generation.
#[derive(Clone, Debug)]
pub(crate) struct RuntimeConfig {
    pub(crate) throttle: ThrottleConfig,
    pub(crate) config_file: Option<PathBuf>,
    pub(crate) discovery_timeout: Duration,
}

impl RuntimeConfig {
    pub(crate) fn new(throttle: ThrottleConfig) -> Self {
        Self {
            throttle,
            config_file: None,
            discovery_timeout: DEFAULT_DISCOVERY_TIMEOUT,
        }
    }
}

/// Atomically commits validated Databricks runtime generations.
#[derive(Clone)]
pub(crate) struct RuntimeManager {
    current: Arc<RwLock<Arc<RuntimeGeneration>>>,
    switch_lock: Arc<Mutex<()>>,
    next_generation: Arc<AtomicU64>,
    throttle_pool: ThrottlePool,
    config: RuntimeConfig,
    settings: Arc<dyn SettingsStore>,
    persistence: PersistenceMode,
    in_databricks_app: bool,
}

impl RuntimeManager {
    pub(crate) async fn new_with_persistence(
        initial: RuntimeSelection,
        config: RuntimeConfig,
        settings: Arc<dyn SettingsStore>,
        persistence: PersistenceMode,
    ) -> Result<Self, RuntimeError> {
        Self::new_with_runtime(initial, config, settings, persistence, is_databricks_app()).await
    }

    async fn new_with_runtime(
        initial: RuntimeSelection,
        config: RuntimeConfig,
        settings: Arc<dyn SettingsStore>,
        persistence: PersistenceMode,
        in_databricks_app: bool,
    ) -> Result<Self, RuntimeError> {
        let selection = match settings.get(PROFILE_SETTING).map_err(settings_error)? {
            Some(value) => match serde_json::from_str::<RuntimeSelection>(&value) {
                Ok(RuntimeSelection::Profile(profile))
                    if !config_profile_exists(&profile, config.config_file.as_deref())? =>
                {
                    settings.remove(PROFILE_SETTING).map_err(settings_error)?;
                    initial
                }
                Ok(selection) => selection,
                Err(_) => {
                    settings.remove(PROFILE_SETTING).map_err(settings_error)?;
                    initial
                }
            },
            None => initial,
        }
        .normalized()?;
        let throttle_pool = ThrottlePool::default();
        let generation = build_generation(1, selection, &config, &throttle_pool, false).await?;
        Ok(Self {
            current: Arc::new(RwLock::new(Arc::new(generation))),
            switch_lock: Arc::default(),
            next_generation: Arc::new(AtomicU64::new(2)),
            throttle_pool,
            config,
            settings,
            persistence,
            in_databricks_app,
        })
    }

    /// Capture one generation for an entire request.
    pub(crate) fn capture(&self) -> Arc<RuntimeGeneration> {
        Arc::clone(&self.current.read().expect("model proxy runtime read lock"))
    }

    /// Return secret-free status for the current generation.
    pub(crate) fn status(&self) -> RuntimeStatus {
        self.capture()
            .status(self.persistence, !self.in_databricks_app)
    }

    /// Enumerate profiles through the core cached parser.
    #[allow(dead_code)]
    pub(crate) fn profiles(
        &self,
        refresh: bool,
    ) -> Result<Vec<DatabricksProfileSummary>, RuntimeError> {
        list_config_profiles(self.config.config_file.as_deref(), refresh).map_err(Into::into)
    }

    /// Validate and atomically commit an ambient or exact named profile.
    #[allow(dead_code)]
    pub(crate) async fn switch(
        &self,
        selection: RuntimeSelection,
    ) -> Result<RuntimeStatus, RuntimeError> {
        if self.in_databricks_app {
            return Err(RuntimeError::SwitchingDisabled);
        }
        let selection = selection.normalized()?;
        let _switch = self.switch_lock.lock().await;
        invalidate_config_file(self.config.config_file.as_deref())?;
        let generation_id = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let candidate = build_generation(
            generation_id,
            selection.clone(),
            &self.config,
            &self.throttle_pool,
            true,
        )
        .await?;
        let serialized = serde_json::to_string(&selection)
            .map_err(|error| RuntimeError::Settings(error.to_string()))?;
        self.settings
            .set(PROFILE_SETTING, &serialized)
            .map_err(settings_error)?;
        let candidate = Arc::new(candidate);
        let status = candidate.status(self.persistence, !self.in_databricks_app);
        *self
            .current
            .write()
            .expect("model proxy runtime write lock") = candidate;
        Ok(status)
    }
}

fn auth_kind_label(kind: AuthKind) -> &'static str {
    match kind {
        AuthKind::UserToMachine => "user-to-machine",
        AuthKind::MachineToMachine => "machine-to-machine",
        AuthKind::PersonalAccessToken => "personal-access-token",
        AuthKind::AppServicePrincipal => "app-service-principal",
        AuthKind::AppOnBehalfOf => "app-on-behalf-of",
    }
}

fn runtime_storage_key(client: &DatabricksClient) -> String {
    let mut digest = Sha256::new();
    digest.update(client.host().as_bytes());
    digest.update([0]);
    digest.update(client.workspace_id().unwrap_or_default().as_bytes());
    digest.update([0]);
    digest.update(client.principal().as_bytes());
    format!("{:x}", digest.finalize())
}

async fn build_generation(
    id: u64,
    selection: RuntimeSelection,
    config: &RuntimeConfig,
    throttle_pool: &ThrottlePool,
    validate: bool,
) -> Result<RuntimeGeneration, RuntimeError> {
    let config_file = config
        .config_file
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    let databricks = match &selection {
        RuntimeSelection::Ambient => {
            DatabricksClient::with_options(DatabricksAuthOptions {
                config_file: config
                    .config_file
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                prefer_user_to_machine: false,
                ..Default::default()
            })
            .await?
        }
        RuntimeSelection::Profile(profile) => {
            DatabricksClient::with_exact_profile(profile.clone(), config_file).await?
        }
    };
    if databricks.auth_kind() == AuthKind::AppOnBehalfOf {
        return Err(RuntimeError::GlobalAppOnBehalfOf);
    }
    if validate {
        let validation = ModelClient::new(databricks.non_interactive())?;
        tokio::time::timeout(
            config.discovery_timeout,
            validation.validate_live_endpoints(),
        )
        .await
        .map_err(|_| RuntimeError::DiscoveryTimeout(config.discovery_timeout))??;
    }
    let models = ModelClient::new(databricks.clone())?;
    let throttle = throttle_pool
        .resolve(databricks.identity().workspace(), config.throttle.clone())
        .await;
    let storage_key = runtime_storage_key(&databricks);
    Ok(RuntimeGeneration {
        id,
        selection,
        storage_key,
        databricks,
        models,
        throttle,
    })
}

fn settings_error(error: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::Settings(error.to_string())
}

/// Errors returned while constructing or switching runtime generations.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RuntimeError {
    /// A profile selection was empty or malformed.
    #[error("invalid runtime selection: {0}")]
    InvalidSelection(String),
    /// Databricks profile parsing failed.
    #[error(transparent)]
    Core(#[from] dbx_tools_core::Error),
    /// Databricks authentication or transport construction failed.
    #[error(transparent)]
    Databricks(#[from] DatabricksClientError),
    /// Model endpoint discovery failed.
    #[error(transparent)]
    Model(#[from] ModelError),
    /// Live endpoint discovery exceeded its validation bound.
    #[error("live Databricks endpoint discovery exceeded {0:?}")]
    DiscoveryTimeout(Duration),
    /// The injected settings store rejected the selection.
    #[error("runtime settings failed: {0}")]
    Settings(String),
    /// Profile switching is unavailable inside Databricks Apps.
    #[error("Databricks profile switching is disabled inside Databricks Apps")]
    SwitchingDisabled,
    /// One global App OBO credential must never back the shared proxy runtime.
    #[error("global Databricks App on-behalf-of authentication is prohibited")]
    GlobalAppOnBehalfOf,
}

#[cfg(test)]
mod tests {
    use dbx_tools_service::{MemorySettings, SettingsStore};
    use serde_json::json;
    use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::throttle::RateLimitMode;

    fn config(path: PathBuf) -> RuntimeConfig {
        RuntimeConfig {
            throttle: ThrottleConfig {
                input_tokens_per_minute: None,
                output_tokens_per_minute: None,
                provisioned_throughput: false,
                mode: RateLimitMode::Off,
                documented_limits: Default::default(),
            },
            config_file: Some(path),
            discovery_timeout: Duration::from_secs(2),
        }
    }

    async fn endpoint_server(status: u16) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(path("/api/2.0/serving-endpoints"))
            .respond_with(
                ResponseTemplate::new(status)
                    .set_body_json(json!({"endpoints": [{"name": "model"}]})),
            )
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn switches_atomically_and_old_generations_drain() {
        let first = endpoint_server(200).await;
        let second = endpoint_server(200).await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("databrickscfg");
        std::fs::write(
            &path,
            format!(
                "[first]\nhost = {}\nauth_type = pat\ntoken = first-token\n\
                 [second]\nhost = {}\nauth_type = pat\ntoken = second-token\n",
                first.uri(),
                second.uri(),
            ),
        )
        .unwrap();
        let settings = Arc::new(MemorySettings::default());
        let manager = RuntimeManager::new_with_runtime(
            RuntimeSelection::Profile("first".into()),
            config(path),
            settings.clone(),
            PersistenceMode::Memory,
            false,
        )
        .await
        .unwrap();
        let old = manager.capture();
        let old_weak = Arc::downgrade(&old);

        let status = manager
            .switch(RuntimeSelection::Profile("second".into()))
            .await
            .unwrap();

        assert_eq!(status.generation, 2);
        assert_eq!(status.profile, "second");
        assert_eq!(status.persistence, PersistenceMode::Memory);
        assert!(status.switching_enabled);
        assert_eq!(status.storage_key.len(), 64);
        assert!(!status.storage_key.contains("second"));
        assert!(!status.storage_key.contains(&second.uri()));
        assert_eq!(old.databricks.profile(), "first");
        assert_eq!(manager.capture().databricks.profile(), "second");
        assert!(old_weak.upgrade().is_some());
        drop(old);
        assert!(old_weak.upgrade().is_none());
        assert!(settings
            .get(PROFILE_SETTING)
            .unwrap()
            .is_some_and(|value| value.contains("second")));
    }

    #[tokio::test]
    async fn failed_candidate_keeps_the_committed_generation() {
        let first = endpoint_server(200).await;
        let failing = endpoint_server(500).await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("databrickscfg");
        std::fs::write(
            &path,
            format!(
                "[first]\nhost = {}\nauth_type = pat\ntoken = first-token\n\
                 [failing]\nhost = {}\nauth_type = pat\ntoken = failing-token\n",
                first.uri(),
                failing.uri(),
            ),
        )
        .unwrap();
        let manager = RuntimeManager::new_with_runtime(
            RuntimeSelection::Profile("first".into()),
            config(path),
            Arc::new(MemorySettings::default()),
            PersistenceMode::Memory,
            false,
        )
        .await
        .unwrap();

        assert!(manager
            .switch(RuntimeSelection::Profile("failing".into()))
            .await
            .is_err());
        assert_eq!(manager.status().generation, 1);
        assert_eq!(manager.status().profile, "first");
    }

    #[tokio::test]
    async fn missing_persisted_profile_falls_back_to_core_resolution() {
        let server = endpoint_server(200).await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("databrickscfg");
        std::fs::write(
            &path,
            format!(
                "[first]\nhost = {}\nauth_type = pat\ntoken = first-token\n",
                server.uri()
            ),
        )
        .unwrap();
        let settings = Arc::new(MemorySettings::default());
        settings
            .set(
                PROFILE_SETTING,
                &serde_json::to_string(&RuntimeSelection::Profile("missing".into())).unwrap(),
            )
            .unwrap();

        let manager = RuntimeManager::new_with_runtime(
            RuntimeSelection::Ambient,
            config(path),
            settings.clone(),
            PersistenceMode::Memory,
            false,
        )
        .await
        .unwrap();

        assert_eq!(manager.status().profile, "first");
        assert_eq!(manager.status().selection, RuntimeSelection::Ambient);
        assert_eq!(settings.get(PROFILE_SETTING).unwrap(), None);
    }

    #[tokio::test]
    async fn malformed_persisted_profile_falls_back_to_core_resolution() {
        let server = endpoint_server(200).await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("databrickscfg");
        std::fs::write(
            &path,
            format!(
                "[first]\nhost = {}\nauth_type = pat\ntoken = first-token\n",
                server.uri()
            ),
        )
        .unwrap();
        let settings = Arc::new(MemorySettings::default());
        settings.set(PROFILE_SETTING, "not-json").unwrap();

        let manager = RuntimeManager::new_with_runtime(
            RuntimeSelection::Ambient,
            config(path),
            settings.clone(),
            PersistenceMode::Memory,
            false,
        )
        .await
        .unwrap();

        assert_eq!(manager.status().profile, "first");
        assert_eq!(manager.status().selection, RuntimeSelection::Ambient);
        assert_eq!(settings.get(PROFILE_SETTING).unwrap(), None);
    }

    #[tokio::test]
    async fn reuses_throttle_state_for_the_same_workspace_identity() {
        let server = endpoint_server(200).await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("databrickscfg");
        std::fs::write(
            &path,
            format!(
                "[first]\nhost = {}\nworkspace_id = 123\nauth_type = pat\ntoken = first-token\n\
                 [second]\nhost = {}\nworkspace_id = 123\nauth_type = pat\ntoken = second-token\n",
                server.uri(),
                server.uri(),
            ),
        )
        .unwrap();
        let manager = RuntimeManager::new_with_runtime(
            RuntimeSelection::Profile("first".into()),
            config(path),
            Arc::new(MemorySettings::default()),
            PersistenceMode::Memory,
            false,
        )
        .await
        .unwrap();
        let first = manager.capture();

        manager
            .switch(RuntimeSelection::Profile("second".into()))
            .await
            .unwrap();
        let second = manager.capture();

        assert!(first.throttle.shares_state_with(&second.throttle));
        assert_eq!(manager.throttle_pool.len().await, 1);
    }

    #[tokio::test]
    async fn rejects_profile_switching_inside_databricks_apps() {
        let server = endpoint_server(200).await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("databrickscfg");
        std::fs::write(
            &path,
            format!(
                "[first]\nhost = {}\nauth_type = pat\ntoken = first-token\n",
                server.uri()
            ),
        )
        .unwrap();
        let manager = RuntimeManager::new_with_runtime(
            RuntimeSelection::Profile("first".into()),
            config(path),
            Arc::new(MemorySettings::default()),
            PersistenceMode::Memory,
            true,
        )
        .await
        .unwrap();

        assert!(matches!(
            manager
                .switch(RuntimeSelection::Profile("first".into()))
                .await,
            Err(RuntimeError::SwitchingDisabled)
        ));
    }

    #[tokio::test]
    async fn rejects_a_global_app_obo_generation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("databrickscfg");
        std::fs::write(
            &path,
            "[obo]\nhost = https://workspace.example\nauth_type = app_obo\ntoken = request-token\n",
        )
        .unwrap();

        assert!(matches!(
            RuntimeManager::new_with_runtime(
                RuntimeSelection::Profile("obo".into()),
                config(path),
                Arc::new(MemorySettings::default()),
                PersistenceMode::Memory,
                false,
            )
            .await,
            Err(RuntimeError::GlobalAppOnBehalfOf)
        ));
    }
}
