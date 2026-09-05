use crate::{oauth_endpoints, OAuthTemplate, Profile, Result, Token};
use std::time::Duration;

pub struct OAuthFlow {
    profile: Profile,
    http: reqwest::Client,
    template: OAuthTemplate,
}
impl OAuthFlow {
    pub fn new(profile: Profile) -> Result<Self> {
        Ok(Self {
            profile,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            template: OAuthTemplate::default(),
        })
    }
    pub fn with_template(mut self, template: OAuthTemplate) -> Self {
        self.template = template;
        self
    }
    async fn flow(&self) -> Result<dbx_tools_auth::OAuthFlow> {
        let endpoints = oauth_endpoints::resolve(&self.profile, &self.http).await?;
        Ok(dbx_tools_auth::OAuthFlow::new(dbx_tools_auth::OAuthConfig {
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
    pub async fn login(&self, timeout: Duration) -> Result<Token> {
        self.flow().await?.login(timeout).await
    }
    pub async fn refresh(&self, token: &Token) -> Result<Token> {
        self.flow().await?.refresh(token).await
    }
}
