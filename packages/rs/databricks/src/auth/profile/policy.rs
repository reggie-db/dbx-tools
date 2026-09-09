use std::{collections::HashMap, env};

use crate::{Error, Result};

use super::super::OBO_TOKEN_HEADER;
use super::{config_file::RawProfile, AuthKind, AUTH_TYPE_APP_OBO, AUTH_TYPE_APP_SP};

pub(super) const AUTH_TYPE_DATABRICKS_CLI: &str = "databricks-cli";
pub(super) const AUTH_TYPE_M2M: &str = "oauth-m2m";
pub(super) const AUTH_TYPE_PAT: &str = "pat";

pub(super) fn env_nonempty(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(super) fn ambient_credential(name: &str, ignore: bool) -> Option<String> {
    (!ignore).then(|| env_nonempty(name)).flatten()
}

pub(super) fn is_u2m_auth_type(auth_type: &str) -> bool {
    auth_type == AUTH_TYPE_DATABRICKS_CLI
}

pub(super) fn is_m2m_profile(profile: &RawProfile) -> bool {
    profile.auth_type.as_deref() == Some(AUTH_TYPE_M2M)
        || (profile.auth_type.is_none()
            && profile.client_id.is_some()
            && profile.client_secret.is_some())
}

pub(super) fn resolve_auth_kind(
    auth_type: Option<&str>,
    client_id: Option<&str>,
    client_secret: Option<&str>,
    access_token: Option<&str>,
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
        Some(AUTH_TYPE_PAT) => {
            if access_token.is_none() {
                return Err(Error::Config("pat requires token".into()));
            }
            Ok(AuthKind::PersonalAccessToken)
        }
        Some(AUTH_TYPE_APP_OBO) | Some("app-obo") => {
            if access_token.is_none() {
                return Err(Error::Config(
                    "app_obo requires x-forwarded-access-token".into(),
                ));
            }
            Ok(AuthKind::AppOnBehalfOf)
        }
        Some(AUTH_TYPE_APP_SP) | Some("app-sp") => {
            if client_id.is_none() || client_secret.is_none() {
                return Err(Error::Config(
                    "app_sp requires DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET".into(),
                ));
            }
            Ok(AuthKind::AppServicePrincipal)
        }
        Some(auth_type) => Err(Error::Config(format!(
            "authentication type {auth_type} is not supported"
        ))),
        None if client_id.is_some() && client_secret.is_some() => Ok(AuthKind::MachineToMachine),
        None if client_secret.is_some() => Err(Error::Config(
            "oauth-m2m client_secret requires client_id".into(),
        )),
        None if access_token.is_some() => Ok(AuthKind::PersonalAccessToken),
        None => Ok(AuthKind::UserToMachine),
    }
}

pub(in crate::auth) fn request_obo_token(
    headers: Option<&HashMap<String, String>>,
) -> Option<String> {
    headers?
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(OBO_TOKEN_HEADER))
        .map(|(_, value)| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(in crate::auth) fn app_service_principal_available() -> bool {
    [
        "DATABRICKS_HOST",
        "DATABRICKS_CLIENT_ID",
        "DATABRICKS_CLIENT_SECRET",
    ]
    .into_iter()
    .all(|name| {
        env::var(name)
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    })
}

pub(in crate::auth) fn resolve_app_auth_type(
    in_app: bool,
    explicit_profile: bool,
    explicit_auth_type: Option<&str>,
    has_obo_token: bool,
    has_service_principal: bool,
) -> Option<&'static str> {
    if !in_app || explicit_profile || explicit_auth_type.is_some() {
        return None;
    }
    if has_obo_token {
        Some(AUTH_TYPE_APP_OBO)
    } else if has_service_principal {
        Some(AUTH_TYPE_APP_SP)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_databricks_cli_is_u2m_compatible() {
        assert!(is_u2m_auth_type(AUTH_TYPE_DATABRICKS_CLI));
        assert!(!is_u2m_auth_type(AUTH_TYPE_M2M));
        assert!(!is_u2m_auth_type("external-browser"));
    }

    #[test]
    fn resolves_explicit_and_default_m2m_credentials() {
        assert_eq!(
            resolve_auth_kind(Some(AUTH_TYPE_M2M), Some("client"), Some("secret"), None,).unwrap(),
            AuthKind::MachineToMachine
        );
        assert_eq!(
            resolve_auth_kind(None, Some("client"), Some("secret"), None).unwrap(),
            AuthKind::MachineToMachine
        );
        assert_eq!(
            resolve_auth_kind(None, Some("client"), None, None).unwrap(),
            AuthKind::UserToMachine
        );
        assert_eq!(
            resolve_auth_kind(Some(AUTH_TYPE_PAT), None, None, Some("token")).unwrap(),
            AuthKind::PersonalAccessToken
        );
        assert_eq!(
            resolve_auth_kind(None, None, None, Some("token")).unwrap(),
            AuthKind::PersonalAccessToken
        );
        assert!(resolve_auth_kind(Some(AUTH_TYPE_M2M), Some("client"), None, None).is_err());
        assert!(resolve_auth_kind(Some(AUTH_TYPE_PAT), None, None, None).is_err());
        assert!(resolve_auth_kind(None, None, Some("secret"), None).is_err());
        assert_eq!(
            resolve_auth_kind(Some(AUTH_TYPE_APP_OBO), None, None, Some("request-token")).unwrap(),
            AuthKind::AppOnBehalfOf
        );
        assert_eq!(
            resolve_auth_kind(Some(AUTH_TYPE_APP_SP), Some("client"), Some("secret"), None)
                .unwrap(),
            AuthKind::AppServicePrincipal
        );
        assert!(resolve_auth_kind(Some(AUTH_TYPE_APP_OBO), None, None, None).is_err());
        assert!(resolve_auth_kind(Some(AUTH_TYPE_APP_SP), None, None, None).is_err());
    }

    #[test]
    fn app_auth_prefers_obo_then_service_principal() {
        assert_eq!(
            resolve_app_auth_type(true, false, None, true, true),
            Some(AUTH_TYPE_APP_OBO)
        );
        assert_eq!(
            resolve_app_auth_type(true, false, None, false, true),
            Some(AUTH_TYPE_APP_SP)
        );
        assert_eq!(resolve_app_auth_type(true, true, None, true, true), None);
        assert_eq!(
            resolve_app_auth_type(true, false, Some("pat"), true, true),
            None
        );
        assert_eq!(resolve_app_auth_type(false, false, None, true, true), None);
    }

    #[test]
    fn request_token_header_is_case_insensitive_and_blank_safe() {
        assert_eq!(
            request_obo_token(Some(&HashMap::from([(
                "X-Forwarded-Access-Token".to_owned(),
                " request-token ".to_owned(),
            )]))),
            Some("request-token".to_owned())
        );
        assert_eq!(
            request_obo_token(Some(&HashMap::from([(
                OBO_TOKEN_HEADER.to_owned(),
                " ".to_owned(),
            )]))),
            None
        );
    }
}
