use oauth2::{basic::BasicClient, AuthType, ClientId, ClientSecret, Scope, TokenUrl};

use crate::{oauth_endpoints, token::OAuthTokenResponse, Error, Profile, Result, Token};

/// Databricks OAuth client-credentials flow for service principals.
pub struct MachineToMachineFlow {
    profile: Profile,
    http: reqwest::Client,
}

impl MachineToMachineFlow {
    /// Create an M2M flow for a resolved profile.
    pub fn new(profile: Profile) -> Result<Self> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self { profile, http })
    }

    /// Mint a token using HTTP Basic client authentication.
    pub async fn token(&self) -> Result<Token> {
        let endpoints = oauth_endpoints::resolve(&self.profile, &self.http).await?;
        let client_secret = self.profile.client_secret().ok_or_else(|| {
            Error::Config(format!(
                "profile {} requires client_secret for oauth-m2m",
                self.profile.name
            ))
        })?;
        let client = BasicClient::new(ClientId::new(self.profile.client_id.clone()))
            .set_client_secret(ClientSecret::new(client_secret.to_owned()))
            .set_auth_type(AuthType::BasicAuth)
            .set_token_uri(
                TokenUrl::new(endpoints.token_endpoint)
                    .map_err(|error| Error::OAuth(error.to_string()))?,
            );
        let mut request = client.exchange_client_credentials();
        let scopes = self.profile.machine_scopes();
        for scope in &scopes {
            request = request.add_scope(Scope::new(scope.clone()));
        }
        if let Some(group_id) = self.profile.group_id.as_deref() {
            request = request.add_extra_param("assume_group", group_id);
        }
        let response: OAuthTokenResponse =
            request.request_async(&self.http).await.map_err(|error| {
                Error::OAuth(format!("client-credentials exchange failed: {error}"))
            })?;
        let mut token = Token::from_response(&response, time::OffsetDateTime::now_utc(), None)?;
        if token.scopes.is_empty() {
            token.scopes = scopes;
        }
        Ok(token)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use url::Url;

    use super::*;
    use crate::{AuthClient, AuthKind, AuthOptions, MemoryStore, TargetKind};

    #[tokio::test]
    async fn mints_and_caches_an_account_token_with_cli_request_semantics() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream).await;
            let body = r#"{"access_token":"access","token_type":"Bearer","expires_in":3600}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            request
        });
        let directory = tempfile::tempdir().unwrap();
        let profile = Profile {
            name: "service".into(),
            host: Url::parse(&format!("http://{address}")).unwrap(),
            account_id: Some("account".into()),
            workspace_id: None,
            client_id: "client".into(),
            group_id: Some("group".into()),
            scopes: vec!["jobs".into(), "files:read".into()],
            target: TargetKind::Account,
            auth_kind: AuthKind::MachineToMachine,
            client_secret: Some("secret".into()),
        };
        let client = Arc::new(
            AuthClient::new(
                profile,
                Arc::new(MemoryStore::new(directory.path().join("locks")).unwrap()),
                AuthOptions::default(),
            )
            .unwrap(),
        );

        let (first, second) = tokio::join!(client.token(), client.token());
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.access_token, "access");
        assert_eq!(first.scopes, ["files:read", "jobs"]);
        assert_eq!(second.access_token, "access");
        assert_eq!(second.scopes, ["files:read", "jobs"]);

        let request = server.await.unwrap();
        assert!(request.starts_with("POST /oidc/accounts/account/v1/token HTTP/1.1\r\n"));
        assert!(request.to_ascii_lowercase().contains(
            "authorization: basic y2xpzw50onnly3jldA=="
                .to_ascii_lowercase()
                .as_str()
        ));
        let parameters = url::form_urlencoded::parse(
            request
                .split_once("\r\n\r\n")
                .map(|(_, body)| body)
                .unwrap_or_default()
                .as_bytes(),
        )
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            parameters.get("grant_type").map(String::as_str),
            Some("client_credentials")
        );
        assert_eq!(
            parameters.get("scope").map(String::as_str),
            Some("files:read jobs")
        );
        assert_eq!(
            parameters.get("assume_group").map(String::as_str),
            Some("group")
        );
    }

    async fn read_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        loop {
            let mut buffer = [0_u8; 4096];
            let read = stream.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or_default();
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        String::from_utf8(request).unwrap()
    }
}
