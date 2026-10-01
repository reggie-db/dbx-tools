mod config_file;
mod policy;
mod resolve;

use std::{
    fmt,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};
use url::Url;

pub use config_file::{config_profile_exists, invalidate_config_file, resolve_config_file};
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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, uniffi::Enum)]
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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, uniffi::Enum)]
pub enum TargetKind {
    /// A Databricks workspace.
    #[default]
    Workspace,
    /// A Databricks account.
    Account,
    /// Unified authentication discovered for a Databricks account.
    Unified,
}

/// Secret-free metadata discovered from one Databricks CLI profile.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DatabricksProfileSummary {
    /// Databricks CLI profile name.
    pub name: String,
    /// Configured workspace or accounts host.
    pub host: Option<String>,
    /// Account identifier associated with the profile.
    pub account_id: Option<String>,
    /// Workspace identifier associated with the profile.
    pub workspace_id: Option<String>,
    /// Target inferred from the configured host and account metadata.
    pub target: TargetKind,
    /// Authentication kind inferred without returning credential values.
    pub auth_kind: AuthKind,
}

/// Enumerate secret-free profiles from the cached Databricks CLI configuration.
///
/// Set `refresh` after an external process such as `databricks auth login`
/// changes the profile file. Ordinary calls preserve the process-wide parsed
/// configuration cache.
pub fn list_config_profiles(
    config_file: Option<&Path>,
    refresh: bool,
) -> crate::Result<Vec<DatabricksProfileSummary>> {
    if refresh {
        invalidate_config_file(config_file)?;
    }
    let path = resolve_config_file(config_file)?;
    let Some(config) = config_file::load_config(&path)? else {
        return Ok(Vec::new());
    };
    let mut profiles = config
        .sections()
        .into_iter()
        .filter(|name| name != SETTINGS_SECTION)
        .map(|name| {
            let raw = config_file::load_profile(&config, &name);
            let auth_kind = policy::resolve_auth_kind(
                raw.auth_type.as_deref(),
                raw.client_id.as_deref(),
                raw.client_secret.as_deref(),
                raw.access_token.as_deref(),
            )?;
            let host = raw.host.as_deref().and_then(trimmed);
            let account_id = raw.account_id.as_deref().and_then(trimmed);
            let workspace_id = raw.workspace_id.as_deref().and_then(trimmed);
            Ok(DatabricksProfileSummary {
                target: inferred_target(host.as_deref(), account_id.as_deref()),
                name,
                host,
                account_id,
                workspace_id,
                auth_kind,
            })
        })
        .collect::<crate::Result<Vec<_>>>()?;
    profiles.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(profiles)
}

fn inferred_target(host: Option<&str>, account_id: Option<&str>) -> TargetKind {
    if account_id.is_some()
        && host
            .and_then(|value| resolve::normalize_host(value).ok())
            .and_then(|value| value.host_str().map(str::to_owned))
            .as_deref()
            == Some("accounts.cloud.databricks.com")
    {
        TargetKind::Account
    } else {
        TargetKind::Workspace
    }
}

fn trimmed(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
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
    /// Return the user profile or service-principal client identifier.
    pub fn principal_key(&self) -> &str {
        match self.auth_kind {
            AuthKind::MachineToMachine | AuthKind::AppServicePrincipal => &self.client_id,
            AuthKind::UserToMachine | AuthKind::PersonalAccessToken | AuthKind::AppOnBehalfOf => {
                &self.name
            }
        }
    }

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

    #[test]
    fn profile_enumeration_is_secret_free_and_refreshable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("databrickscfg");
        std::fs::write(
            &path,
            "[workspace]\nhost = https://workspace.example\nworkspace_id = 123\nauth_type = pat\ntoken = sensitive-token\n\
             [account]\nhost = https://accounts.cloud.databricks.com\naccount_id = account-1\nclient_id = client\nclient_secret = sensitive-secret\n",
        )
        .unwrap();

        let profiles = list_config_profiles(Some(&path), false).unwrap();
        assert_eq!(
            profiles,
            vec![
                DatabricksProfileSummary {
                    name: "account".into(),
                    host: Some("https://accounts.cloud.databricks.com".into()),
                    account_id: Some("account-1".into()),
                    workspace_id: None,
                    target: TargetKind::Account,
                    auth_kind: AuthKind::MachineToMachine,
                },
                DatabricksProfileSummary {
                    name: "workspace".into(),
                    host: Some("https://workspace.example".into()),
                    account_id: None,
                    workspace_id: Some("123".into()),
                    target: TargetKind::Workspace,
                    auth_kind: AuthKind::PersonalAccessToken,
                },
            ]
        );
        let debug = format!("{profiles:?}");
        assert!(!debug.contains("sensitive-token"));
        assert!(!debug.contains("sensitive-secret"));

        std::fs::write(
            &path,
            "[replacement]\nhost = https://replacement.example\nauth_type = databricks-cli\n",
        )
        .unwrap();
        assert_eq!(list_config_profiles(Some(&path), false).unwrap(), profiles);
        assert_eq!(
            list_config_profiles(Some(&path), true).unwrap(),
            vec![DatabricksProfileSummary {
                name: "replacement".into(),
                host: Some("https://replacement.example".into()),
                account_id: None,
                workspace_id: None,
                target: TargetKind::Workspace,
                auth_kind: AuthKind::UserToMachine,
            }]
        );
    }
}
