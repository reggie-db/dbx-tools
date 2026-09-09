mod config_file;
mod policy;
mod resolve;

use std::{fmt, path::PathBuf};

use sha2::{Digest, Sha256};
use url::Url;

pub use config_file::{config_profile_exists, resolve_config_file};
pub(super) use policy::{
    app_service_principal_available, request_obo_token, resolve_app_auth_type,
};

/// OAuth client ID used for Databricks CLI user authorization.
pub const DEFAULT_CLIENT_ID: &str = "databricks-cli";
/// Default host for Databricks account authentication.
pub const DEFAULT_ACCOUNTS_HOST: &str = "https://accounts.cloud.databricks.com";
/// Default path to the Databricks CLI configuration file.
pub const DEFAULT_CONFIG_FILE: &str = "~/.databrickscfg";
/// Authentication type for a Databricks App on-behalf-of token.
pub const AUTH_TYPE_APP_OBO: &str = "app_obo";
/// Authentication type for Databricks App service-principal credentials.
pub const AUTH_TYPE_APP_SP: &str = "app_sp";
const SETTINGS_SECTION: &str = "__settings__";

/// Authentication strategy selected from Databricks configuration.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AuthKind {
    /// Interactive user authorization with refresh-token storage.
    #[default]
    UserToMachine,
    /// Service-principal client credentials.
    MachineToMachine,
    /// Static personal access token.
    PersonalAccessToken,
    /// Databricks App service-principal client credentials.
    AppServicePrincipal,
    /// Current Databricks App request's on-behalf-of token.
    AppOnBehalfOf,
}

/// Scope of the Databricks authentication target.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TargetKind {
    /// A Databricks workspace.
    #[default]
    Workspace,
    /// A Databricks account.
    Account,
    /// Unified authentication discovered for a Databricks account.
    Unified,
}

/// Resolved Databricks profile and authentication strategy.
#[derive(Clone)]
pub struct Profile {
    /// Databricks CLI profile name.
    pub name: String,
    /// Normalized workspace or accounts host.
    pub host: Url,
    /// Account identifier for account and unified targets.
    pub account_id: Option<String>,
    /// Workspace identifier associated with the profile.
    pub workspace_id: Option<String>,
    /// OAuth client identifier.
    pub client_id: String,
    /// Optional group role requested by M2M token generation.
    pub group_id: Option<String>,
    /// OAuth scopes requested for this profile.
    pub scopes: Vec<String>,
    /// Scope of the authentication target.
    pub target: TargetKind,
    /// Authentication strategy resolved for this profile.
    pub auth_kind: AuthKind,
    pub(crate) client_secret: Option<String>,
    pub(crate) access_token: Option<String>,
}

impl Profile {
    /// Return the credential cache key for this profile and authentication strategy.
    pub fn cache_key(&self) -> String {
        match self.auth_kind {
            AuthKind::UserToMachine => self.name.clone(),
            AuthKind::PersonalAccessToken => format!("{}-pat", self.name),
            AuthKind::AppOnBehalfOf => format!("{}-app-obo", self.name),
            AuthKind::MachineToMachine | AuthKind::AppServicePrincipal => {
                let scopes = self.machine_scopes();
                let identity = format!(
                    "{}\0{}\0{}\0{}\0{}\0{}",
                    self.host,
                    self.account_id.as_deref().unwrap_or_default(),
                    self.workspace_id.as_deref().unwrap_or_default(),
                    self.client_id,
                    self.group_id.as_deref().unwrap_or_default(),
                    scopes.join(" "),
                );
                format!(
                    "{}-{}-{:x}",
                    self.name,
                    if self.auth_kind == AuthKind::AppServicePrincipal {
                        "app-sp"
                    } else {
                        "oauth-m2m"
                    },
                    Sha256::digest(identity.as_bytes())
                )
            }
        }
    }

    pub(crate) fn client_secret(&self) -> Option<&str> {
        self.client_secret.as_deref()
    }

    pub(crate) fn access_token(&self) -> Option<&str> {
        self.access_token.as_deref()
    }

    /// Return user authorization scopes with `offline_access` included once.
    pub fn effective_scopes(&self) -> Vec<String> {
        let mut scopes = vec!["offline_access".to_owned()];
        for scope in &self.scopes {
            if !scopes.contains(scope) {
                scopes.push(scope.clone());
            }
        }
        scopes
    }

    /// Return sorted, unique M2M scopes, defaulting to `all-apis`.
    pub fn machine_scopes(&self) -> Vec<String> {
        let mut scopes = self.scopes.clone();
        if scopes.is_empty() {
            scopes.push("all-apis".to_owned());
        }
        scopes.sort();
        scopes.dedup();
        scopes
    }
}

