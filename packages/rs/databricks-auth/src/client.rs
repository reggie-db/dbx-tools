use std::{sync::Arc, time::Duration};

use time::{Duration as TimeDuration, OffsetDateTime};

use crate::{
    AuthKind, CredentialStore, Error, MachineToMachineFlow, OAuthFlow, OAuthTemplate, Profile,
    Result, Token,
};

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
    profile: Profile,
    flow: AuthFlow,
    store: Arc<dyn CredentialStore>,
    options: AuthOptions,
}

enum AuthFlow {
    UserToMachine(OAuthFlow),
    MachineToMachine(MachineToMachineFlow),
}

impl AuthClient {
    pub fn new(
        profile: Profile,
        store: Arc<dyn CredentialStore>,
        options: AuthOptions,
    ) -> Result<Self> {
        let flow = match profile.auth_kind {
            AuthKind::UserToMachine => AuthFlow::UserToMachine(
                OAuthFlow::new(profile.clone())?
                    .with_template(OAuthTemplate::new(options.callback_image_src.clone())),
            ),
            AuthKind::MachineToMachine => {
                AuthFlow::MachineToMachine(MachineToMachineFlow::new(profile.clone())?)
            }
        };
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
        let cache_key = self.profile.cache_key();
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
        let cache_key = self.profile.cache_key();
        let now = OffsetDateTime::now_utc();
        if let Some(token) = self.store.load(&cache_key).await? {
            if !token.needs_refresh(now, self.options.refresh_buffer) {
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
                if !token.needs_refresh(now, self.options.refresh_buffer) {
                    return Ok(public_token(token.clone()));
                }
            }
            let loaded = match token {
                Some(token) => {
                    self.store.prepare_write().await?;
                    self.flow.refresh(&token).await?
                }
                None if self.flow.is_machine_to_machine() => {
                    self.store.prepare_write().await?;
                    self.flow.authenticate(self.options.login_timeout).await?
                }
                None => return Err(Error::LoginRequired(self.profile.name.clone())),
            };
            self.store.save(&cache_key, &loaded).await?;
            Ok(public_token(loaded))
        }
        .await;
        release(lock, result).await
    }

    pub async fn token_or_login(&self) -> Result<Token> {
        match self.token().await {
            Err(Error::LoginRequired(_)) => self.login().await,
            result => result,
        }
    }

    pub async fn force_refresh(&self) -> Result<Token> {
        self.refresh_rejected(None).await
    }

    /// Refresh a rejected token unless another process already replaced it.
    pub async fn refresh_rejected_token(&self, stale_access_token: &str) -> Result<Token> {
        self.refresh_rejected(Some(stale_access_token)).await
    }

    async fn refresh_rejected(&self, stale_access_token: Option<&str>) -> Result<Token> {
        let cache_key = self.profile.cache_key();
        let lock = self
            .store
            .lock(&cache_key, self.options.lock_timeout)
            .await?;
        let result = async {
            let token = self.store.load(&cache_key).await?;
            if let (Some(stale), Some(current)) = (stale_access_token, token.as_ref()) {
                if current.access_token != stale {
                    return Ok(public_token(current.clone()));
                }
            }
            let loaded = match token {
                Some(token) => {
                    self.store.prepare_write().await?;
                    self.flow.refresh(&token).await?
                }
                None if self.flow.is_machine_to_machine() => {
                    self.store.prepare_write().await?;
                    self.flow.authenticate(self.options.login_timeout).await?
                }
                None => return Err(Error::LoginRequired(self.profile.name.clone())),
            };
            self.store.save(&cache_key, &loaded).await?;
            Ok(public_token(loaded))
        }
        .await;
        release(lock, result).await
    }

    pub async fn logout(&self) -> Result<()> {
        let cache_key = self.profile.cache_key();
        let lock = self
            .store
            .lock(&cache_key, self.options.lock_timeout)
            .await?;
        let result = self.store.delete(&cache_key).await;
        release(lock, result).await
    }
}

impl AuthFlow {
    async fn authenticate(&self, login_timeout: Duration) -> Result<Token> {
        match self {
            Self::UserToMachine(flow) => flow.login(login_timeout).await,
            Self::MachineToMachine(flow) => flow.token().await,
        }
    }

    async fn refresh(&self, token: &Token) -> Result<Token> {
        match self {
            Self::UserToMachine(flow) => flow.refresh(token).await,
            Self::MachineToMachine(flow) => flow.token().await,
        }
    }

    fn is_machine_to_machine(&self) -> bool {
        matches!(self, Self::MachineToMachine(_))
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
