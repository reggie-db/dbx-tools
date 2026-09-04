use std::{env, path::PathBuf};

use configparser::ini::Ini;
use directories::UserDirs;
use url::Url;

use crate::{Error, Result};

pub const DEFAULT_CLIENT_ID: &str = "databricks-cli";
pub const DEFAULT_ACCOUNTS_HOST: &str = "https://accounts.cloud.databricks.com";
pub const DEFAULT_CONFIG_FILE: &str = "~/.databrickscfg";
const SETTINGS_SECTION: &str = "__settings__";
const AUTH_TYPE_DATABRICKS_CLI: &str = "databricks-cli";
const AUTH_TYPE_M2M: &str = "oauth-m2m";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TargetKind {
    #[default]
    Workspace,
    Account,
    Unified,
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub name: String,
    pub host: Url,
    pub account_id: Option<String>,
    pub workspace_id: Option<String>,
    pub client_id: String,
    pub scopes: Vec<String>,
    pub target: TargetKind,
}

impl Profile {
    pub fn from_sources(options: ProfileOptions) -> Result<Self> {
        let config_file = resolve_config_file(options.config_file.as_deref())?;
        let explicit_profile = options.profile.is_some();
        let requested_name = options
            .profile
            .or_else(|| env_nonempty("DATABRICKS_CONFIG_PROFILE"))
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let config = load_config(&config_file)?;
        let profile_name =
            resolve_u2m_profile_name(requested_name.as_deref(), explicit_profile, config.as_ref())?;
        let configured = config
            .as_ref()
            .map(|config| load_profile(config, &profile_name))
            .unwrap_or_default();
        if let Some(auth_type) = configured.auth_type.as_deref() {
            if !is_u2m_auth_type(auth_type) {
                return Err(Error::Config(format!(
                    "profile {profile_name} uses {auth_type} authentication; U2M requires auth_type = databricks-cli"
                )));
            }
        }

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
            .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_owned());
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
            scopes,
            target,
        })
    }

    pub fn cache_key(&self) -> &str {
        &self.name
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
}

#[derive(Clone, Debug, Default)]
pub struct ProfileOptions {
    pub profile: Option<String>,
    pub host: Option<String>,
    pub account_id: Option<String>,
    pub workspace_id: Option<String>,
    pub client_id: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub target: Option<TargetKind>,
    pub config_file: Option<PathBuf>,
}

#[derive(Clone, Debug, Default)]
struct RawProfile {
    host: Option<String>,
    account_id: Option<String>,
    workspace_id: Option<String>,
    scopes: Option<String>,
    auth_type: Option<String>,
}

pub fn resolve_config_file(explicit: Option<&std::path::Path>) -> Result<PathBuf> {
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

fn load_config(path: &std::path::Path) -> Result<Option<Ini>> {
    if !path.exists() {
        return Ok(None);
    }
    let mut ini = Ini::new_cs();
    ini.load(path)
        .map_err(|error| Error::Config(format!("could not read {}: {error}", path.display())))?;
    Ok(Some(ini))
}

fn resolve_u2m_profile_name(
    requested: Option<&str>,
    explicit: bool,
    config: Option<&Ini>,
) -> Result<String> {
    let selected = resolve_profile_name(requested, config)?;
    if explicit {
        return Ok(selected);
    }
    let Some(config) = config else {
        return Ok(selected);
    };
    let selected_profile = load_profile(config, &selected);
    if selected_profile.auth_type.as_deref() != Some(AUTH_TYPE_M2M) {
        return Ok(selected);
    }
    let Some(selected_host) = selected_profile.host.as_deref() else {
        return Ok(selected);
    };
    let mut matches = config
        .sections()
        .into_iter()
        .filter(|name| name != SETTINGS_SECTION && name != &selected)
        .filter(|name| {
            let profile = load_profile(config, name);
            profile.auth_type.as_deref().is_some_and(is_u2m_auth_type)
                && profile.host.as_deref() == Some(selected_host)
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
        scopes: ini.get(name, "scopes"),
        auth_type: ini
            .get(name, "auth_type")
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty()),
    }
}

pub(crate) fn configured_auth_storage(path: &std::path::Path) -> Result<Option<String>> {
    Ok(load_config(path)?
        .and_then(|config| config.get(SETTINGS_SECTION, "auth_storage"))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty()))
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
        assert_eq!(
            load_profile(&config, "service").auth_type.as_deref(),
            Some("oauth-m2m")
        );
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
            resolve_u2m_profile_name(None, false, Some(&config)).unwrap(),
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
            resolve_u2m_profile_name(None, false, Some(&config)).unwrap(),
            "DEFAULT"
        );
    }

    #[test]
    fn explicit_m2m_profile_is_not_remapped() {
        let config = mixed_auth_config();
        assert_eq!(
            resolve_u2m_profile_name(Some("DEFAULT"), true, Some(&config)).unwrap(),
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
            resolve_u2m_profile_name(None, false, Some(&config)).unwrap(),
            "DEFAULT"
        );
    }

    #[test]
    fn different_host_does_not_remap() {
        let mut config = mixed_auth_config();
        config.set("FEVM-AWS", "host", Some("https://other.example".into()));
        assert_eq!(
            resolve_u2m_profile_name(None, false, Some(&config)).unwrap(),
            "DEFAULT"
        );
    }
}
