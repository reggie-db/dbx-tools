mod client;
mod m2m;
mod oauth;
mod oauth_endpoints;
mod profile;
mod storage;

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use crate::{
    databricks_cli_available, is_databricks_app, AccessToken, AuthError as DatabricksAuthError,
    AuthOptions, AuthSession, BindingResult, CredentialStore, Storage, StorageHandle, Token,
};
pub use client::DatabricksAuthClient;
pub use m2m::MachineToMachineFlow;
pub use oauth::OAuthFlow;
pub use profile::{
    resolve_config_file, AuthKind, Profile, ProfileOptions, TargetKind, AUTH_TYPE_APP_OBO,
    AUTH_TYPE_APP_SP, DEFAULT_ACCOUNTS_HOST, DEFAULT_CLIENT_ID, DEFAULT_CONFIG_FILE,
};
pub use storage::{open_databricks_store, StoreOptions};

pub const OBO_TOKEN_HEADER: &str = "x-forwarded-access-token";

/// Configuration shared by the generated Node and Python auth bindings.
#[derive(Clone, uniffi::Record)]
pub struct DatabricksAuthOptions {
    /// Explicit profile name; explicit choices are never remapped to another profile.
    #[uniffi(default = None)]
    pub profile: Option<String>,
    /// Override the workspace or account host.
    #[uniffi(default = None)]
    pub host: Option<String>,
    /// Account identifier for account-scoped authentication.
    #[uniffi(default = None)]
    pub account_id: Option<String>,
    /// Workspace identifier for unified authentication.
    #[uniffi(default = None)]
    pub workspace_id: Option<String>,
    /// Override the Databricks CLI configuration file.
    #[uniffi(default = None)]
    pub config_file: Option<String>,
    /// Override the OAuth application identifier.
    #[uniffi(default = None)]
    pub client_id: Option<String>,
    /// Optional group role requested by M2M token generation.
    #[uniffi(default = None)]
    pub group_id: Option<String>,
    /// Explicit Databricks authentication strategy.
    #[uniffi(default = None)]
    pub auth_type: Option<String>,
    /// Override profile scopes; omission preserves profile/default scope resolution.
    #[uniffi(default = None)]
    pub scopes: Option<Vec<String>>,
    /// Target kind: workspace, account, or unified.
    #[uniffi(default = None)]
    pub target: Option<String>,
    /// Override the directory containing the shared CLI token cache.
    #[uniffi(default = None)]
    pub cache_dir: Option<String>,
    /// Shared lifecycle configuration; omission uses `AuthOptions::default()`.
    #[uniffi(default = None)]
    pub auth: Option<AuthOptions>,
    /// Whether implicit M2M defaults should select one matching U2M profile.
    #[uniffi(default = true)]
    pub prefer_user_to_machine: bool,
}

impl Default for DatabricksAuthOptions {
    fn default() -> Self {
        Self {
            profile: None,
            host: None,
            account_id: None,
            workspace_id: None,
            config_file: None,
            client_id: None,
            group_id: None,
            auth_type: None,
            scopes: None,
            target: None,
            cache_dir: None,
            auth: None,
            prefer_user_to_machine: true,
        }
    }
}

#[derive(Clone, uniffi::Record)]
/// Resolved Databricks identity and active storage backend.
pub struct DatabricksAuthStatus {
    pub profile: String,
    pub host: String,
    pub storage: Storage,
}

#[derive(uniffi::Object)]
/// Databricks binding facade over the shared persistent authentication lifecycle.
pub struct PersistentAuth {
    inner: PersistentAuthInner,
}

enum PersistentAuthInner {
    Managed(DatabricksAuthClient),
    AppOnBehalfOf { profile: Profile, token: Token },
}

#[uniffi::export(async_runtime = "tokio", default(storage = None))]
/// Resolve a Databricks profile and open built-in credential storage.
pub async fn create_persistent_auth(
    options: DatabricksAuthOptions,
    storage: Option<Storage>,
) -> BindingResult<Arc<PersistentAuth>> {
    create_persistent_auth_from_headers(options, storage, None).await
}

