use std::{sync::Arc, time::Duration};

use time::{Duration as TimeDuration, OffsetDateTime};

use crate::{CredentialStore, Error, Result, Token};

#[async_trait::async_trait]
/// Provider-specific acquisition; persistence and locking belong to `AuthClient`.
pub trait TokenProvider: Send + Sync {
    /// Acquire a new credential within the supplied login timeout.
    async fn authenticate(&self, timeout: Duration) -> Result<Token>;
    /// Perform an explicitly requested login; defaults to normal acquisition.
    async fn login(&self, timeout: Duration) -> Result<Token> {
        self.authenticate(timeout).await
    }
    /// Renew a credential without silently starting an interactive login.
    async fn refresh(&self, token: &Token) -> Result<Token>;
    /// Whether acquisition is safe without an explicit interactive login request.
    fn can_authenticate_silently(&self) -> bool {
        false
    }
}

/// Shared lifecycle configuration embedded by every provider's binding options.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct AuthOptions {
    /// Renew credentials this many seconds before expiry; negative values are allowed.
    #[uniffi(default = 300)]
    pub refresh_buffer_seconds: i64,
    /// Maximum time spent waiting for the credential store's refresh lock.
    #[uniffi(default = 30)]
    pub lock_timeout_seconds: u64,
    /// Maximum time allowed for a new interactive login.
    #[uniffi(default = 3600)]
    pub login_timeout_seconds: u64,
    /// Logo URL or data URI displayed by the browser callback page.
    #[uniffi(default = None)]
    pub callback_image_src: Option<String>,
}

impl Default for AuthOptions {
    fn default() -> Self {
        Self {
            refresh_buffer_seconds: 300,
            lock_timeout_seconds: 30,
            login_timeout_seconds: 3600,
            callback_image_src: None,
        }
    }
}

impl AuthOptions {
    /// Convert the cross-language refresh window to a signed Rust duration.
    pub fn refresh_buffer(&self) -> TimeDuration {
        TimeDuration::seconds(self.refresh_buffer_seconds)
    }

    /// Convert the cross-language lock timeout to a Rust duration.
    pub fn lock_timeout(&self) -> Duration {
        Duration::from_secs(self.lock_timeout_seconds)
    }

    /// Convert the cross-language login timeout to a Rust duration.
    pub fn login_timeout(&self) -> Duration {
        Duration::from_secs(self.login_timeout_seconds)
    }
}

/// A provider wrapper that inherits the canonical credential lifecycle.
///
/// Implement only `auth_client`; the defaults retain locking, refresh, and
/// refresh-token redaction in the shared client rather than in each provider.
#[async_trait::async_trait]
pub trait AuthSession: Send + Sync {
    /// Return the shared client that owns this session's lifecycle.
    fn auth_client(&self) -> &AuthClient;

    /// Identify the active credential store.
    fn store_name(&self) -> &'static str {
        self.auth_client().store_name()
    }

    /// Resolve binding login policy: true forces login, false forbids it, None allows it.
    async fn token_with_login(&self, login: Option<bool>) -> Result<Token> {
        match login {
            Some(true) => self.login().await,
            Some(false) => self.token().await,
            None => self.token_or_login().await,
        }
    }

    /// Explicitly acquire and persist a new credential.
    async fn login(&self) -> Result<Token> {
        self.auth_client().login().await
    }

    /// Load or renew a credential without initiating an interactive login.
    async fn token(&self) -> Result<Token> {
        self.auth_client().token().await
    }

    /// Load or renew a credential, allowing login when none is stored.
    async fn token_or_login(&self) -> Result<Token> {
        self.auth_client().token_or_login().await
    }

    /// Renew the stored credential even when it has not reached its refresh window.
    async fn force_refresh(&self) -> Result<Token> {
        self.auth_client().force_refresh().await
    }

    /// Reuse another caller's replacement or renew the rejected credential.
    async fn refresh_rejected_token(&self, stale: &str) -> Result<Token> {
        self.auth_client().refresh_rejected_token(stale).await
    }

    /// Remove the persisted credential under its refresh lock.
    async fn logout(&self) -> Result<()> {
        self.auth_client().logout().await
    }
}

/// Provider-neutral check-lock-check authentication and persistent token lifecycle.
pub struct AuthClient {
    key: String,
    flow: Arc<dyn TokenProvider>,
    store: Arc<dyn CredentialStore>,
    options: AuthOptions,
}

impl AuthSession for AuthClient {
    fn auth_client(&self) -> &AuthClient {
        self
    }
}

