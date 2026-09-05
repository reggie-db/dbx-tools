use crate::{
    databricks_cli::DatabricksCliFlow, AuthKind, AuthSession, CredentialStore,
    MachineToMachineFlow, OAuthFlow, OAuthTemplate, Profile, Result, Token,
};
pub use dbx_tools_auth::AuthOptions;
use std::{sync::Arc, time::Duration};

/// Databricks profile and acquisition policy over the shared `AuthSession` lifecycle.
pub struct AuthClient {
    profile: Profile,
    inner: dbx_tools_auth::AuthClient,
}

enum AuthFlow {
    UserToMachine(OAuthFlow),
    UserToMachineCli(DatabricksCliFlow),
    MachineToMachine(MachineToMachineFlow),
}

impl AuthClient {
    pub fn new(
        profile: Profile,
        store: Arc<dyn CredentialStore>,
        options: AuthOptions,
        use_databricks_cli: bool,
    ) -> Result<Self> {
        let flow = match profile.auth_kind {
            AuthKind::UserToMachine => {
                let native = OAuthFlow::new(profile.clone())?
                    .with_template(OAuthTemplate::new(options.callback_image_src.clone()));
                if use_databricks_cli {
                    AuthFlow::UserToMachineCli(DatabricksCliFlow::new(native, profile.name.clone()))
                } else {
                    AuthFlow::UserToMachine(native)
                }
            }
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
}

impl AuthSession for AuthClient {
    fn auth_client(&self) -> &dbx_tools_auth::AuthClient {
        &self.inner
    }
}

#[async_trait::async_trait]
impl dbx_tools_auth::TokenProvider for AuthFlow {
    async fn authenticate(&self, timeout: Duration) -> Result<Token> {
        match self {
            Self::UserToMachine(flow) => flow.login(timeout).await,
            Self::UserToMachineCli(flow) => flow.authenticate(timeout).await,
            Self::MachineToMachine(flow) => flow.token().await,
        }
    }
    async fn login(&self, timeout: Duration) -> Result<Token> {
        match self {
            Self::UserToMachine(flow) => flow.login(timeout).await,
            Self::UserToMachineCli(flow) => flow.login(timeout).await,
            Self::MachineToMachine(flow) => flow.token().await,
        }
    }
    async fn refresh(&self, token: &Token) -> Result<Token> {
        match self {
            Self::UserToMachine(flow) => flow.refresh(token).await,
            Self::UserToMachineCli(flow) => flow.refresh(token).await,
            Self::MachineToMachine(flow) => flow.token().await,
        }
    }
    fn can_authenticate_silently(&self) -> bool {
        matches!(self, Self::UserToMachineCli(_) | Self::MachineToMachine(_))
    }
}