#[uniffi::export(async_runtime = "tokio", default(storage = None))]
/// Resolve authentication with the current Databricks App request headers.
pub async fn create_persistent_auth_for_request(
    options: DatabricksAuthOptions,
    request_headers: HashMap<String, String>,
    storage: Option<Storage>,
) -> BindingResult<Arc<PersistentAuth>> {
    create_persistent_auth_from_headers(options, storage, Some(&request_headers)).await
}

async fn create_persistent_auth_from_headers(
    options: DatabricksAuthOptions,
    storage: Option<Storage>,
    request_headers: Option<&HashMap<String, String>>,
) -> BindingResult<Arc<PersistentAuth>> {
    let in_app = is_databricks_app();
    let profile = resolve_profile(&options, in_app, request_headers)?;
    let use_databricks_cli = should_use_databricks_cli(
        profile.auth_kind,
        storage,
        in_app,
        databricks_cli_available(),
    );
    let backend = storage_backend(storage, in_app);
    let store = open_binding_store(&options, backend).await?;
    create_persistent_auth_with_store(options, profile, store, use_databricks_cli).await
}

#[uniffi::export(async_runtime = "tokio")]
/// Resolve a Databricks profile using a shared owning-library storage handle.
pub async fn create_persistent_auth_with_storage(
    options: DatabricksAuthOptions,
    storage: Arc<StorageHandle>,
) -> BindingResult<Arc<PersistentAuth>> {
    let profile = resolve_profile(&options, is_databricks_app(), None)?;
    create_persistent_auth_with_store(options, profile, storage.store.clone(), false).await
}

async fn create_persistent_auth_with_store(
    options: DatabricksAuthOptions,
    profile: Profile,
    store: Arc<dyn CredentialStore>,
    use_databricks_cli: bool,
) -> BindingResult<Arc<PersistentAuth>> {
    if profile.auth_kind == AuthKind::AppOnBehalfOf {
        let token = Token {
            access_token: profile
                .access_token()
                .ok_or_else(|| DatabricksAuthError::Failure {
                    message: "app_obo requires x-forwarded-access-token".into(),
                })?
                .to_owned(),
            token_type: "Bearer".into(),
            refresh_token: None,
            expires_at: None,
            scopes: profile.scopes.clone(),
        };
        return Ok(Arc::new(PersistentAuth {
            inner: PersistentAuthInner::AppOnBehalfOf { profile, token },
        }));
    }
    let inner = DatabricksAuthClient::new(
        profile,
        store,
        options.auth.unwrap_or_default(),
        use_databricks_cli,
    )
    .map_err(binding_error)?;
    Ok(Arc::new(PersistentAuth {
        inner: PersistentAuthInner::Managed(inner),
    }))
}

fn should_use_databricks_cli(
    auth_kind: AuthKind,
    storage: Option<Storage>,
    in_app: bool,
    available: bool,
) -> bool {
    auth_kind == AuthKind::UserToMachine
        && !in_app
        && available
        && storage.is_none_or(|storage| storage == Storage::Auto)
}

fn storage_backend(storage: Option<Storage>, in_app: bool) -> Storage {
    match storage {
        Some(Storage::Memory) => Storage::Memory,
        Some(Storage::File) => Storage::File,
        Some(Storage::Auto) | None if in_app => Storage::Memory,
        Some(Storage::Auto) | None => Storage::File,
    }
}

