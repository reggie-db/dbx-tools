use std::{
    collections::HashMap,
    env, fmt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use configparser::ini::Ini;
use directories::UserDirs;
use sha2::{Digest, Sha256};
use url::Url;

use crate::{Error, Result};

pub const DEFAULT_CLIENT_ID: &str = "databricks-cli";
pub const DEFAULT_ACCOUNTS_HOST: &str = "https://accounts.cloud.databricks.com";
pub const DEFAULT_CONFIG_FILE: &str = "~/.databrickscfg";
const SETTINGS_SECTION: &str = "__settings__";
const AUTH_TYPE_DATABRICKS_CLI: &str = "databricks-cli";
const AUTH_TYPE_M2M: &str = "oauth-m2m";
static CONFIG_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedConfig>>> = OnceLock::new();

#[derive(Clone)]
enum CachedConfig {
    Loaded(Arc<Ini>),
    Missing,
    Invalid(String),
}

/// OAuth strategy selected from Databricks configuration.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AuthKind {
    /// Interactive user authorization with refresh-token storage.
    #[default]
    UserToMachine,
    /// Service-principal client credentials.
    MachineToMachine,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TargetKind {
    #[default]
    Workspace,
    Account,
    Unified,
}

#[derive(Clone)]
pub struct Profile {
    pub name: String,
    pub host: Url,
    pub account_id: Option<String>,
    pub workspace_id: Option<String>,
    pub client_id: String,
    /// Optional group role requested by M2M token generation.
    pub group_id: Option<String>,
    pub scopes: Vec<String>,
    pub target: TargetKind,
    /// OAuth strategy resolved for this profile.
    pub auth_kind: AuthKind,
    pub(crate) client_secret: Option<String>,
}

impl Profile {
    pub fn from_sources(options: ProfileOptions) -> Result<Self> {
        let config_file = resolve_config_file(options.config_file.as_deref())?;
        let prefer_user_to_machine = options.prefer_user_to_machine;
        let environment_profile = env_nonempty("DATABRICKS_CONFIG_PROFILE");
        let explicit_profile = options.profile.is_some() || environment_profile.is_some();
        let requested_name = options
            .profile
            .or(environment_profile)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let config = load_config(&config_file)?;
        let profile_name = resolve_auth_profile_name(
            requested_name.as_deref(),
            explicit_profile,
            config.as_deref(),
            prefer_user_to_machine,
        )?;
        let configured = config
            .as_deref()
            .map(|config| load_profile(config, &profile_name))
            .unwrap_or_default();

        let host = options
            .host
            .or_else(|| env_nonempty("DATABRICKS_HOST"))
            .or(configured.host)
            .ok_or_else(|| Error::Config(format!("profile {profile_name} has no host")))?;
        let host = normalize_host(&host)?;
        let account_id = options
            .account_id
            .or_else(|| env_nonempty("DATABRICKS_ACCOUNT_ID"))
            .or(configured.account_id);
        let workspace_id = options
            .workspace_id
            .or_else(|| env_nonempty("DATABRICKS_WORKSPACE_ID"))
            .or(configured.workspace_id);
        let client_id = options
            .client_id
            .or_else(|| env_nonempty("DATABRICKS_CLIENT_ID"))
            .or(configured.client_id);
        let client_secret = options
            .client_secret
            .or_else(|| env_nonempty("DATABRICKS_CLIENT_SECRET"))
            .or(configured.client_secret);
        let group_id = options
            .group_id
            .or_else(|| env_nonempty("DATABRICKS_GROUP_ID"))
            .or(configured.group_id);
        let auth_type = options
            .auth_type
            .or_else(|| env_nonempty("DATABRICKS_AUTH_TYPE"))
            .or(configured.auth_type);
        let auth_kind = resolve_auth_kind(
            auth_type.as_deref(),
            client_id.as_deref(),
            client_secret.as_deref(),
        )?;
        let client_id = match auth_kind {
            AuthKind::UserToMachine => client_id.unwrap_or_else(|| DEFAULT_CLIENT_ID.to_owned()),
            AuthKind::MachineToMachine => client_id.ok_or_else(|| {
                Error::Config(format!(
                    "profile {profile_name} requires client_id for oauth-m2m"
                ))
            })?,
        };
        let scopes = options
            .scopes
            .or_else(|| configured.scopes.map(split_list))
            .unwrap_or_else(|| vec!["all-apis".to_owned()]);
        let target = options.target.unwrap_or_else(|| {
            if account_id.is_some() && host.host_str() == Some("accounts.cloud.databricks.com") {
                TargetKind::Account
            } else {
                TargetKind::Workspace
            }
        });

        Ok(Self {
            name: profile_name,
            host,
            account_id,
            workspace_id,
            client_id,
            group_id,
            scopes,
            target,
            auth_kind,
            client_secret,
        })
    }

    pub fn cache_key(&self) -> String {
        match self.auth_kind {
            AuthKind::UserToMachine => self.name.clone(),
            AuthKind::MachineToMachine => {
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
                    "{}-oauth-m2m-{:x}",
                    self.name,
                    Sha256::digest(identity.as_bytes())
                )
            }
        }
    }

    pub(crate) fn client_secret(&self) -> Option<&str> {
        self.client_secret.as_deref()
    }

    pub fn effective_scopes(&self) -> Vec<String> {
        let mut scopes = vec!["offline_access".to_owned()];
        for scope in &self.scopes {
            if !scopes.contains(scope) {
                scopes.push(scope.clone());
            }
        }
        scopes
    }

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
            .finish()
    }
}

