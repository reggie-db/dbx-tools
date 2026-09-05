use std::{collections::HashMap, net::SocketAddr, time::Duration};

use oauth2::{
    basic::BasicClient, AuthUrl, AuthorizationCode, ClientId, CsrfToken, EndpointNotSet,
    EndpointSet, PkceCodeChallenge, RedirectUrl, RefreshToken, Scope, TokenUrl,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use url::Url;

use crate::{token::OAuthTokenResponse, Error, OAuthTemplate, OAuthTemplateContext, Result, Token};

const DEFAULT_PORT: u16 = 8020;
const MAX_PORT: u16 = 8040;

type OAuthClient =
    BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>;

#[derive(Clone)]
pub struct OAuthConfig {
    pub provider: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub scopes: Vec<String>,
    pub extra_token_params: Vec<(String, String)>,
    pub host: Option<String>,
}

pub struct OAuthFlow {
    config: OAuthConfig,
    http: reqwest::Client,
    template: OAuthTemplate,
}

impl OAuthFlow {
    pub fn new(config: OAuthConfig) -> Result<Self> {
        for endpoint in [&config.authorization_endpoint, &config.token_endpoint] {
            let url = Url::parse(endpoint)?;
            let loopback = url.host_str().is_some_and(|host| {
                host == "localhost"
                    || host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|address| address.is_loopback())
            });
            if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
                return Err(Error::Config(
                    "OAuth endpoints must use HTTPS or loopback HTTP".into(),
                ));
            }
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            config,
            http,
            template: OAuthTemplate::default(),
        })
    }

    /// Set the branding used by the browser callback page.
    pub fn with_template(mut self, template: OAuthTemplate) -> Self {
        self.template = template;
        self
    }

    pub async fn login(&self, timeout: Duration) -> Result<Token> {
        let (listener, address) = bind_callback().await?;
        let redirect = format!("http://localhost:{}", address.port());
        let client = self.client(&redirect)?;
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let mut request = client
            .authorize_url(CsrfToken::new_random)
            .set_pkce_challenge(challenge);
        for scope in self.config.scopes.clone() {
            request = request.add_scope(Scope::new(scope));
        }
        let (authorization_url, csrf) = request.url();
        if open::that(authorization_url.as_str()).is_err() {
            eprintln!("Open this URL in a browser:\n{authorization_url}");
        }

        let callback = tokio::time::timeout(
            timeout,
            receive_callback(
                listener,
                &redirect,
                &self.template,
                self.config.host.as_deref(),
                csrf.secret(),
            ),
        )
        .await
        .map_err(|_| Error::OAuth("timed out waiting for browser authorization".into()))??;
        if callback.state.as_deref() != Some(csrf.secret()) {
            return Err(Error::OAuth("OAuth state did not match".into()));
        }
        if let Some(error) = callback.error {
            return Err(Error::OAuth(match callback.error_description {
                Some(description) => format!("{error}: {description}"),
                None => error,
            }));
        }
        let code = callback
            .code
            .ok_or_else(|| Error::OAuth("authorization callback contained no code".into()))?;
        let response = client
            .exchange_code(AuthorizationCode::new(code))
            .set_pkce_verifier(verifier)
            .request_async(&self.http)
            .await
            .map_err(|error| {
                Error::OAuth(format!("authorization-code exchange failed: {error}"))
            })?;
        let mut token = Token::from_response(&response, time::OffsetDateTime::now_utc(), None)?;
        if token.scopes.is_empty() {
            token.scopes = self.config.scopes.clone();
        }
        Ok(token)
    }

    pub async fn refresh(&self, token: &Token) -> Result<Token> {
        let client = self.client("http://localhost:8020")?;
        let refresh = token
            .refresh_token()
            .ok_or_else(|| Error::LoginRequired(self.config.provider.clone()))?;
        let response: OAuthTokenResponse = client
            .exchange_refresh_token(&RefreshToken::new(refresh.secret().to_owned()))
            .request_async(&self.http)
            .await
            .map_err(|error| Error::OAuth(format!("refresh-token exchange failed: {error}")))?;
        Token::from_response(&response, time::OffsetDateTime::now_utc(), Some(token))
    }

    pub async fn client_credentials(&self) -> Result<Token> {
        let secret =
            self.config.client_secret.clone().ok_or_else(|| {
                Error::Config("client credentials require a client secret".into())
            })?;
        let client = self
            .client("http://localhost:8020")?
            .set_client_secret(oauth2::ClientSecret::new(secret))
            .set_auth_type(oauth2::AuthType::BasicAuth);
        let mut request = client.exchange_client_credentials();
        for scope in &self.config.scopes {
            request = request.add_scope(Scope::new(scope.clone()));
        }
        for (name, value) in &self.config.extra_token_params {
            request = request.add_extra_param(name, value);
        }
        let response = request.request_async(&self.http).await.map_err(|error| {
            Error::OAuth(format!("client-credentials exchange failed: {error}"))
        })?;
        let mut token = Token::from_response(&response, time::OffsetDateTime::now_utc(), None)?;
        if token.scopes.is_empty() {
            token.scopes = self.config.scopes.clone();
        }
        Ok(token)
    }

    fn client(&self, redirect: &str) -> Result<OAuthClient> {
        let client = BasicClient::new(ClientId::new(self.config.client_id.clone()))
            .set_auth_uri(
                AuthUrl::new(self.config.authorization_endpoint.clone())
                    .map_err(|error| Error::OAuth(error.to_string()))?,
            )
            .set_token_uri(
                TokenUrl::new(self.config.token_endpoint.clone())
                    .map_err(|error| Error::OAuth(error.to_string()))?,
            )
            .set_redirect_uri(
                RedirectUrl::new(redirect.to_owned())
                    .map_err(|error| Error::OAuth(error.to_string()))?,
            );
        Ok(match &self.config.client_secret {
            Some(secret) => client.set_client_secret(oauth2::ClientSecret::new(secret.clone())),
            None => client,
        })
    }
}

