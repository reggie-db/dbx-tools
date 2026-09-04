use std::{path::PathBuf, sync::Arc, time::Duration};

use dbx_tools_u2m::{
    open_store, AuthClient, AuthOptions, CredentialStore, Profile, ProfileOptions, StoreBackend,
    StoreOptions, TargetKind,
};
use time::Duration as TimeDuration;

#[derive(Clone, Default, uniffi::Record)]
pub struct U2mOptions {
    #[uniffi(default = None)]
    pub profile: Option<String>,
    #[uniffi(default = None)]
    pub host: Option<String>,
    #[uniffi(default = None)]
    pub account_id: Option<String>,
    #[uniffi(default = None)]
    pub workspace_id: Option<String>,
    #[uniffi(default = None)]
    pub config_file: Option<String>,
    #[uniffi(default = None)]
    pub client_id: Option<String>,
    #[uniffi(default = None)]
    pub scopes: Option<Vec<String>>,
    #[uniffi(default = None)]
    pub target: Option<String>,
    #[uniffi(default = None)]
    pub storage: Option<String>,
    #[uniffi(default = None)]
    pub cache_dir: Option<String>,
    #[uniffi(default = None)]
    pub postgres_url: Option<String>,
    #[uniffi(default = 30)]
    pub lock_timeout_seconds: u64,
    #[uniffi(default = 3600)]
    pub login_timeout_seconds: u64,
    #[uniffi(default = 300)]
    pub refresh_buffer_seconds: i64,
}

#[derive(Clone, uniffi::Record)]
pub struct AccessToken {
    pub access_token: String,
    pub token_type: String,
    pub expiry: Option<String>,
    pub scopes: Vec<String>,
}

#[derive(Clone, uniffi::Record)]
pub struct U2mStatus {
    pub profile: String,
    pub host: String,
    pub storage: String,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum U2mError {
    #[error("{message}")]
    Failure { message: String },
}

type Result<T> = std::result::Result<T, U2mError>;

#[derive(uniffi::Object)]
pub struct PersistentAuth {
    inner: AuthClient,
}

#[uniffi::export(async_runtime = "tokio")]
pub async fn create_persistent_auth(options: U2mOptions) -> Result<Arc<PersistentAuth>> {
    PersistentAuth::new(options).await
}

impl PersistentAuth {
    async fn new(options: U2mOptions) -> Result<Arc<Self>> {
        let profile = Profile::from_sources(ProfileOptions {
            profile: options.profile.clone(),
            host: options.host.clone(),
            account_id: options.account_id.clone(),
            workspace_id: options.workspace_id.clone(),
            client_id: options.client_id.clone(),
            scopes: options.scopes.clone(),
            target: options.target.as_deref().map(parse_target).transpose()?,
            config_file: options.config_file.as_deref().map(PathBuf::from),
        })
        .map_err(binding_error)?;
        let store = open_binding_store(&options).await?;
        let inner = AuthClient::new(
            profile,
            store,
            AuthOptions {
                refresh_buffer: TimeDuration::seconds(options.refresh_buffer_seconds),
                lock_timeout: Duration::from_secs(options.lock_timeout_seconds),
                login_timeout: Duration::from_secs(options.login_timeout_seconds),
            },
        )
        .map_err(binding_error)?;
        Ok(Arc::new(Self { inner }))
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl PersistentAuth {
    pub async fn challenge(&self) -> Result<()> {
        self.inner.login().await.map(|_| ()).map_err(binding_error)
    }

    pub async fn token(&self) -> Result<AccessToken> {
        self.inner
            .token()
            .await
            .map(Into::into)
            .map_err(binding_error)
    }

    pub async fn force_refresh_token(&self) -> Result<AccessToken> {
        self.inner
            .force_refresh()
            .await
            .map(Into::into)
            .map_err(binding_error)
    }

    pub async fn logout(&self) -> Result<()> {
        self.inner.logout().await.map_err(binding_error)
    }

    pub fn status(&self) -> U2mStatus {
        U2mStatus {
            profile: self.inner.profile().name.clone(),
            host: self.inner.profile().host.to_string(),
            storage: self.inner.store_name().to_owned(),
        }
    }
}

impl From<dbx_tools_u2m::Token> for AccessToken {
    fn from(token: dbx_tools_u2m::Token) -> Self {
        Self {
            access_token: token.access_token,
            token_type: token.token_type,
            expiry: token.expires_at.map(|value| value.to_string()),
            scopes: token.scopes,
        }
    }
}

async fn open_binding_store(options: &U2mOptions) -> Result<Arc<dyn CredentialStore>> {
    #[cfg(feature = "postgres")]
    if let Some(url) = options.postgres_url.as_deref() {
        return Ok(Arc::new(
            dbx_tools_u2m_postgres::PostgresStore::connect(url)
                .await
                .map_err(binding_error)?,
        ));
    }
    #[cfg(not(feature = "postgres"))]
    if options.postgres_url.is_some() {
        return Err(U2mError::Failure {
            message: "Postgres support was not compiled in".into(),
        });
    }

    open_store(StoreOptions {
        backend: options.storage.as_deref().map(parse_storage).transpose()?,
        cache_dir: options.cache_dir.as_deref().map(PathBuf::from),
        config_file: options.config_file.as_deref().map(PathBuf::from),
    })
    .await
    .map_err(binding_error)
}

fn parse_target(value: &str) -> Result<TargetKind> {
    match value.trim().to_ascii_lowercase().as_str() {
        "workspace" => Ok(TargetKind::Workspace),
        "account" => Ok(TargetKind::Account),
        "unified" => Ok(TargetKind::Unified),
        _ => Err(U2mError::Failure {
            message: "target must be workspace, account, or unified".into(),
        }),
    }
}

fn parse_storage(value: &str) -> Result<StoreBackend> {
    match value.trim().to_ascii_lowercase().as_str() {
        "auto" => Ok(StoreBackend::Auto),
        "memory" => Ok(StoreBackend::Memory),
        "file" | "plaintext" => Ok(StoreBackend::File),
        "keyring" | "secure" => Ok(StoreBackend::Keyring),
        _ => Err(U2mError::Failure {
            message: "storage must be auto, memory, file, or keyring".into(),
        }),
    }
}

fn binding_error(error: impl std::fmt::Display) -> U2mError {
    U2mError::Failure {
        message: error.to_string(),
    }
}

uniffi::setup_scaffolding!();