/// Databricks profile overrides; debug output never includes the client secret.
#[derive(Clone)]
pub struct ProfileOptions {
    pub profile: Option<String>,
    pub host: Option<String>,
    pub account_id: Option<String>,
    pub workspace_id: Option<String>,
    pub client_id: Option<String>,
    /// M2M secret accepted by the Rust API and redacted from debug output.
    pub client_secret: Option<String>,
    /// Optional group role requested by M2M.
    pub group_id: Option<String>,
    /// Explicit Databricks auth type, such as `databricks-cli` or `oauth-m2m`.
    pub auth_type: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub target: Option<TargetKind>,
    pub config_file: Option<PathBuf>,
    /// Whether implicit M2M defaults should select one matching U2M profile.
    pub prefer_user_to_machine: bool,
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
            group_id: None,
            auth_type: None,
            scopes: None,
            target: None,
            config_file: None,
            prefer_user_to_machine: true,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct RawProfile {
    host: Option<String>,
    account_id: Option<String>,
    workspace_id: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    group_id: Option<String>,
    scopes: Option<String>,
    auth_type: Option<String>,
}

pub fn resolve_config_file(explicit: Option<&Path>) -> Result<PathBuf> {
    let path = explicit
        .map(PathBuf::from)
        .or_else(|| env_nonempty("DATABRICKS_CONFIG_FILE").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_FILE));
    expand_home(path)
}

fn expand_home(path: PathBuf) -> Result<PathBuf> {
    let value = path.to_string_lossy();
    if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        let home = UserDirs::new()
            .map(|dirs| dirs.home_dir().to_path_buf())
            .ok_or_else(|| Error::Config("cannot find home directory".into()))?;
        if value == "~" {
            return Ok(home);
        }
        return Ok(home.join(&value[2..]));
    }
    Ok(path)
}

fn load_config(path: &Path) -> Result<Option<Arc<Ini>>> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|error| Error::Config(format!("could not resolve profile path: {error}")))?
            .join(path)
    };
    let mut cache = CONFIG_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| Error::Config("Databricks profile cache lock is poisoned".into()))?;
    if let Some(cached) = cache.get(&path) {
        return cached_config(cached);
    }
    let loaded = if path.exists() {
        let mut ini = Ini::new_cs();
        match ini.load(&path) {
            Ok(_) => CachedConfig::Loaded(Arc::new(ini)),
            Err(error) => {
                CachedConfig::Invalid(format!("could not read {}: {error}", path.display()))
            }
        }
    } else {
        CachedConfig::Missing
    };
    let result = cached_config(&loaded);
    cache.insert(path, loaded);
    result
}

fn cached_config(cached: &CachedConfig) -> Result<Option<Arc<Ini>>> {
    match cached {
        CachedConfig::Loaded(config) => Ok(Some(Arc::clone(config))),
        CachedConfig::Missing => Ok(None),
        CachedConfig::Invalid(error) => Err(Error::Config(error.clone())),
    }
}

