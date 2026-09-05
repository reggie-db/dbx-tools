use crate::{
    AccessToken, AuthClient, AuthError, AuthOptions, BindingResult, CredentialStore, FileLayout,
    ForeignStore, OAuthConfig, OAuthFlow, OAuthTemplate, Result, Storage, StorageAdapter, Token,
    TokenProvider,
};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc, time::Duration};

#[derive(Clone, Copy, Debug, Default, uniffi::Enum)]
pub enum OAuthGrant {
    #[default]
    AuthorizationCode,
    ClientCredentials,
}

#[derive(Clone, uniffi::Record)]
pub struct ProviderOptions {
    pub provider: String,
    pub client_id: String,
    pub token_endpoint: String,
    #[uniffi(default = None)]
    pub authorization_endpoint: Option<String>,
    #[uniffi(default = None)]
    pub client_secret: Option<String>,
    #[uniffi(default = None)]
    pub profile: Option<String>,
    #[uniffi(default = [])]
    pub scopes: Vec<String>,
    #[uniffi(default = None)]
    pub grant: Option<OAuthGrant>,
    #[uniffi(default = None)]
    pub cache_dir: Option<String>,
    #[uniffi(default = None)]
    pub keyring_service: Option<String>,
    #[uniffi(default = None)]
    pub storage: Option<Storage>,
    #[uniffi(default = None)]
    pub file_layout: Option<FileLayout>,
    #[uniffi(default = None)]
    pub callback_image_src: Option<String>,
    #[uniffi(default = 30)]
    pub lock_timeout_seconds: u64,
    #[uniffi(default = 3600)]
    pub login_timeout_seconds: u64,
    #[uniffi(default = 300)]
    pub refresh_buffer_seconds: i64,
}

#[uniffi::export]
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
    .with_template(OAuthTemplate::new(options.callback_image_src.clone()));
    let inner = AuthClient::new(
        key,
        Arc::new(ProviderFlow { flow, grant }),
        store,
        AuthOptions {
            refresh_buffer: time::Duration::seconds(options.refresh_buffer_seconds),
            lock_timeout: Duration::from_secs(options.lock_timeout_seconds),
            login_timeout: Duration::from_secs(options.login_timeout_seconds),
            callback_image_src: options.callback_image_src,
        },
    );
    Ok(Arc::new(ProviderAuth { inner }))
}

#[uniffi::export(async_runtime = "tokio")]
pub async fn create_provider_auth(options: ProviderOptions) -> BindingResult<Arc<ProviderAuth>> {
    let directory = match &options.cache_dir {
        Some(directory) => PathBuf::from(directory),
        None => directories::UserDirs::new()
            .ok_or_else(|| failure("could not resolve the user home directory"))?
            .home_dir()
            .join(".dbx-tools/auth"),
    };
    let service = options
        .keyring_service
        .clone()
        .unwrap_or_else(|| "dbx-tools-auth".into());
    let store = crate::open_store(
        options.storage.unwrap_or_default(),
        directory,
        service,
        options.file_layout.unwrap_or_default(),
    )
    .await
    .map_err(failure)?;
    create(options, store)
}

#[uniffi::export(async_runtime = "tokio")]
pub async fn create_provider_auth_with_storage(
    options: ProviderOptions,
    storage: Arc<dyn StorageAdapter>,
) -> BindingResult<Arc<ProviderAuth>> {
    create(options, Arc::new(ForeignStore { storage }))
}

#[uniffi::export(async_runtime = "tokio")]
impl ProviderAuth {
    #[uniffi::method(default(login = None))]
    pub async fn token(&self, login: Option<bool>) -> BindingResult<AccessToken> {
        match login {
            Some(true) => self.inner.login().await,
            Some(false) => self.inner.token().await,
            None => self.inner.token_or_login().await,
        }
        .map(Into::into)
        .map_err(failure)
    }
    pub async fn force_refresh_token(&self) -> BindingResult<AccessToken> {
        self.inner
            .force_refresh()
            .await
            .map(Into::into)
            .map_err(failure)
    }
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
    pub async fn logout(&self) -> BindingResult<()> {
        self.inner.logout().await.map_err(failure)
    }
}