impl fmt::Debug for Profile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Profile")
            .field("name", &self.name)
            .field("host", &self.host)
            .field("account_id", &self.account_id)
            .field("workspace_id", &self.workspace_id)
            .field("client_id", &self.client_id)
            .field("group_id", &self.group_id)
            .field("scopes", &self.scopes)
            .field("target", &self.target)
            .field("auth_kind", &self.auth_kind)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "access_token",
                &self.access_token.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

/// Databricks profile overrides; debug output never includes the client secret.
#[derive(Clone)]
pub struct ProfileOptions {
    /// Explicit Databricks CLI profile name.
    pub profile: Option<String>,
    /// Explicit workspace or accounts host.
    pub host: Option<String>,
    /// Explicit Databricks account identifier.
    pub account_id: Option<String>,
    /// Explicit Databricks workspace identifier.
    pub workspace_id: Option<String>,
    /// Explicit OAuth client identifier.
    pub client_id: Option<String>,
    /// M2M secret accepted by the Rust API and redacted from debug output.
    pub client_secret: Option<String>,
    /// Personal access token accepted by the Rust API and redacted from debug output.
    pub access_token: Option<String>,
    /// Optional group role requested by M2M.
    pub group_id: Option<String>,
    /// Explicit Databricks authentication type.
    pub auth_type: Option<String>,
    /// Explicit OAuth scopes replacing configured profile scopes.
    pub scopes: Option<Vec<String>>,
    /// Explicit workspace, account, or unified target.
    pub target: Option<TargetKind>,
    /// Explicit Databricks CLI configuration file path.
    pub config_file: Option<PathBuf>,
    /// Whether implicit M2M defaults should select one matching U2M profile.
    pub prefer_user_to_machine: bool,
    /// Whether an implicit PAT profile should be ignored.
    pub skip_implicit_pat: bool,
    /// Ignore ambient Databricks credential variables after selecting a profile.
    pub ignore_ambient_credentials: bool,
    /// Ignore ambient auth-type selection while resolving App-specific tiers.
    pub ignore_ambient_auth_type: bool,
}

impl fmt::Debug for ProfileOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProfileOptions")
            .field("profile", &self.profile)
            .field("host", &self.host)
            .field("client_id", &self.client_id)
            .field("auth_type", &self.auth_type)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "access_token",
                &self.access_token.as_ref().map(|_| "[REDACTED]"),
            )
            .finish_non_exhaustive()
    }
}

impl Default for ProfileOptions {
    fn default() -> Self {
        Self {
            profile: None,
            host: None,
            account_id: None,
            workspace_id: None,
            client_id: None,
            client_secret: None,
            access_token: None,
            group_id: None,
            auth_type: None,
            scopes: None,
            target: None,
            config_file: None,
            prefer_user_to_machine: true,
            skip_implicit_pat: false,
            ignore_ambient_credentials: false,
            ignore_ambient_auth_type: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_option_debug_redacts_client_secrets() {
        let options = ProfileOptions {
            client_secret: Some("sensitive-client-secret".into()),
            access_token: Some("sensitive-access-token".into()),
            ..ProfileOptions::default()
        };
        let debug = format!("{options:?}");
        assert!(!debug.contains("sensitive-client-secret"));
        assert!(!debug.contains("sensitive-access-token"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn pat_profile_uses_a_distinct_key_and_redacts_its_token() {
        let directory = tempfile::tempdir().unwrap();
        let profile = Profile::from_sources(ProfileOptions {
            profile: Some("personal".into()),
            host: Some("http://127.0.0.1:8080".into()),
            access_token: Some("credential-value".into()),
            auth_type: Some(policy::AUTH_TYPE_PAT.into()),
            config_file: Some(directory.path().join("missing")),
            ..ProfileOptions::default()
        })
        .unwrap();

        assert_eq!(profile.auth_kind, AuthKind::PersonalAccessToken);
        assert_eq!(profile.cache_key(), "personal-pat");
        assert!(!format!("{profile:?}").contains("credential-value"));
    }

    #[test]
    fn m2m_cache_keys_include_client_group_and_scopes() {
        let profile = Profile {
            name: "service".into(),
            host: Url::parse("https://workspace.example").unwrap(),
            account_id: None,
            workspace_id: None,
            client_id: "client".into(),
            group_id: Some("group".into()),
            scopes: vec!["jobs".into(), "files:read".into()],
            target: TargetKind::Workspace,
            auth_kind: AuthKind::MachineToMachine,
            client_secret: Some("credential-value".into()),
            access_token: None,
        };
        let key = profile.cache_key();
        assert!(key.starts_with("service-oauth-m2m-"));
        assert!(!key.contains("credential-value"));
        assert!(!format!("{profile:?}").contains("credential-value"));
    }
}
