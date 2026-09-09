use super::oauth_endpoints;
use crate::{OAuthTemplate, Profile, Result, Token};
use std::time::Duration;

/// Databricks OAuth user-to-machine flow for a resolved profile.
pub struct OAuthFlow {
    profile: Profile,
    http: reqwest::Client,
    template: OAuthTemplate,
}

impl OAuthFlow {
    /// Create a user-to-machine flow for the profile.
    pub fn new(profile: Profile) -> Result<Self> {
        Ok(Self {
            profile,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            template: OAuthTemplate::default(),
        })
    }

    /// Set the browser callback page template.
    pub fn with_template(mut self, template: OAuthTemplate) -> Self {
        self.template = template;
        self
    }

    async fn flow(&self) -> Result<crate::GenericOAuthFlow> {
        let endpoints = oauth_endpoints::resolve(&self.profile, &self.http).await?;
        Ok(crate::GenericOAuthFlow::new(crate::OAuthConfig {
            provider: "databricks".into(),
            authorization_endpoint: endpoints.authorization_endpoint,
            token_endpoint: endpoints.token_endpoint,
            client_id: self.profile.client_id.clone(),
            client_secret: None,
            scopes: self.profile.effective_scopes(),
            extra_token_params: vec![],
            host: Some(self.profile.host.to_string()),
        })?
        .with_template(self.template.clone()))
    }

    /// Complete browser authorization within the timeout.
    pub async fn login(&self, timeout: Duration) -> Result<Token> {
        self.flow().await?.login(timeout).await
    }

    /// Exchange the credential's refresh token for a new token.
    pub async fn refresh(&self, token: &Token) -> Result<Token> {
        self.flow().await?.refresh(token).await
    }
}
