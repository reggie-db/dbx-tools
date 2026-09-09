use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use configparser::ini::Ini;
use directories::UserDirs;

use crate::{Error, Result};

use super::{DEFAULT_CONFIG_FILE, SETTINGS_SECTION};

static CONFIG_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedConfig>>> = OnceLock::new();

#[derive(Clone)]
enum CachedConfig {
    Loaded(Arc<Ini>),
    Missing,
    Invalid(String),
}

#[derive(Clone, Debug, Default)]
pub(super) struct RawProfile {
    pub(super) host: Option<String>,
    pub(super) account_id: Option<String>,
    pub(super) workspace_id: Option<String>,
    pub(super) client_id: Option<String>,
    pub(super) client_secret: Option<String>,
    pub(super) access_token: Option<String>,
    pub(super) group_id: Option<String>,
    pub(super) scopes: Option<String>,
    pub(super) auth_type: Option<String>,
}

/// Resolve the Databricks CLI configuration file path and expand its home directory.
pub fn resolve_config_file(explicit: Option<&Path>) -> Result<PathBuf> {
    let path = explicit
        .map(PathBuf::from)
        .or_else(|| env_nonempty("DATABRICKS_CONFIG_FILE").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_FILE));
    expand_home(path)
}

/// Return whether a named profile exists in the selected Databricks CLI configuration file.
pub fn config_profile_exists(profile: &str, config_file: Option<&Path>) -> Result<bool> {
    if profile.trim().is_empty() || profile == SETTINGS_SECTION {
        return Ok(false);
    }
    let path = resolve_config_file(config_file)?;
    Ok(load_config(&path)?
        .as_deref()
        .is_some_and(|config| config.sections().iter().any(|name| name == profile)))
}

pub(super) fn load_config(path: &Path) -> Result<Option<Arc<Ini>>> {
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

pub(super) fn load_profile(ini: &Ini, name: &str) -> RawProfile {
    RawProfile {
        host: ini.get(name, "host"),
        account_id: ini.get(name, "account_id"),
        workspace_id: ini.get(name, "workspace_id"),
        client_id: ini.get(name, "client_id"),
        client_secret: ini.get(name, "client_secret"),
        access_token: ini.get(name, "token"),
        group_id: ini.get(name, "group_id"),
        scopes: ini.get(name, "scopes"),
        auth_type: ini
            .get(name, "auth_type")
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty()),
    }
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

fn cached_config(cached: &CachedConfig) -> Result<Option<Arc<Ini>>> {
    match cached {
        CachedConfig::Loaded(config) => Ok(Some(Arc::clone(config))),
        CachedConfig::Missing => Ok(None),
        CachedConfig::Invalid(error) => Err(Error::Config(error.clone())),
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
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
    fn missing_profile_files_are_cached() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing");

        assert!(load_config(&path).unwrap().is_none());
        std::fs::write(&path, "[DEFAULT]\nhost = workspace.example\n").unwrap();
        assert!(load_config(&path).unwrap().is_none());
    }

    #[test]
    fn profile_file_errors_are_cached() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("unreadable");
        std::fs::create_dir(&path).unwrap();

        let first = load_config(&path).unwrap_err().to_string();
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, "[DEFAULT]\nhost = workspace.example\n").unwrap();
        let second = load_config(&path).unwrap_err().to_string();
        assert_eq!(first, second);
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
}
