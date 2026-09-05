use crate::{
    AccessToken, AuthClient, AuthError, AuthOptions, AuthSession, BindingResult, CredentialStore,
    FileLayout, OAuthConfig, OAuthFlow, OAuthTemplate, Result, Storage, StorageHandle, Token,
    TokenProvider,
};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc, time::Duration};

#[derive(Clone, Copy, Debug, Default, uniffi::Enum)]
/// OAuth grant used to acquire and renew credentials.
pub enum OAuthGrant {
    #[default]
    AuthorizationCode,
    ClientCredentials,
}

/// Provider-specific OAuth identity, endpoints, storage, and shared lifecycle options.
#[derive(Clone, uniffi::Record)]
pub struct ProviderOptions {
    /// Stable provider identity used to isolate stored credentials.
    pub provider: String,
    /// OAuth application identifier.
    pub client_id: String,
    /// Provider's token exchange endpoint.
    pub token_endpoint: String,
    /// Required browser authorization endpoint for authorization-code grants.
    #[uniffi(default = None)]
    pub authorization_endpoint: Option<String>,
    /// Secret for confidential clients; never returned in access-token results.
    #[uniffi(default = None)]
    pub client_secret: Option<String>,
    /// Optional namespace for multiple accounts under one provider.
    #[uniffi(default = None)]
    pub profile: Option<String>,
    /// Requested scopes, trimmed, sorted, and deduplicated before use.
    #[uniffi(default = [])]
    pub scopes: Vec<String>,
    /// Defaults to authorization code with PKCE when omitted.
    #[uniffi(default = None)]
    pub grant: Option<OAuthGrant>,
    /// Override the provider-neutral credential directory.
    #[uniffi(default = None)]
    pub cache_dir: Option<String>,
    /// Select a built-in store; omission uses file storage.
    #[uniffi(default = None)]
    pub storage: Option<Storage>,
    /// Select a shared cache file or independent credential files.
    #[uniffi(default = None)]
    pub file_layout: Option<FileLayout>,
    /// Shared lifecycle configuration; omission uses `AuthOptions::default()`.
    #[uniffi(default = None)]
    pub auth: Option<AuthOptions>,
}

#[uniffi::export]
/// Trim, sort, and deduplicate scopes for requests and credential identities.
pub fn canonical_scopes(scopes: Vec<String>) -> Vec<String> {
    let mut scopes: Vec<_> = scopes
        .into_iter()
        .map(|scope| scope.trim().to_owned())
        .filter(|scope| !scope.is_empty())
        .collect();
    scopes.sort();
    scopes.dedup();
    scopes
}

#[uniffi::export]
/// Derive a stable provider/profile/scope-set identity without storing raw scopes in the key.
pub fn credential_key(provider: String, profile: Option<String>, scopes: Vec<String>) -> String {
    let scope_hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical_scopes(scopes)).expect("strings serialize"))
    );
    serde_json::to_string(&(provider, profile, scope_hash)).expect("strings serialize")
}

struct ProviderFlow {
    flow: OAuthFlow,
    grant: OAuthGrant,
}

#[async_trait::async_trait]
impl TokenProvider for ProviderFlow {
    async fn authenticate(&self, timeout: Duration) -> Result<Token> {
        match self.grant {
            OAuthGrant::AuthorizationCode => self.flow.login(timeout).await,
            OAuthGrant::ClientCredentials => self.flow.client_credentials().await,
        }
    }
    async fn refresh(&self, token: &Token) -> Result<Token> {
        match self.grant {
            OAuthGrant::AuthorizationCode => self.flow.refresh(token).await,
            OAuthGrant::ClientCredentials => self.flow.client_credentials().await,
        }
    }
    fn can_authenticate_silently(&self) -> bool {
        matches!(self.grant, OAuthGrant::ClientCredentials)
    }
}

#[derive(uniffi::Object)]
/// Generic OAuth provider using the shared persistent credential lifecycle.
pub struct ProviderAuth {
    inner: AuthClient,
}

fn failure(error: impl std::fmt::Display) -> AuthError {
    AuthError::Failure {
        message: error.to_string(),
    }
}

fn create(
    options: ProviderOptions,
    store: Arc<dyn CredentialStore>,
) -> BindingResult<Arc<ProviderAuth>> {
    let auth = options.auth.unwrap_or_default();
    if options.provider.trim().is_empty() {
        return Err(failure("provider must not be empty"));
    }
    let grant = options.grant.unwrap_or_default();
    if matches!(grant, OAuthGrant::AuthorizationCode) && options.authorization_endpoint.is_none() {
        return Err(failure(
            "authorization-code grants require an authorization endpoint",
        ));
    }
    let scopes = canonical_scopes(options.scopes);
    let key = credential_key(options.provider.clone(), options.profile, scopes.clone());
    let flow = OAuthFlow::new(OAuthConfig {
        provider: options.provider,
        authorization_endpoint: options
            .authorization_endpoint
            .unwrap_or_else(|| options.token_endpoint.clone()),
        token_endpoint: options.token_endpoint,
        client_id: options.client_id,
        client_secret: options.client_secret,
        scopes,
        extra_token_params: vec![],
        host: None,
    })
    .map_err(failure)?
    .with_template(OAuthTemplate::new(auth.callback_image_src.clone()));
    let inner = AuthClient::new(key, Arc::new(ProviderFlow { flow, grant }), store, auth);
    Ok(Arc::new(ProviderAuth { inner }))
}

#[uniffi::export(async_runtime = "tokio")]
/// Construct a provider with built-in persistent storage and shared lifecycle defaults.
pub async fn create_provider_auth(options: ProviderOptions) -> BindingResult<Arc<ProviderAuth>> {
    let directory = match &options.cache_dir {
        Some(directory) => PathBuf::from(directory),
        None => directories::UserDirs::new()
            .ok_or_else(|| failure("could not resolve the user home directory"))?
            .home_dir()
            .join(".dbx-tools/auth"),
    };
    let store = crate::open_store(
        options.storage.unwrap_or_default(),
        directory,
        options.file_layout.unwrap_or_default(),
    )
    .await
    .map_err(failure)?;
    create(options, store)
}

#[uniffi::export(async_runtime = "tokio")]
/// Construct a provider from the same owning-library storage handle used by Databricks auth.
pub async fn create_provider_auth_with_storage(
    options: ProviderOptions,
    storage: Arc<StorageHandle>,
) -> BindingResult<Arc<ProviderAuth>> {
    create(options, storage.store.clone())
}

#[uniffi::export(async_runtime = "tokio")]
impl ProviderAuth {
    /// True forces login, false forbids interactive login, and omission permits missing-token login.
    #[uniffi::method(default(login = None))]
    pub async fn token(&self, login: Option<bool>) -> BindingResult<AccessToken> {
        self.inner
            .token_with_login(login)
            .await
            .map(Into::into)
            .map_err(failure)
    }
    /// Renew the credential even if it has not entered its refresh window.
    pub async fn force_refresh_token(&self) -> BindingResult<AccessToken> {
        self.inner
            .force_refresh()
            .await
            .map(Into::into)
            .map_err(failure)
    }
    /// Reuse a concurrent replacement or renew the rejected access token.
    pub async fn refresh_rejected_token(
        &self,
        stale_access_token: String,
    ) -> BindingResult<AccessToken> {
        self.inner
            .refresh_rejected_token(&stale_access_token)
            .await
            .map(Into::into)
            .map_err(failure)
    }
    /// Delete the stored credential while holding its refresh lock.
    pub async fn logout(&self) -> BindingResult<()> {
        self.inner.logout().await.map_err(failure)
    }
}