impl AuthClient {
    /// Bind one credential identity to its acquisition provider and store.
    pub fn new(
        key: String,
        flow: Arc<dyn TokenProvider>,
        store: Arc<dyn CredentialStore>,
        options: AuthOptions,
    ) -> Self {
        Self {
            key,
            flow,
            store,
            options,
        }
    }

    /// Return the active store's backend identifier.
    pub fn store_name(&self) -> &'static str {
        self.store.name()
    }

    /// Acquire and persist a new credential under an exclusive refresh lock.
    pub async fn login(&self) -> Result<Token> {
        let cache_key = self.key.clone();
        let lock = self
            .store
            .lock(&cache_key, self.options.lock_timeout())
            .await?;
        let result = async {
            let (_, token) = tokio::try_join!(
                self.store.prepare_write(),
                self.flow.login(self.options.login_timeout())
            )?;
            self.store.save(&cache_key, &token).await?;
            Ok(public_token(token))
        }
        .await;
        release(lock, result).await
    }

    /// Load or refresh without starting an interactive login for a missing credential.
    pub async fn token(&self) -> Result<Token> {
        self.load_token(false).await
    }

    async fn load_token(&self, login: bool) -> Result<Token> {
        let cache_key = self.key.clone();
        let now = OffsetDateTime::now_utc();
        if let Some(token) = self.store.load(&cache_key).await? {
            if self.can_reuse(&token, now) {
                return Ok(public_token(token));
            }
        }

        let lock = self
            .store
            .lock(&cache_key, self.options.lock_timeout())
            .await?;
        let result = async {
            let token = self.store.load(&cache_key).await?;
            let now = OffsetDateTime::now_utc();
            if let Some(token) = token.as_ref() {
                if self.can_reuse(token, now) {
                    return Ok(public_token(token.clone()));
                }
            }
            self.renew(token, login).await
        }
        .await;
        release(lock, result).await
    }

    /// Load or refresh, permitting login when the store has no credential.
    pub async fn token_or_login(&self) -> Result<Token> {
        self.load_token(true).await
    }

    /// Renew even before the refresh window, without forcing an interactive login.
    pub async fn force_refresh(&self) -> Result<Token> {
        self.refresh_rejected(None).await
    }

    /// Refresh a rejected token unless another process already replaced it.
    pub async fn refresh_rejected_token(&self, stale_access_token: &str) -> Result<Token> {
        self.refresh_rejected(Some(stale_access_token)).await
    }

    async fn refresh_rejected(&self, stale_access_token: Option<&str>) -> Result<Token> {
        let cache_key = self.key.clone();
        let lock = self
            .store
            .lock(&cache_key, self.options.lock_timeout())
            .await?;
        let result = async {
            let token = self.store.load(&cache_key).await?;
            if let (Some(stale), Some(current)) = (stale_access_token, token.as_ref()) {
                if current.access_token != stale
                    && self.can_reuse(current, OffsetDateTime::now_utc())
                {
                    return Ok(public_token(current.clone()));
                }
            }
            self.renew(token, false).await
        }
        .await;
        release(lock, result).await
    }

    /// Delete only this credential while holding the store's refresh lock.
    pub async fn logout(&self) -> Result<()> {
        let cache_key = self.key.clone();
        let lock = self
            .store
            .lock(&cache_key, self.options.lock_timeout())
            .await?;
        let result = self.store.delete(&cache_key).await;
        release(lock, result).await
    }

    fn can_reuse(&self, token: &Token, now: OffsetDateTime) -> bool {
        token.is_valid(now) && !token.needs_refresh(now, self.options.refresh_buffer())
    }

    async fn renew(&self, token: Option<Token>, login: bool) -> Result<Token> {
        if token.is_none() && !login && !self.flow.can_authenticate_silently() {
            return Err(Error::LoginRequired(self.key.clone()));
        }
        self.store.prepare_write().await?;
        let renewed = match token {
            Some(token) => self.flow.refresh(&token).await?,
            None => self.flow.authenticate(self.options.login_timeout()).await?,
        };
        self.store.save(&self.key, &renewed).await?;
        Ok(public_token(renewed))
    }
}

async fn release<T>(lock: Box<dyn crate::StorageLock>, result: Result<T>) -> Result<T> {
    let released = lock.release().await;
    match result {
        Err(error) => Err(error),
        Ok(value) => released.map(|()| value),
    }
}

fn public_token(mut token: Token) -> Token {
    token.refresh_token = None;
    token
}