fn resolve_auth_profile_name(
    requested: Option<&str>,
    explicit: bool,
    config: Option<&Ini>,
    prefer_user_to_machine: bool,
) -> Result<String> {
    let selected = resolve_profile_name(requested, config)?;
    if explicit || !prefer_user_to_machine {
        return Ok(selected);
    }
    let Some(config) = config else {
        return Ok(selected);
    };
    let selected_profile = load_profile(config, &selected);
    if !is_m2m_profile(&selected_profile) {
        return Ok(selected);
    }
    if selected_profile.host.is_none() {
        return Ok(selected);
    };
    let mut matches = config
        .sections()
        .into_iter()
        .filter(|name| name != SETTINGS_SECTION && name != &selected)
        .filter(|name| {
            let profile = load_profile(config, name);
            profile.auth_type.as_deref().is_some_and(is_u2m_auth_type)
                && same_auth_target(&selected_profile, &profile)
        });
    let Some(profile) = matches.next() else {
        return Ok(selected);
    };
    if matches.next().is_some() {
        return Ok(selected);
    }
    Ok(profile)
}

fn is_u2m_auth_type(auth_type: &str) -> bool {
    auth_type == AUTH_TYPE_DATABRICKS_CLI
}

fn is_m2m_profile(profile: &RawProfile) -> bool {
    profile.auth_type.as_deref() == Some(AUTH_TYPE_M2M)
        || (profile.auth_type.is_none()
            && profile.client_id.is_some()
            && profile.client_secret.is_some())
}

fn same_auth_target(selected: &RawProfile, candidate: &RawProfile) -> bool {
    let hosts_match = selected
        .host
        .as_deref()
        .and_then(|host| normalize_host(host).ok())
        .zip(
            candidate
                .host
                .as_deref()
                .and_then(|host| normalize_host(host).ok()),
        )
        .is_some_and(|(selected, candidate)| selected == candidate);
    hosts_match
        && selected
            .account_id
            .as_ref()
            .is_none_or(|account_id| candidate.account_id.as_ref() == Some(account_id))
        && selected
            .workspace_id
            .as_ref()
            .is_none_or(|workspace_id| candidate.workspace_id.as_ref() == Some(workspace_id))
}

fn resolve_auth_kind(
    auth_type: Option<&str>,
    client_id: Option<&str>,
    client_secret: Option<&str>,
) -> Result<AuthKind> {
    match auth_type {
        Some(AUTH_TYPE_DATABRICKS_CLI) => Ok(AuthKind::UserToMachine),
        Some(AUTH_TYPE_M2M) => {
            if client_id.is_none() || client_secret.is_none() {
                return Err(Error::Config(
                    "oauth-m2m requires client_id and client_secret".into(),
                ));
            }
            Ok(AuthKind::MachineToMachine)
        }
        Some(auth_type) => Err(Error::Config(format!(
            "authentication type {auth_type} is not supported"
        ))),
        None if client_id.is_some() && client_secret.is_some() => Ok(AuthKind::MachineToMachine),
        None if client_secret.is_some() => Err(Error::Config(
            "oauth-m2m client_secret requires client_id".into(),
        )),
        None => Ok(AuthKind::UserToMachine),
    }
}

fn resolve_profile_name(requested: Option<&str>, config: Option<&Ini>) -> Result<String> {
    if let Some(profile) = requested {
        if profile == SETTINGS_SECTION {
            return Err(Error::Config(format!(
                "{SETTINGS_SECTION} is a reserved section name and cannot be used as a profile"
            )));
        }
        return Ok(profile.to_owned());
    }
    if let Some(profile) = config
        .and_then(|config| config.get(SETTINGS_SECTION, "default_profile"))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        if profile == SETTINGS_SECTION {
            return Err(Error::Config(format!(
                "{SETTINGS_SECTION} is a reserved section name and cannot be used as a profile"
            )));
        }
        return Ok(profile);
    }
    Ok("DEFAULT".to_owned())
}

fn load_profile(ini: &Ini, name: &str) -> RawProfile {
    RawProfile {
        host: ini.get(name, "host"),
        account_id: ini.get(name, "account_id"),
        workspace_id: ini.get(name, "workspace_id"),
        client_id: ini.get(name, "client_id"),
        client_secret: ini.get(name, "client_secret"),
        group_id: ini.get(name, "group_id"),
        scopes: ini.get(name, "scopes"),
        auth_type: ini
            .get(name, "auth_type")
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty()),
    }
}

fn normalize_host(value: &str) -> Result<Url> {
    let value = value.trim().trim_end_matches('/');
    let value = if value.starts_with("http://") || value.starts_with("https://") {
        value.to_owned()
    } else {
        format!("https://{value}")
    };
    let url = Url::parse(&value)?;
    if url.scheme() != "https"
        && url
            .host_str()
            .is_none_or(|host| host != "127.0.0.1" && host != "localhost")
    {
        return Err(Error::Config("Databricks host must use HTTPS".into()));
    }
    Ok(url)
}

