//! Transport-neutral desktop operator operations.

use dbx_tools_core::{AuthKind, DatabricksProfileSummary, TargetKind};
use serde::{Deserialize, Serialize};

use crate::{
    metrics::MetricsSnapshot,
    routes::AppState,
    runtime::{RuntimeSelection, RuntimeStatus},
};

#[derive(Clone)]
pub(crate) struct OperatorService {
    state: AppState,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStatusDto {
    pub(crate) generation: u64,
    pub(crate) selection: RuntimeSelection,
    pub(crate) profile: String,
    pub(crate) host: String,
    pub(crate) workspace_id: Option<String>,
    pub(crate) auth_kind: String,
    pub(crate) persistence: String,
    pub(crate) switching_enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthStatus {
    pub(crate) runtime: RuntimeStatusDto,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileSummary {
    pub(crate) name: String,
    pub(crate) host: Option<String>,
    pub(crate) account_id: Option<String>,
    pub(crate) workspace_id: Option<String>,
    pub(crate) target: String,
    pub(crate) auth_kind: String,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profiles {
    pub(crate) profiles: Vec<ProfileSummary>,
}

#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelControlInput {
    pub(crate) model: String,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct WaitCancellation {
    pub(crate) model: String,
    pub(crate) capacity_waiters: u64,
    pub(crate) cooldown_waiters: u64,
    pub(crate) matched_cooldown_keys: u64,
    pub(crate) cancelled_waiters: u64,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "desktop", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct CooldownRelease {
    pub(crate) model: String,
    pub(crate) matched_cooldown_keys: u64,
    pub(crate) released_cooldowns: u64,
}

impl From<RuntimeStatus> for RuntimeStatusDto {
    fn from(status: RuntimeStatus) -> Self {
        Self {
            generation: status.generation,
            selection: status.selection,
            profile: status.profile,
            host: status.host,
            workspace_id: status.workspace_id,
            auth_kind: status.auth_kind,
            persistence: match status.persistence {
                dbx_tools_service::PersistenceMode::Auto => "auto",
                dbx_tools_service::PersistenceMode::Memory => "memory",
                dbx_tools_service::PersistenceMode::Sqlite => "sqlite",
            }
            .to_owned(),
            switching_enabled: status.switching_enabled,
        }
    }
}

impl From<&DatabricksProfileSummary> for ProfileSummary {
    fn from(profile: &DatabricksProfileSummary) -> Self {
        Self {
            name: profile.name.clone(),
            host: profile.host.clone(),
            account_id: profile.account_id.clone(),
            workspace_id: profile.workspace_id.clone(),
            target: match profile.target {
                TargetKind::Workspace => "workspace",
                TargetKind::Account => "account",
                TargetKind::Unified => "unified",
            }
            .to_owned(),
            auth_kind: match profile.auth_kind {
                AuthKind::UserToMachine => "user-to-machine",
                AuthKind::MachineToMachine => "machine-to-machine",
                AuthKind::PersonalAccessToken => "personal-access-token",
                AuthKind::AppServicePrincipal => "app-service-principal",
                AuthKind::AppOnBehalfOf => "app-on-behalf-of",
            }
            .to_owned(),
        }
    }
}

impl OperatorService {
    pub(crate) fn new(state: AppState) -> Self {
        Self { state }
    }

    pub(crate) fn auth_status(&self) -> AuthStatus {
        AuthStatus {
            runtime: self.state.runtime.status().into(),
        }
    }

    pub(crate) fn profiles(&self, refresh: bool) -> Result<Profiles, String> {
        self.state
            .runtime
            .profiles(refresh)
            .map(|profiles| Profiles {
                profiles: profiles.iter().map(ProfileSummary::from).collect(),
            })
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn switch(&self, selection: RuntimeSelection) -> Result<AuthStatus, String> {
        let status = self
            .state
            .runtime
            .switch(selection)
            .await
            .map_err(|error| error.to_string())?;
        let metrics = self.state.metrics.clone();
        let storage_key = status.storage_key.clone();
        tokio::task::spawn_blocking(move || metrics.activate_runtime(storage_key))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        Ok(AuthStatus {
            runtime: status.into(),
        })
    }

    pub(crate) async fn metrics(&self, model: Option<&str>) -> MetricsSnapshot {
        let runtime = self.state.runtime.capture();
        let capacities = runtime.throttle.capacity_snapshots().await;
        let rate_limits = self.state.rate_limits.model_snapshots().await;
        self.state.metrics.record_capacity_snapshots(&capacities);
        self.state
            .metrics
            .record_rate_limit_snapshots(&rate_limits, true);
        let mut snapshot = model.map_or_else(
            || self.state.metrics.snapshot(),
            |model| self.state.metrics.snapshot_for_model(model),
        );
        snapshot.apply_capacity_snapshots(&capacities);
        snapshot.apply_rate_limit_snapshots(&rate_limits, true);
        snapshot
    }

    pub(crate) async fn cancel_waits(
        &self,
        input: ModelControlInput,
    ) -> Result<WaitCancellation, String> {
        let model = normalized_model(input.model)?;
        let runtime = self.state.runtime.capture();
        let capacity = runtime.throttle.cancel_waits(&model).await;
        let cooldown = self.state.rate_limits.cancel_waits(&model).await;
        Ok(WaitCancellation {
            model,
            capacity_waiters: capacity.cancelled_waiters,
            cooldown_waiters: cooldown.cancelled_waiters,
            matched_cooldown_keys: cooldown.matched_keys,
            cancelled_waiters: capacity
                .cancelled_waiters
                .saturating_add(cooldown.cancelled_waiters),
        })
    }

    pub(crate) async fn retry_now(
        &self,
        input: ModelControlInput,
    ) -> Result<CooldownRelease, String> {
        let model = normalized_model(input.model)?;
        let released = self.state.rate_limits.release_cooldowns(&model).await;
        Ok(CooldownRelease {
            model,
            matched_cooldown_keys: released.matched_keys,
            released_cooldowns: released.released_cooldowns,
        })
    }

    #[cfg(feature = "metrics")]
    pub(crate) fn subscribe(&self) -> Option<tokio::sync::broadcast::Receiver<()>> {
        self.state.metrics.subscribe()
    }
}

fn normalized_model(model: String) -> Result<String, String> {
    let model = model.trim();
    if model.is_empty() {
        Err("model must not be empty".to_owned())
    } else {
        Ok(model.to_owned())
    }
}
