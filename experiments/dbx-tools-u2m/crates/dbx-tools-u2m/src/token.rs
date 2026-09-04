use oauth2::{
    basic::BasicTokenType, AccessToken, EmptyExtraTokenFields, RefreshToken, StandardTokenResponse,
};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::{Error, Result};

pub type OAuthTokenResponse = StandardTokenResponse<EmptyExtraTokenFields, BasicTokenType>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Token {
    pub access_token: String,
    pub token_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(
        rename = "expiry",
        alias = "expires_at",
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at: Option<OffsetDateTime>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scopes: Vec<String>,
}

impl Token {
    pub fn needs_refresh(&self, now: OffsetDateTime, buffer: Duration) -> bool {
        self.expires_at.is_some_and(|expiry| expiry <= now + buffer)
    }

    pub fn is_valid(&self, now: OffsetDateTime) -> bool {
        !self.access_token.is_empty() && self.expires_at.is_none_or(|expiry| expiry > now)
    }

    pub fn access_token(&self) -> AccessToken {
        AccessToken::new(self.access_token.clone())
    }

    pub fn refresh_token(&self) -> Option<RefreshToken> {
        self.refresh_token.clone().map(RefreshToken::new)
    }

    pub fn from_response(
        response: &OAuthTokenResponse,
        now: OffsetDateTime,
        previous: Option<&Token>,
    ) -> Result<Self> {
        use oauth2::TokenResponse;

        let expires_at = response
            .expires_in()
            .and_then(|duration| Duration::try_from(duration).ok())
            .and_then(|duration| now.checked_add(duration));
        let token_type = match response.token_type() {
            BasicTokenType::Bearer => "Bearer",
            BasicTokenType::Mac => "MAC",
            BasicTokenType::Extension(value) => value.as_str(),
        };
        let refresh_token = response
            .refresh_token()
            .map(|token| token.secret().to_owned())
            .or_else(|| previous.and_then(|token| token.refresh_token.clone()));
        let scopes = response
            .scopes()
            .map(|scopes| {
                scopes
                    .iter()
                    .map(|scope| scope.as_ref().to_owned())
                    .collect()
            })
            .or_else(|| previous.map(|token| token.scopes.clone()))
            .unwrap_or_default();

        if response.access_token().secret().is_empty() {
            return Err(Error::OAuth(
                "token response did not contain an access token".into(),
            ));
        }
        Ok(Self {
            access_token: response.access_token().secret().to_owned(),
            token_type: token_type.to_owned(),
            refresh_token,
            expires_at,
            scopes,
        })
    }
}