fn env_nonempty(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn split_list(value: String) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_files_are_cached_by_absolute_path() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("databrickscfg");
        std::fs::write(&path, "[DEFAULT]\nhost = first.example\n").unwrap();

        let first = load_config(&path).unwrap().unwrap();
        assert_eq!(
            first.get("DEFAULT", "host").as_deref(),
            Some("first.example")
        );

        std::fs::write(&path, "[DEFAULT]\nhost = second.example\n").unwrap();
        let second = load_config(&path).unwrap().unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(
            second.get("DEFAULT", "host").as_deref(),
            Some("first.example")
        );
    }

    #[test]
    fn profile_option_debug_redacts_client_secrets() {
        let options = ProfileOptions {
            client_secret: Some("sensitive-client-secret".into()),
            ..ProfileOptions::default()
        };
        let debug = format!("{options:?}");
        assert!(!debug.contains("sensitive-client-secret"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn configured_default_precedes_legacy_default() {
        let mut config = Ini::new();
        config.set(SETTINGS_SECTION, "default_profile", Some("selected".into()));
        assert_eq!(
            resolve_profile_name(None, Some(&config)).unwrap(),
            "selected"
        );
    }

    #[test]
    fn default_is_the_legacy_fallback() {
        assert_eq!(resolve_profile_name(None, None).unwrap(), "DEFAULT");
    }

    #[test]
    fn settings_is_not_a_profile() {
        assert!(resolve_profile_name(Some(SETTINGS_SECTION), None).is_err());
    }

    #[test]
    fn reads_profile_auth_type() {
        let mut config = Ini::new();
        config.set("service", "auth_type", Some("oauth-m2m".into()));
        config.set("service", "client_id", Some("client".into()));
        config.set("service", "client_secret", Some("secret".into()));
        config.set("service", "group_id", Some("group".into()));
        let profile = load_profile(&config, "service");
        assert_eq!(profile.auth_type.as_deref(), Some("oauth-m2m"));
        assert_eq!(profile.client_id.as_deref(), Some("client"));
        assert_eq!(profile.client_secret.as_deref(), Some("secret"));
        assert_eq!(profile.group_id.as_deref(), Some("group"));
    }

    fn mixed_auth_config() -> Ini {
        let mut config = Ini::new_cs();
        config.set(SETTINGS_SECTION, "default_profile", Some("DEFAULT".into()));
        config.set("DEFAULT", "host", Some("https://workspace.example".into()));
        config.set("DEFAULT", "auth_type", Some("oauth-m2m".into()));
        config.set("FEVM-AWS", "host", Some("https://workspace.example".into()));
        config.set("FEVM-AWS", "auth_type", Some("databricks-cli".into()));
        config
    }

    #[test]
    fn implicit_m2m_default_maps_to_unique_u2m_profile_on_same_host() {
        let config = mixed_auth_config();
        assert_eq!(
            resolve_auth_profile_name(None, false, Some(&config), true).unwrap(),
            "FEVM-AWS"
        );
    }

    #[test]
    fn disabled_u2m_preference_keeps_the_m2m_default() {
        let config = mixed_auth_config();
        assert_eq!(
            resolve_auth_profile_name(None, false, Some(&config), false).unwrap(),
            "DEFAULT"
        );
    }

    #[test]
    fn implicit_credentials_without_auth_type_still_prefer_u2m() {
        let mut config = mixed_auth_config();
        config.remove_key("DEFAULT", "auth_type");
        config.set("DEFAULT", "client_id", Some("client".into()));
        config.set("DEFAULT", "client_secret", Some("secret".into()));
        assert_eq!(
            resolve_auth_profile_name(None, false, Some(&config), true).unwrap(),
            "FEVM-AWS"
        );
    }

    #[test]
    fn only_databricks_cli_is_u2m_compatible() {
        assert!(is_u2m_auth_type(AUTH_TYPE_DATABRICKS_CLI));
        assert!(!is_u2m_auth_type(AUTH_TYPE_M2M));
        assert!(!is_u2m_auth_type("external-browser"));
    }

    #[test]
    fn non_m2m_default_is_not_remapped() {
        let mut config = mixed_auth_config();
        config.set("DEFAULT", "auth_type", Some("pat".into()));
        assert_eq!(
            resolve_auth_profile_name(None, false, Some(&config), true).unwrap(),
            "DEFAULT"
        );
    }

    #[test]
    fn explicit_m2m_profile_is_not_remapped() {
        let config = mixed_auth_config();
        assert_eq!(
            resolve_auth_profile_name(Some("DEFAULT"), true, Some(&config), true).unwrap(),
            "DEFAULT"
        );
    }

    #[test]
    fn ambiguous_u2m_host_match_does_not_remap() {
        let mut config = mixed_auth_config();
        config.set(
            "FEVM-AWS-2",
            "host",
            Some("https://workspace.example".into()),
        );
        config.set("FEVM-AWS-2", "auth_type", Some("databricks-cli".into()));
        assert_eq!(
            resolve_auth_profile_name(None, false, Some(&config), true).unwrap(),
            "DEFAULT"
        );
    }

    #[test]
    fn different_host_does_not_remap() {
        let mut config = mixed_auth_config();
        config.set("FEVM-AWS", "host", Some("https://other.example".into()));
        assert_eq!(
            resolve_auth_profile_name(None, false, Some(&config), true).unwrap(),
            "DEFAULT"
        );
    }

    #[test]
    fn equivalent_hosts_match_after_normalization() {
        let mut config = mixed_auth_config();
        config.set("DEFAULT", "host", Some("workspace.example/".into()));
        config.set("FEVM-AWS", "host", Some("https://workspace.example".into()));
        assert_eq!(
            resolve_auth_profile_name(None, false, Some(&config), true).unwrap(),
            "FEVM-AWS"
        );
    }

    #[test]
    fn different_account_does_not_remap() {
        let mut config = mixed_auth_config();
        config.set("DEFAULT", "account_id", Some("account-a".into()));
        config.set("FEVM-AWS", "account_id", Some("account-b".into()));
        assert_eq!(
            resolve_auth_profile_name(None, false, Some(&config), true).unwrap(),
            "DEFAULT"
        );
    }

    #[test]
    fn resolves_explicit_and_default_m2m_credentials() {
        assert_eq!(
            resolve_auth_kind(Some(AUTH_TYPE_M2M), Some("client"), Some("secret")).unwrap(),
            AuthKind::MachineToMachine
        );
        assert_eq!(
            resolve_auth_kind(None, Some("client"), Some("secret")).unwrap(),
            AuthKind::MachineToMachine
        );
        assert_eq!(
            resolve_auth_kind(None, Some("client"), None).unwrap(),
            AuthKind::UserToMachine
        );
        assert!(resolve_auth_kind(Some(AUTH_TYPE_M2M), Some("client"), None).is_err());
        assert!(resolve_auth_kind(None, None, Some("secret")).is_err());
    }

    #[test]
    fn explicit_m2m_profile_builds_without_browser_auth() {
        let directory = tempfile::tempdir().unwrap();
        let profile = Profile::from_sources(ProfileOptions {
            profile: Some("service".into()),
            host: Some("http://127.0.0.1:8080".into()),
            client_id: Some("client".into()),
            client_secret: Some("secret".into()),
            auth_type: Some(AUTH_TYPE_M2M.into()),
            config_file: Some(directory.path().join("missing")),
            ..ProfileOptions::default()
        })
        .unwrap();
        assert_eq!(profile.auth_kind, AuthKind::MachineToMachine);
        assert_eq!(profile.client_secret(), Some("secret"));
    }

    #[test]
    fn client_credentials_inference_does_not_depend_on_profile_preference() {
        let directory = tempfile::tempdir().unwrap();
        let options = |prefer_user_to_machine| ProfileOptions {
            profile: Some("service".into()),
            host: Some("http://127.0.0.1:8080".into()),
            client_id: Some("client".into()),
            client_secret: Some("secret".into()),
            config_file: Some(directory.path().join("missing")),
            prefer_user_to_machine,
            ..ProfileOptions::default()
        };
        assert_eq!(
            Profile::from_sources(options(true)).unwrap().auth_kind,
            AuthKind::MachineToMachine
        );
        assert_eq!(
            Profile::from_sources(options(false)).unwrap().auth_kind,
            AuthKind::MachineToMachine
        );
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
        };
        let key = profile.cache_key();
        assert!(key.starts_with("service-oauth-m2m-"));
        assert!(!key.contains("credential-value"));
        assert!(!format!("{profile:?}").contains("credential-value"));
    }
}
