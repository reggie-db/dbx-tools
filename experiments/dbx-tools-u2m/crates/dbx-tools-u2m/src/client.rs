use std::{sync::Arc, time::Duration};

use time::{Duration as TimeDuration, OffsetDateTime};

use crate::{CredentialStore, Error, OAuthFlow, Profile, Result, Token};

#[derive(Clone, Debug)]
pub struct AuthOptions {
    pub refresh_buffer: TimeDuration,
    pub lock_timeout: Duration,
    pub login_timeout: Duration,
}

impl Default for AuthOptions {
    fn default() -> Self {
        Self {
            refresh_buffer: TimeDuration::minutes(5),
            lock_timeout: Duration::from_secs(30),
            login_timeout: Duration::from_secs(3600),
        }
    }
}

pub struct AuthClient {
    profile: Profile,
    flow: OAuthFlow,
    store: Arc<dyn CredentialStore>,
    options: AuthOptions,
}

impl AuthClient {
    pub fn new(
        profile: Profile,
        store: Arc<dyn CredentialStore>,
        options: AuthOptions,
    ) -> Result<Self> {
        let flow = OAuthFlow::new(profile.clone())?;
        Ok(Self {
            profile,
            flow,
            store,
            options,
        })
    }

    pub fn profile(&self) -> &Profile {
        &self.profile
    }

    pub fn store_name(&self) -> &'static str {
        self.store.name()
    }

    pub async fn login(&self) -> Result<Token> {
        let _lock = self
            .store
            .lock(self.profile.cache_key(), self.options.lock_timeout)
            .await?;
        let token = self.flow.login(self.options.login_timeout).await?;
        self.store.save(self.profile.cache_key(), &token).await?;
        Ok(public_token(token))
    }

    pub async fn token(&self) -> Result<Token> {
        let now = OffsetDateTime::now_utc();
        if let Some(token) = self.store.load(self.profile.cache_key()).await? {
            if !token.needs_refresh(now, self.options.refresh_buffer) {
                return Ok(public_token(token));
            }
        }

        let _lock = self
            .store
            .lock(self.profile.cache_key(), self.options.lock_timeout)
            .await?;
        let token = self
            .store
            .load(self.profile.cache_key())
            .await?
            .ok_or_else(|| Error::LoginRequired(self.profile.name.clone()))?;
        let now = OffsetDateTime::now_utc();
        if !token.needs_refresh(now, self.options.refresh_buffer) {
            return Ok(public_token(token));
        }
        let refreshed = self.flow.refresh(&token).await?;
        self.store
            .save(self.profile.cache_key(), &refreshed)
            .await?;
        Ok(public_token(refreshed))
    }

    pub async fn token_or_login(&self) -> Result<Token> {
        match self.token().await {
            Err(Error::LoginRequired(_)) => self.login().await,
            result => result,
        }
    }

    pub async fn force_refresh(&self) -> Result<Token> {
        let _lock = self
            .store
            .lock(self.profile.cache_key(), self.options.lock_timeout)
            .await?;
        let token = self
            .store
            .load(self.profile.cache_key())
            .await?
            .ok_or_else(|| Error::LoginRequired(self.profile.name.clone()))?;
        let refreshed = self.flow.refresh(&token).await?;
        self.store
            .save(self.profile.cache_key(), &refreshed)
            .await?;
        Ok(public_token(refreshed))
    }

    pub async fn logout(&self) -> Result<()> {
        let _lock = self
            .store
            .lock(self.profile.cache_key(), self.options.lock_timeout)
            .await?;
        self.store.delete(self.profile.cache_key()).await
    }
}

fn public_token(mut token: Token) -> Token {
    token.refresh_token = None;
    token
}
