use std::{sync::Arc, time::Duration};

use time::{Duration as TimeDuration, OffsetDateTime};

use crate::{CredentialStore, Error, Result, Token};

#[async_trait::async_trait]
pub trait TokenProvider: Send + Sync {
    async fn authenticate(&self, timeout: Duration) -> Result<Token>;
    async fn refresh(&self, token: &Token) -> Result<Token>;
    fn can_authenticate_silently(&self) -> bool {
        false
    }
}

#[derive(Clone, Debug)]
pub struct AuthOptions {
    pub refresh_buffer: TimeDuration,
    pub lock_timeout: Duration,
    pub login_timeout: Duration,
    /// Logo URL or data URI displayed by the browser callback page.
    pub callback_image_src: Option<String>,
}

impl Default for AuthOptions {
    fn default() -> Self {
        Self {
            refresh_buffer: TimeDuration::minutes(5),
            lock_timeout: Duration::from_secs(30),
            login_timeout: Duration::from_secs(3600),
            callback_image_src: None,
        }
    }
}

pub struct AuthClient {
    key: String,
    flow: Arc<dyn TokenProvider>,
    store: Arc<dyn CredentialStore>,
    options: AuthOptions,
}

impl AuthClient {
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

    pub fn store_name(&self) -> &'static str {
        self.store.name()
    }

    pub async fn login(&self) -> Result<Token> {
        let cache_key = self.key.clone();
        let lock = self
            .store
            .lock(&cache_key, self.options.lock_timeout)
            .await?;
        let result = async {
            let (_, token) = tokio::try_join!(
                self.store.prepare_write(),
                self.flow.authenticate(self.options.login_timeout)
            )?;
            self.store.save(&cache_key, &token).await?;
            Ok(public_token(token))
        }
        .await;
        release(lock, result).await
    }

    pub async fn token(&self) -> Result<Token> {
        self.load_token(false).await
    }

    async fn load_token(&self, login: bool) -> Result<Token> {
        let cache_key = self.key.clone();
        let now = OffsetDateTime::now_utc();
        if let Some(token) = self.store.load(&cache_key).await? {
            if token.is_valid(now) && !token.needs_refresh(now, self.options.refresh_buffer) {
                return Ok(public_token(token));
            }
        }

        let lock = self
            .store
            .lock(&cache_key, self.options.lock_timeout)
            .await?;
        let result = async {
            let token = self.store.load(&cache_key).await?;
            let now = OffsetDateTime::now_utc();
            if let Some(token) = token.as_ref() {
                if token.is_valid(now) && !token.needs_refresh(now, self.options.refresh_buffer) {
                    return Ok(public_token(token.clone()));
                }
            }
            let loaded = match token {
                Some(token) => {
                    self.store.prepare_write().await?;
                    self.flow.refresh(&token).await?
                }
                None if login || self.flow.can_authenticate_silently() => {
                    self.store.prepare_write().await?;
                    self.flow.authenticate(self.options.login_timeout).await?
                }
                None => return Err(Error::LoginRequired(self.key.clone())),
            };
            self.store.save(&cache_key, &loaded).await?;
            Ok(public_token(loaded))
        }
        .await;
        release(lock, result).await
    }

    pub async fn token_or_login(&self) -> Result<Token> {
        self.load_token(true).await
    }

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
            .lock(&cache_key, self.options.lock_timeout)
            .await?;
        let result = async {
            let token = self.store.load(&cache_key).await?;
            if let (Some(stale), Some(current)) = (stale_access_token, token.as_ref()) {
                if current.access_token != stale
                    && current.is_valid(OffsetDateTime::now_utc())
                    && !current
                        .needs_refresh(OffsetDateTime::now_utc(), self.options.refresh_buffer)
                {
                    return Ok(public_token(current.clone()));
                }
            }
            let loaded = match token {
                Some(token) => {
                    self.store.prepare_write().await?;
                    self.flow.refresh(&token).await?
                }
                None if self.flow.can_authenticate_silently() => {
                    self.store.prepare_write().await?;
                    self.flow.authenticate(self.options.login_timeout).await?
                }
                None => return Err(Error::LoginRequired(self.key.clone())),
            };
            self.store.save(&cache_key, &loaded).await?;
            Ok(public_token(loaded))
        }
        .await;
        release(lock, result).await
    }

    pub async fn logout(&self) -> Result<()> {
        let cache_key = self.key.clone();
        let lock = self
            .store
            .lock(&cache_key, self.options.lock_timeout)
            .await?;
        let result = self.store.delete(&cache_key).await;
        release(lock, result).await
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
