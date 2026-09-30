// Copyright 2025 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

mod jws;

use crate::credentials::dynamic::CredentialTrait;
use crate::credentials::{Credential, Result};
use crate::errors::CredentialError;
use crate::token::{Token, TokenProvider};
use async_trait::async_trait;
use derive_builder::Builder;
use http::header::{HeaderName, HeaderValue, AUTHORIZATION};
use jws::{JwsClaims, JwsHeader, CLOCK_SKEW_FUDGE, DEFAULT_TOKEN_TIMEOUT};
use rustls::crypto::CryptoProvider;
use rustls::sign::Signer;
use rustls_pemfile::Item;
use std::sync::Arc;
use time::OffsetDateTime;

const DEFAULT_SCOPES: &str = "https://www.googleapis.com/auth/cloud-platform";

pub(crate) fn creds_from(js: serde_json::Value) -> Result<Credential> {
    let service_account_info =
        serde_json::from_value::<ServiceAccountInfo>(js).map_err(CredentialError::non_retryable)?;
    let token_provider = ServiceAccountTokenProvider {
        service_account_info,
    };

    Ok(Credential {
        inner: Arc::new(ServiceAccountCredential { token_provider }),
    })
}

/// A representation of a Service Account File. See [Service Account Keys](https://google.aip.dev/auth/4112)
/// for more details.
#[derive(serde::Deserialize, Builder)]
#[builder(setter(into))]
struct ServiceAccountInfo {
    client_email: String,
    private_key_id: String,
    private_key: String,
    project_id: String,
    universe_domain: String,
}

impl std::fmt::Debug for ServiceAccountInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServiceAccountInfo")
            .field("client_email", &self.client_email)
            .field("private_key_id", &self.private_key_id)
            .field("private_key", &"[censored]")
            .field("project_id", &self.project_id)
            .field("universe_domain", &self.universe_domain)
            .finish()
    }
}

#[derive(Debug)]
struct ServiceAccountCredential<T>
where
    T: TokenProvider,
{
    token_provider: T,
}

#[derive(Debug)]
struct ServiceAccountTokenProvider {
    service_account_info: ServiceAccountInfo,
}

#[async_trait]
impl TokenProvider for ServiceAccountTokenProvider {
    async fn get_token(&self) -> Result<Token> {
        let signer = self.signer(&self.service_account_info.private_key)?;

        let expires_at = std::time::Instant::now() - CLOCK_SKEW_FUDGE + DEFAULT_TOKEN_TIMEOUT;
        let now = OffsetDateTime::now_utc() - CLOCK_SKEW_FUDGE;
        let exp = now + DEFAULT_TOKEN_TIMEOUT;
        let claims = JwsClaims {
            iss: self.service_account_info.client_email.clone(),
            scope: Some(DEFAULT_SCOPES.to_string()),
            aud: None,
            exp,
            iat: now,
            typ: None,
            sub: Some(self.service_account_info.client_email.clone()),
        };

        let header = JwsHeader {
            alg: "RS256",
            typ: "JWT",
            kid: &self.service_account_info.private_key_id,
        };
        let encoded_header_claims = format!("{}.{}", header.encode()?, claims.encode()?);
        let sig = signer
            .sign(encoded_header_claims.as_bytes())
            .map_err(CredentialError::non_retryable)?;
        use base64::prelude::{Engine as _, BASE64_URL_SAFE_NO_PAD};
        let token = format!(
            "{}.{}",
            encoded_header_claims,
            &BASE64_URL_SAFE_NO_PAD.encode(sig)
        );

        let token = Token {
            token,
            token_type: "Bearer".to_string(),
            expires_at: Some(expires_at),
            metadata: None,
        };
        Ok(token)
    }
}

impl ServiceAccountTokenProvider {
    fn signer(&self, private_key: &String) -> Result<Box<dyn Signer>> {
        // The Buck graph uses one Rustls crypto backend across native libraries.
        let key_provider = CryptoProvider::get_default().map_or_else(
            || rustls::crypto::ring::default_provider().key_provider,
            |provider| provider.key_provider,
        );

        let private_key = rustls_pemfile::read_one(&mut private_key.as_bytes())
            .map_err(CredentialError::non_retryable)?
            .ok_or_else(|| {
                CredentialError::non_retryable_from_str(
                    "missing PEM section in service account key",
                )
            })?;
        let pk = match private_key {
            Item::Pkcs8Key(item) => key_provider.load_private_key(item.into()),
            other => {
                return Err(Self::unexpected_private_key_error(other));
            }
        };
        let sk = pk.map_err(CredentialError::non_retryable)?;
        sk.choose_scheme(&[rustls::SignatureScheme::RSA_PKCS1_SHA256])
            .ok_or_else(|| CredentialError::non_retryable_from_str("Unable to choose RSA_PKCS1_SHA256 signing scheme as it is not supported by current signer"))
    }

    fn unexpected_private_key_error(private_key_format: Item) -> CredentialError {
        CredentialError::non_retryable_from_str(format!(
            "expected key to be in form of PKCS8, found {:?}",
            private_key_format
        ))
    }
}

#[async_trait::async_trait]
impl<T> CredentialTrait for ServiceAccountCredential<T>
where
    T: TokenProvider,
{
    async fn get_token(&self) -> Result<Token> {
        self.token_provider.get_token().await
    }

    async fn get_headers(&self) -> Result<Vec<(HeaderName, HeaderValue)>> {
        let token = self.get_token().await?;
        let mut value = HeaderValue::from_str(&format!("{} {}", token.token_type, token.token))
            .map_err(CredentialError::non_retryable)?;
        value.set_sensitive(true);
        Ok(vec![(AUTHORIZATION, value)])
    }
}
