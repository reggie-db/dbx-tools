use crate::{
    AuthKind, CredentialStore, MachineToMachineFlow, OAuthFlow, OAuthTemplate, Profile, Result,
    Token,
};
pub use dbx_tools_auth::AuthOptions;
use std::{sync::Arc, time::Duration};

pub struct AuthClient {
    profile: Profile,
    inner: dbx_tools_auth::AuthClient,
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
        let inner =
            dbx_tools_auth::AuthClient::new(profile.cache_key(), Arc::new(flow), store, options);
        Ok(Self { profile, inner })
    }
    pub fn profile(&self) -> &Profile {
        &self.profile
    }
    pub fn store_name(&self) -> &'static str {
        self.inner.store_name()
    }
    pub async fn login(&self) -> Result<Token> {
        self.inner.login().await
    }
    pub async fn token(&self) -> Result<Token> {
        self.inner.token().await
    }
    pub async fn token_or_login(&self) -> Result<Token> {
        self.inner.token_or_login().await
    }
    pub async fn force_refresh(&self) -> Result<Token> {
        self.inner.force_refresh().await
    }
    pub async fn refresh_rejected_token(&self, stale: &str) -> Result<Token> {
        self.inner.refresh_rejected_token(stale).await
    }
    pub async fn logout(&self) -> Result<()> {
        self.inner.logout().await
    }
}

#[async_trait::async_trait]
impl dbx_tools_auth::TokenProvider for AuthFlow {
    async fn authenticate(&self, timeout: Duration) -> Result<Token> {
        match self {
            Self::UserToMachine(flow) => flow.login(timeout).await,
            Self::MachineToMachine(flow) => flow.token().await,
        }
    }
    async fn refresh(&self, token: &Token) -> Result<Token> {
        match self {
            Self::UserToMachine(flow) => flow.refresh(token).await,
            Self::MachineToMachine(flow) => flow.token().await,
        }
    }
    fn can_authenticate_silently(&self) -> bool {
        matches!(self, Self::MachineToMachine(_))
    }
}
