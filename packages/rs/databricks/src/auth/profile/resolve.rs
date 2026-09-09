use configparser::ini::Ini;
use url::Url;

use crate::{Error, Result};

use super::{
    config_file::{load_config, load_profile, RawProfile},
    policy::{
        ambient_credential, env_nonempty, is_m2m_profile, is_u2m_auth_type, resolve_auth_kind,
        AUTH_TYPE_PAT,
    },
    resolve_config_file, AuthKind, Profile, ProfileOptions, TargetKind, DEFAULT_CLIENT_ID,
    SETTINGS_SECTION,
};

impl Profile {
    /// Resolve options, environment variables, and Databricks CLI configuration into a profile.
    pub fn from_sources(options: ProfileOptions) -> Result<Self> {
        let ignore_ambient_credentials = options.ignore_ambient_credentials;
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
        let configured = configured_profile(
            config.as_deref(),
            &profile_name,
            options.skip_implicit_pat && !explicit_profile,
        );

        let host = options
            .host
            .or_else(|| ambient_credential("DATABRICKS_HOST", ignore_ambient_credentials))
            .or(configured.host)
            .ok_or_else(|| Error::Config(format!("profile {profile_name} has no host")))?;
        let host = normalize_host(&host)?;
        let account_id = options
            .account_id
            .or_else(|| ambient_credential("DATABRICKS_ACCOUNT_ID", ignore_ambient_credentials))
            .or(configured.account_id);
        let workspace_id = options
            .workspace_id
            .or_else(|| ambient_credential("DATABRICKS_WORKSPACE_ID", ignore_ambient_credentials))
            .or(configured.workspace_id);
        let client_id = options
            .client_id
            .or_else(|| ambient_credential("DATABRICKS_CLIENT_ID", ignore_ambient_credentials))
            .or(configured.client_id);
        let client_secret = options
            .client_secret
            .or_else(|| ambient_credential("DATABRICKS_CLIENT_SECRET", ignore_ambient_credentials))
            .or(configured.client_secret);
        let access_token = options
            .access_token
            .or_else(|| ambient_credential("DATABRICKS_TOKEN", ignore_ambient_credentials))
            .or(configured.access_token)
            .filter(|token| !token.is_empty());
        let group_id = options
            .group_id
            .or_else(|| ambient_credential("DATABRICKS_GROUP_ID", ignore_ambient_credentials))
            .or(configured.group_id);
        let auth_type = options
            .auth_type
            .or_else(|| {
                ambient_credential(
                    "DATABRICKS_AUTH_TYPE",
                    options.ignore_ambient_auth_type || ignore_ambient_credentials,
                )
            })
            .or(configured.auth_type);
        let auth_kind = resolve_auth_kind(
            auth_type.as_deref(),
            client_id.as_deref(),
            client_secret.as_deref(),
            access_token.as_deref(),
        )?;
        let client_id = match auth_kind {
            AuthKind::UserToMachine => client_id.unwrap_or_else(|| DEFAULT_CLIENT_ID.to_owned()),
            AuthKind::MachineToMachine => client_id.ok_or_else(|| {
                Error::Config(format!(
                    "profile {profile_name} requires client_id for oauth-m2m"
                ))
            })?,
            AuthKind::AppServicePrincipal => client_id.ok_or_else(|| {
                Error::Config(format!(
                    "profile {profile_name} requires client_id for app_sp"
                ))
            })?,
            AuthKind::PersonalAccessToken | AuthKind::AppOnBehalfOf => {
                client_id.unwrap_or_default()
            }
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
            access_token,
        })
    }
}

fn configured_profile(config: Option<&Ini>, name: &str, skip_pat: bool) -> RawProfile {
    let configured = config
        .map(|config| load_profile(config, name))
        .unwrap_or_default();
    if skip_pat
        && (configured.auth_type.as_deref() == Some(AUTH_TYPE_PAT)
            || configured.access_token.is_some())
    {
        RawProfile::default()
    } else {
        configured
    }
}

fn resolve_auth_profile_name(
    requested: Option<&str>,
    explicit: bool,
    config: Option<&Ini>,
    prefer_user_to_machine: bool,
) -> Result<String> {
    let selected = resolve_profile_name(requested, config)?;
    if explicit {
        return Ok(selected);
    }
    let Some(config) = config else {
        return Ok(selected);
    };
    let selected_profile = load_profile(config, &selected);
    if !is_m2m_profile(&selected_profile) || !prefer_user_to_machine {
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
    use super::super::policy::{AUTH_TYPE_DATABRICKS_CLI, AUTH_TYPE_M2M, AUTH_TYPE_PAT};
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

    fn mixed_auth_config() -> Ini {
        let mut config = Ini::new_cs();
        config.set(SETTINGS_SECTION, "default_profile", Some("DEFAULT".into()));
        config.set("DEFAULT", "host", Some("https://workspace.example".into()));
        config.set("DEFAULT", "auth_type", Some("oauth-m2m".into()));
        config.set("FEVM-AWS", "host", Some("https://workspace.example".into()));
        config.set(
            "FEVM-AWS",
            "auth_type",
            Some(AUTH_TYPE_DATABRICKS_CLI.into()),
        );
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
    fn implicit_pat_default_is_not_remapped() {
        let mut config = mixed_auth_config();
        config.set("DEFAULT", "auth_type", Some(AUTH_TYPE_PAT.into()));
        for prefer_user_to_machine in [true, false] {
            assert_eq!(
                resolve_auth_profile_name(None, false, Some(&config), prefer_user_to_machine,)
                    .unwrap(),
                "DEFAULT"
            );
        }
    }

    #[test]
    fn implicit_pat_configuration_can_be_skipped() {
        let mut config = Ini::new_cs();
        config.set("DEFAULT", "host", Some("https://workspace.example".into()));
        config.set("DEFAULT", "auth_type", Some(AUTH_TYPE_PAT.into()));
        config.set("DEFAULT", "token", Some("access".into()));

        let configured = configured_profile(Some(&config), "DEFAULT", false);
        assert_eq!(configured.auth_type.as_deref(), Some(AUTH_TYPE_PAT));
        assert_eq!(configured.access_token.as_deref(), Some("access"));

        let skipped = configured_profile(Some(&config), "DEFAULT", true);
        assert!(skipped.auth_type.is_none());
        assert!(skipped.access_token.is_none());

        config.remove_key("DEFAULT", "auth_type");
        let inferred = configured_profile(Some(&config), "DEFAULT", true);
        assert!(inferred.access_token.is_none());
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
        config.set(
            "FEVM-AWS-2",
            "auth_type",
            Some(AUTH_TYPE_DATABRICKS_CLI.into()),
        );
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
    fn account_host_with_account_id_infers_account_target() {
        let directory = tempfile::tempdir().unwrap();
        let profile = Profile::from_sources(ProfileOptions {
            profile: Some("account".into()),
            host: Some("https://accounts.cloud.databricks.com".into()),
            account_id: Some("account-id".into()),
            config_file: Some(directory.path().join("missing")),
            ignore_ambient_credentials: true,
            ignore_ambient_auth_type: true,
            ..ProfileOptions::default()
        })
        .unwrap();
        assert_eq!(profile.target, TargetKind::Account);
    }
}
