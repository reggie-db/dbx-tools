use std::{path::PathBuf, sync::Arc, time::Duration};

use dbx_tools_u2m::{
    open_store, AuthClient, AuthOptions, CredentialStore, Profile, ProfileOptions, StoreBackend,
    StoreOptions, TargetKind,
};
use napi::{bindgen_prelude::*, Error as NapiError, Status};
use napi_derive::napi;
use time::Duration as TimeDuration;

#[napi(object)]
#[derive(Default)]
pub struct U2mOptions {
    pub profile: Option<String>,
    pub host: Option<String>,
    pub account_id: Option<String>,
    pub workspace_id: Option<String>,
    pub config_file: Option<String>,
    pub client_id: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub target: Option<String>,
    pub storage: Option<String>,
    pub cache_dir: Option<String>,
    pub postgres_url: Option<String>,
    pub lock_timeout_seconds: Option<u32>,
    pub login_timeout_seconds: Option<u32>,
    pub refresh_buffer_seconds: Option<i64>,
}

#[napi(object)]
pub struct AccessToken {
    pub access_token: String,
    pub token_type: String,
    pub expiry: Option<String>,
    pub scopes: Vec<String>,
}

#[napi(object)]
pub struct U2mStatus {
    pub profile: String,
    pub host: String,
    pub storage: String,
}

#[napi(js_name = "U2mClient")]
pub struct U2mClient {
    inner: Arc<AuthClient>,
}

#[napi]
impl U2mClient {
    #[napi(factory)]
    pub async fn create(options: Option<U2mOptions>) -> Result<Self> {
        let options = options.unwrap_or_default();
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
        let auth_options = AuthOptions {
            refresh_buffer: TimeDuration::seconds(options.refresh_buffer_seconds.unwrap_or(300)),
            lock_timeout: Duration::from_secs(u64::from(
                options.lock_timeout_seconds.unwrap_or(30),
            )),
            login_timeout: Duration::from_secs(u64::from(
                options.login_timeout_seconds.unwrap_or(3600),
            )),
        };
        Ok(Self {
            inner: Arc::new(AuthClient::new(profile, store, auth_options).map_err(binding_error)?),
        })
    }

    #[napi]
    pub async fn login(&self) -> Result<AccessToken> {
        self.inner
            .login()
            .await
            .map(Into::into)
            .map_err(binding_error)
    }

    #[napi]
    pub async fn token(&self) -> Result<AccessToken> {
        self.inner
            .token()
            .await
            .map(Into::into)
            .map_err(binding_error)
    }

    #[napi]
    pub async fn token_or_login(&self) -> Result<AccessToken> {
        self.inner
            .token_or_login()
            .await
            .map(Into::into)
            .map_err(binding_error)
    }

    #[napi]
    pub async fn force_refresh(&self) -> Result<AccessToken> {
        self.inner
            .force_refresh()
            .await
            .map(Into::into)
            .map_err(binding_error)
    }

    #[napi]
    pub async fn logout(&self) -> Result<()> {
        self.inner.logout().await.map_err(binding_error)
    }

    #[napi(getter)]
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
        return Err(NapiError::new(
            Status::InvalidArg,
            "Postgres support was not compiled in",
        ));
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
        _ => Err(NapiError::new(
            Status::InvalidArg,
            "target must be workspace, account, or unified",
        )),
    }
}

fn parse_storage(value: &str) -> Result<StoreBackend> {
    match value.trim().to_ascii_lowercase().as_str() {
        "auto" => Ok(StoreBackend::Auto),
        "memory" => Ok(StoreBackend::Memory),
        "file" | "plaintext" => Ok(StoreBackend::File),
        "keyring" | "secure" => Ok(StoreBackend::Keyring),
        _ => Err(NapiError::new(
            Status::InvalidArg,
            "storage must be auto, memory, file, or keyring",
        )),
    }
}

fn binding_error(error: impl std::fmt::Display) -> NapiError {
    NapiError::new(Status::GenericFailure, error.to_string())
}
