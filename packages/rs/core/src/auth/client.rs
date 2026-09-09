use crate::{
    AuthKind, AuthOptions, AuthSession, CredentialStore, Error, MachineToMachineFlow, OAuthFlow,
    OAuthTemplate, Profile, Result, Token,
};
use std::{sync::Arc, time::Duration};

/// Databricks profile and acquisition policy over the shared `AuthSession` lifecycle.
pub struct DatabricksAuthClient {
    profile: Profile,
    inner: crate::AuthClient,
}

enum AuthFlow {
    UserToMachine(OAuthFlow),
    UserToMachineCli(DatabricksCliFlow),
    MachineToMachine(MachineToMachineFlow),
    PersonalAccessToken(Token),
}

struct DatabricksCliFlow {
    profile: String,
}

impl DatabricksCliFlow {
    fn new(profile: String) -> Self {
        Self { profile }
    }

    async fn token(&self, force_refresh: bool) -> Result<Token> {
        let profile = self.profile.clone();
        tokio::task::spawn_blocking(move || {
            let output = crate::databricks_cli_token(&profile, force_refresh)
                .map_err(|error| Error::OAuth(error.to_string()))?;
            serde_json::from_slice(&output).map_err(Into::into)
        })
        .await
        .map_err(|error| Error::OAuth(format!("databricks auth token task failed: {error}")))?
    }

    async fn login(&self) -> Result<Token> {
        let profile = self.profile.clone();
        tokio::task::spawn_blocking(move || {
            crate::databricks_cli_login(&profile)
                .map_err(|error| Error::OAuth(error.to_string()))?;
            let output = crate::databricks_cli_token(&profile, false)
                .map_err(|error| Error::OAuth(error.to_string()))?;
            serde_json::from_slice(&output).map_err(Into::into)
        })
        .await
        .map_err(|error| Error::OAuth(format!("databricks auth login task failed: {error}")))?
    }
}

impl DatabricksAuthClient {
    /// Create an authentication client for a resolved profile and credential store.
    pub fn new(
        profile: Profile,
        store: Arc<dyn CredentialStore>,
        options: AuthOptions,
        use_databricks_cli: bool,
    ) -> Result<Self> {
        let flow = match profile.auth_kind {
            AuthKind::UserToMachine => {
                if use_databricks_cli {
                    AuthFlow::UserToMachineCli(DatabricksCliFlow::new(profile.name.clone()))
                } else {
                    let native = OAuthFlow::new(profile.clone())?
                        .with_template(OAuthTemplate::new(options.callback_image_src.clone()));
                    AuthFlow::UserToMachine(native)
                }
            }
            AuthKind::MachineToMachine | AuthKind::AppServicePrincipal => {
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
            AuthKind::AppOnBehalfOf => {
                return Err(Error::Config(
                    "app_obo tokens must use the request-scoped auth client".into(),
                ));
            }
        };
        let inner = crate::AuthClient::new(profile.cache_key(), Arc::new(flow), store, options);
        Ok(Self { profile, inner })
    }

    /// Return the resolved Databricks profile.
    pub fn profile(&self) -> &Profile {
        &self.profile
    }
}

impl AuthSession for DatabricksAuthClient {
    fn auth_client(&self) -> &crate::AuthClient {
        &self.inner
    }
}

#[async_trait::async_trait]
impl crate::TokenProvider for AuthFlow {
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
            Self::UserToMachineCli(flow) => flow.login().await,
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
        let client = DatabricksAuthClient::new(
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