fn resolve_profile(
    options: &DatabricksAuthOptions,
    in_app: bool,
    request_headers: Option<&HashMap<String, String>>,
) -> BindingResult<Profile> {
    let explicit_profile = options.profile.is_some()
        || std::env::var("DATABRICKS_CONFIG_PROFILE")
            .ok()
            .is_some_and(|profile| !profile.trim().is_empty());
    let explicit_auth_type = options
        .auth_type
        .clone()
        .or_else(|| {
            (!in_app)
                .then(|| std::env::var("DATABRICKS_AUTH_TYPE").ok())
                .flatten()
        })
        .map(|auth_type| auth_type.trim().to_ascii_lowercase())
        .filter(|auth_type| !auth_type.is_empty());
    let request_token = request_obo_token(request_headers);
    let auth_type = resolve_app_auth_type(
        in_app,
        explicit_profile,
        explicit_auth_type.as_deref(),
        request_token.is_some(),
        app_service_principal_available(),
    )
    .map(str::to_owned)
    .or(explicit_auth_type);
    let app_auth = matches!(
        auth_type.as_deref(),
        Some(AUTH_TYPE_APP_OBO | "app-obo" | AUTH_TYPE_APP_SP | "app-sp")
    );
    Profile::from_sources(ProfileOptions {
        profile: options.profile.clone(),
        host: options.host.clone(),
        account_id: options.account_id.clone(),
        workspace_id: options.workspace_id.clone(),
        client_id: options.client_id.clone(),
        client_secret: None,
        access_token: matches!(auth_type.as_deref(), Some(AUTH_TYPE_APP_OBO | "app-obo"))
            .then_some(request_token)
            .flatten(),
        group_id: options.group_id.clone(),
        auth_type,
        scopes: options.scopes.clone(),
        target: options.target.as_deref().map(parse_target).transpose()?,
        config_file: options.config_file.as_deref().map(PathBuf::from),
        prefer_user_to_machine: options.prefer_user_to_machine,
        skip_implicit_pat: in_app,
        ignore_ambient_credentials: in_app && explicit_profile && !app_auth,
        ignore_ambient_auth_type: in_app,
    })
    .map_err(binding_error)
}