#[derive(Debug)]
struct Callback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn bind_callback() -> Result<(TcpListener, SocketAddr)> {
    for port in DEFAULT_PORT..=MAX_PORT {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
            let address = listener.local_addr()?;
            return Ok((listener, address));
        }
    }
    Err(Error::OAuth(format!(
        "no callback port available from {DEFAULT_PORT} through {MAX_PORT}"
    )))
}

async fn receive_callback(
    listener: TcpListener,
    redirect: &str,
    template: &OAuthTemplate,
    host: Option<&str>,
    expected_state: &str,
) -> Result<Callback> {
    let (mut stream, _) = listener.accept().await?;
    let mut buffer = vec![0; 16 * 1024];
    let read = stream.read(&mut buffer).await?;
    let request = std::str::from_utf8(&buffer[..read])
        .map_err(|error| Error::OAuth(format!("invalid callback request: {error}")))?;
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| Error::OAuth("invalid callback request line".into()))?;
    let url = Url::parse(&format!("{redirect}{target}"))?;
    let values: HashMap<String, String> = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let callback = Callback {
        code: values.get("code").cloned(),
        state: values.get("state").cloned(),
        error: values.get("error").cloned(),
        error_description: values.get("error_description").cloned(),
    };
    let successful = callback.state.as_deref() == Some(expected_state)
        && callback.error.is_none()
        && callback.code.is_some();
    let body = callback_response(template, host, &callback, successful);
    let status = if successful {
        "200 OK"
    } else {
        "400 Bad Request"
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream.write_all(response.as_bytes()).await?;
    Ok(callback)
}

fn callback_response(
    template: &OAuthTemplate,
    host: Option<&str>,
    callback: &Callback,
    successful: bool,
) -> String {
    let default_error = (!successful && callback.error.is_none()).then_some("authorization_failed");
    let error = callback.error.as_deref().or(default_error);
    template.render(OAuthTemplateContext {
        host,
        error,
        error_description: callback.error_description.as_deref(),
    })
}
