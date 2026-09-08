use crate::{
    AuthKind, AuthSession, CredentialStore, Error, MachineToMachineFlow, OAuthFlow, OAuthTemplate,
    Profile, Result, Token,
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
    PersonalAccessToken(Token),
}

struct DatabricksCliFlow {
    native: OAuthFlow,
    profile: String,
}

impl DatabricksCliFlow {
    fn new(native: OAuthFlow, profile: String) -> Self {
        Self { native, profile }
    }

    async fn token(&self, force_refresh: bool) -> Result<Token> {
        let profile = self.profile.clone();
        tokio::task::spawn_blocking(move || {
            let output = dbx_tools_databricks::databricks_cli_token(&profile, force_refresh)
                .map_err(|error| Error::OAuth(error.to_string()))?;
            serde_json::from_slice(&output).map_err(Into::into)
        })
        .await
        .map_err(|error| Error::OAuth(format!("databricks auth token task failed: {error}")))?
    }
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
            AuthKind::PersonalAccessToken => AuthFlow::PersonalAccessToken(Token {
                access_token: profile
                    .access_token()
                    .ok_or_else(|| Error::Config("pat requires token".into()))?
                    .to_owned(),
                token_type: "Bearer".into(),
                refresh_token: None,
                expires_at: None,
                scopes: Vec::new(),
            }),
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
            Self::UserToMachineCli(flow) => flow.token(false).await,
            Self::MachineToMachine(flow) => flow.token().await,
            Self::PersonalAccessToken(token) => Ok(token.clone()),
        }
    }
    async fn login(&self, timeout: Duration) -> Result<Token> {
        match self {
            Self::UserToMachine(flow) => flow.login(timeout).await,
            Self::UserToMachineCli(flow) => flow.native.login(timeout).await,
            Self::MachineToMachine(flow) => flow.token().await,
            Self::PersonalAccessToken(token) => Ok(token.clone()),
        }
    }
    async fn refresh(&self, token: &Token) -> Result<Token> {
        match self {
            Self::UserToMachine(flow) => flow.refresh(token).await,
            Self::UserToMachineCli(flow) => flow.token(true).await,
            Self::MachineToMachine(flow) => flow.token().await,
            Self::PersonalAccessToken(token) => Ok(token.clone()),
        }
    }
    fn can_authenticate_silently(&self) -> bool {
        matches!(
            self,
            Self::UserToMachineCli(_) | Self::MachineToMachine(_) | Self::PersonalAccessToken(_)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MemoryStore, TargetKind};
    use url::Url;

    #[test]
    fn parses_databricks_cli_token_json() {
        let token: Token = serde_json::from_slice(
            br#"{"access_token":"access","token_type":"Bearer","refresh_token":"refresh","expiry":"2026-09-05T13:00:00Z","scopes":["all-apis","offline_access"]}"#,
        )
        .unwrap();
        assert_eq!(token.access_token, "access");
        assert_eq!(token.refresh_token.as_deref(), Some("refresh"));
        assert_eq!(token.scopes, ["all-apis", "offline_access"]);
    }

    #[tokio::test]
    async fn personal_access_token_authenticates_silently() {
        let profile = Profile {
            name: "DEFAULT".into(),
            host: Url::parse("https://workspace.example").unwrap(),
            account_id: None,
            workspace_id: None,
            client_id: String::new(),
            group_id: None,
            scopes: Vec::new(),
            target: TargetKind::Workspace,
            auth_kind: AuthKind::PersonalAccessToken,
            client_secret: None,
            access_token: Some("access".into()),
        };
        let client = AuthClient::new(
            profile,
            Arc::new(MemoryStore::new()),
            AuthOptions::default(),
            false,
        )
        .unwrap();

        let token = client.token_with_login(Some(false)).await.unwrap();

        assert_eq!(token.access_token, "access");
    }
}