fn request_obo_token(headers: Option<&HashMap<String, String>>) -> Option<String> {
    headers?
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(OBO_TOKEN_HEADER))
        .map(|(_, value)| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn app_service_principal_available() -> bool {
    [
        "DATABRICKS_HOST",
        "DATABRICKS_CLIENT_ID",
        "DATABRICKS_CLIENT_SECRET",
    ]
    .into_iter()
    .all(|name| {
        std::env::var(name)
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    })
}

fn resolve_app_auth_type(
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

#[uniffi::export(async_runtime = "tokio")]
impl PersistentAuth {
    /// Start an explicit login and persist the resulting credential.
    pub async fn challenge(&self) -> BindingResult<()> {
        match &self.inner {
            PersistentAuthInner::Managed(inner) => {
                inner.login().await.map(|_| ()).map_err(binding_error)
            }
            PersistentAuthInner::AppOnBehalfOf { .. } => Err(DatabricksAuthError::Failure {
                message: "app_obo uses the current request token and cannot start login".into(),
            }),
        }
    }

    /// True forces login, false forbids interactive login, and omission permits missing-token login.
    #[uniffi::method(default(login = None))]
    pub async fn token(&self, login: Option<bool>) -> BindingResult<AccessToken> {
        match &self.inner {
            PersistentAuthInner::Managed(inner) => inner
                .token_with_login(login)
                .await
                .map(Into::into)
                .map_err(binding_error),
            PersistentAuthInner::AppOnBehalfOf { token, .. } => Ok(token.clone().into()),
        }
    }

    /// Renew the stored credential even before its refresh window.
    pub async fn force_refresh_token(&self) -> BindingResult<AccessToken> {
        match &self.inner {
            PersistentAuthInner::Managed(inner) => inner
                .force_refresh()
                .await
                .map(Into::into)
                .map_err(binding_error),
            PersistentAuthInner::AppOnBehalfOf { token, .. } => Ok(token.clone().into()),
        }
    }

    /// Reuse another caller's replacement or renew the rejected token.
    pub async fn refresh_rejected_token(
        &self,
        stale_access_token: String,
    ) -> BindingResult<AccessToken> {
        match &self.inner {
            PersistentAuthInner::Managed(inner) => inner
                .refresh_rejected_token(&stale_access_token)
                .await
                .map(Into::into)
                .map_err(binding_error),
            PersistentAuthInner::AppOnBehalfOf { token, .. } => Ok(token.clone().into()),
        }
    }

    /// Delete the credential while holding the store's refresh lock.
    pub async fn logout(&self) -> BindingResult<()> {
        match &self.inner {
            PersistentAuthInner::Managed(inner) => inner.logout().await.map_err(binding_error),
            PersistentAuthInner::AppOnBehalfOf { .. } => Ok(()),
        }
    }

    /// Return the resolved identity and active built-in storage backend.
    pub fn status(&self) -> DatabricksAuthStatus {
        match &self.inner {
            PersistentAuthInner::Managed(inner) => DatabricksAuthStatus {
                profile: inner.profile().name.clone(),
                host: inner.profile().host.to_string(),
                storage: storage_from_name(inner.store_name()),
            },
            PersistentAuthInner::AppOnBehalfOf { profile, .. } => DatabricksAuthStatus {
                profile: profile.name.clone(),
                host: profile.host.to_string(),
                storage: Storage::Memory,
            },
        }
    }
}

async fn open_binding_store(
    options: &DatabricksAuthOptions,
    storage: Storage,
) -> BindingResult<Arc<dyn CredentialStore>> {
    open_databricks_store(StoreOptions {
        backend: Some(storage),
        cache_dir: options.cache_dir.as_deref().map(PathBuf::from),
    })
    .await
    .map_err(binding_error)
}

fn parse_target(value: &str) -> BindingResult<TargetKind> {
    match value.trim().to_ascii_lowercase().as_str() {
        "workspace" => Ok(TargetKind::Workspace),
        "account" => Ok(TargetKind::Account),
        "unified" => Ok(TargetKind::Unified),
        _ => Err(DatabricksAuthError::Failure {
            message: "target must be workspace, account, or unified".into(),
        }),
    }
}

fn storage_from_name(name: &str) -> Storage {
    match name {
        "memory" => Storage::Memory,
        _ => Storage::File,
    }
}

fn binding_error(error: impl std::fmt::Display) -> DatabricksAuthError {
    DatabricksAuthError::Failure {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_refresh_requires_available_automatic_u2m() {
        assert!(should_use_databricks_cli(
            AuthKind::UserToMachine,
            None,
            false,
            true
        ));
        assert!(should_use_databricks_cli(
            AuthKind::UserToMachine,
            Some(Storage::Auto),
            false,
            true
        ));
        assert!(!should_use_databricks_cli(
            AuthKind::UserToMachine,
            Some(Storage::File),
            false,
            true
        ));
        assert!(!should_use_databricks_cli(
            AuthKind::UserToMachine,
            Some(Storage::Memory),
            false,
            true
        ));
        assert!(!should_use_databricks_cli(
            AuthKind::MachineToMachine,
            None,
            false,
            true
        ));
        assert!(!should_use_databricks_cli(
            AuthKind::PersonalAccessToken,
            None,
            false,
            true
        ));
        assert!(!should_use_databricks_cli(
            AuthKind::UserToMachine,
            None,
            false,
            false
        ));
        assert!(!should_use_databricks_cli(
            AuthKind::UserToMachine,
            None,
            true,
            true
        ));
    }

    #[test]
    fn automatic_storage_tracks_the_runtime_and_explicit_storage_is_preserved() {
        assert_eq!(storage_backend(None, false), Storage::File);
        assert_eq!(storage_backend(Some(Storage::Auto), false), Storage::File);
        assert_eq!(storage_backend(None, true), Storage::Memory);
        assert_eq!(storage_backend(Some(Storage::Auto), true), Storage::Memory);
        assert_eq!(storage_backend(Some(Storage::File), true), Storage::File);
        assert_eq!(
            storage_backend(Some(Storage::Memory), true),
            Storage::Memory
        );
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

    #[tokio::test]
    async fn app_obo_returns_the_request_token_without_a_store() {
        let auth = PersistentAuth {
            inner: PersistentAuthInner::AppOnBehalfOf {
                profile: Profile {
                    name: "app-request".into(),
                    host: url::Url::parse("https://workspace.example").unwrap(),
                    account_id: None,
                    workspace_id: None,
                    client_id: String::new(),
                    group_id: None,
                    scopes: vec![],
                    target: TargetKind::Workspace,
                    auth_kind: AuthKind::AppOnBehalfOf,
                    client_secret: None,
                    access_token: Some("request-token".into()),
                },
                token: Token {
                    access_token: "request-token".into(),
                    token_type: "Bearer".into(),
                    refresh_token: None,
                    expires_at: None,
                    scopes: vec![],
                },
            },
        };

        assert_eq!(
            auth.token(None).await.unwrap().access_token,
            "request-token"
        );
        assert_eq!(
            auth.refresh_rejected_token("request-token".into())
                .await
                .unwrap()
                .access_token,
            "request-token"
        );
    }
}
