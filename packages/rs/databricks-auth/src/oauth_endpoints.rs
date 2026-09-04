use serde::Deserialize;

use crate::{Error, Profile, Result, TargetKind};

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct AuthorizationServer {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
}

pub(crate) async fn resolve(
    profile: &Profile,
    http: &reqwest::Client,
) -> Result<AuthorizationServer> {
    let host = profile.host.as_str().trim_end_matches('/');
    match profile.target {
        TargetKind::Workspace => {
            discover(
                http,
                format!("{host}/oidc/.well-known/oauth-authorization-server"),
            )
            .await
        }
        TargetKind::Account => {
            let account_id = profile
                .account_id
                .as_ref()
                .ok_or_else(|| Error::Config("account target requires account_id".into()))?;
            Ok(AuthorizationServer {
                authorization_endpoint: format!("{host}/oidc/accounts/{account_id}/v1/authorize"),
                token_endpoint: format!("{host}/oidc/accounts/{account_id}/v1/token"),
            })
        }
        TargetKind::Unified => {
            let account_id = profile
                .account_id
                .as_ref()
                .ok_or_else(|| Error::Config("unified target requires account_id".into()))?;
            discover(
                http,
                format!("{host}/oidc/accounts/{account_id}/.well-known/oauth-authorization-server"),
            )
            .await
        }
    }
}

async fn discover(http: &reqwest::Client, url: String) -> Result<AuthorizationServer> {
    let response = http.get(&url).send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(Error::OAuthNotSupported(url));
    }
    response
        .error_for_status()?
        .json()
        .await
        .map_err(Into::into)
}
