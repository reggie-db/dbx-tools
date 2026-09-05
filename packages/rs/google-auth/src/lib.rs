use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use dbx_tools_auth::{
    credential_key, AccessToken, AuthClient, AuthError, AuthOptions, AuthSession, BindingResult,
    MemoryStore, Result, Token, TokenProvider,
};
use google_cloud_auth::credentials::{create_access_token_credential, Credential};

const PROVIDER: &str = "google-adc";

/// Options for Google Application Default Credentials.
#[derive(Clone, uniffi::Record)]
pub struct GoogleAuthOptions {
    /// Shared token lifetime and lock configuration.
    #[uniffi(default = None)]
    pub auth: Option<AuthOptions>,
    /// Conservative lifetime used when the ADC provider omits token expiry.
    #[uniffi(default = 3600)]
    pub access_token_ttl_seconds: u64,
}

impl Default for GoogleAuthOptions {
    fn default() -> Self {
        Self {
            auth: None,
            access_token_ttl_seconds: 3600,
        }
    }
}

/// Active Google ADC source and access-token cache information.
#[derive(Clone, uniffi::Record)]
pub struct GoogleAuthStatus {
    /// ADC file selected through `GOOGLE_APPLICATION_CREDENTIALS` or gcloud's well-known path.
    pub credentials_path: Option<String>,
    /// Short-lived access tokens are retained only in process memory.
    pub storage: String,
}

struct GoogleFlow {
    credential: Credential,
    access_token_ttl: Duration,
}

#[async_trait::async_trait]
impl TokenProvider for GoogleFlow {
    async fn authenticate(&self, _timeout: Duration) -> Result<Token> {
        self.token().await
    }

    async fn refresh(&self, _token: &Token) -> Result<Token> {
        self.token().await
    }

    fn can_authenticate_silently(&self) -> bool {
        true
    }
}

impl GoogleFlow {
    async fn token(&self) -> Result<Token> {
        let token = self
            .credential
            .get_token()
            .await
            .map_err(|error| dbx_tools_auth::Error::OAuth(format!("Google ADC: {error}")))?;
        let now = time::OffsetDateTime::now_utc();
        let expires_at = token
            .expires_at
            .map(|expiry| {
                expiry
                    .checked_duration_since(Instant::now())
                    .unwrap_or_default()
            })
            .unwrap_or(self.access_token_ttl);
        let expires_at = time::Duration::try_from(expires_at)
            .ok()
            .and_then(|duration| now.checked_add(duration));
        Ok(Token {
            access_token: token.token,
            token_type: token.token_type,
            refresh_token: None,
            expires_at,
            scopes: vec![],
        })
    }
}

/// Google ADC binding facade over the shared in-process token lifecycle.
#[derive(uniffi::Object)]
pub struct GoogleAuth {
    inner: AuthClient,
    credentials_path: Option<PathBuf>,
}

impl AuthSession for GoogleAuth {
    fn auth_client(&self) -> &AuthClient {
        &self.inner
    }
}

/// Load Google ADC from its standard source without invoking gcloud.
#[uniffi::export(async_runtime = "tokio")]
pub async fn create_google_auth(options: GoogleAuthOptions) -> BindingResult<Arc<GoogleAuth>> {
    let credentials_path = adc_path();
    let credential = create_access_token_credential().await.map_err(failure)?;
    let store = MemoryStore::new();
    let key = credential_key(
        PROVIDER.into(),
        credentials_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        vec![],
    );
    let inner = AuthClient::new(
        key,
        Arc::new(GoogleFlow {
            credential,
            access_token_ttl: Duration::from_secs(options.access_token_ttl_seconds),
        }),
        Arc::new(store),
        options.auth.unwrap_or_default(),
    );
    Ok(Arc::new(GoogleAuth {
        inner,
        credentials_path,
    }))
}

#[uniffi::export(async_runtime = "tokio")]
impl GoogleAuth {
    /// Return a cached token or refresh it from ADC.
    pub async fn token(&self) -> BindingResult<AccessToken> {
        AuthSession::token(self)
            .await
            .map(Into::into)
            .map_err(failure)
    }

    /// Refresh ADC even when the current token is outside its refresh window.
    pub async fn force_refresh_token(&self) -> BindingResult<AccessToken> {
        AuthSession::force_refresh(self)
            .await
            .map(Into::into)
            .map_err(failure)
    }

    /// Reuse a concurrent replacement or refresh the rejected access token.
    pub async fn refresh_rejected_token(
        &self,
        stale_access_token: String,
    ) -> BindingResult<AccessToken> {
        AuthSession::refresh_rejected_token(self, &stale_access_token)
            .await
            .map(Into::into)
            .map_err(failure)
    }

    /// Clear the in-process access-token cache without modifying ADC.
    pub async fn logout(&self) -> BindingResult<()> {
        AuthSession::logout(self).await.map_err(failure)
    }

    /// Return the selected ADC path and short-lived token storage mode.
    pub fn status(&self) -> GoogleAuthStatus {
        GoogleAuthStatus {
            credentials_path: self
                .credentials_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            storage: self.inner.store_name().into(),
        }
    }
}

fn adc_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS") {
        return Some(PathBuf::from(path));
    }
    well_known_adc_path().filter(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn well_known_adc_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("gcloud/application_default_credentials.json"))
}

#[cfg(not(target_os = "windows"))]
fn well_known_adc_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|root| root.join(".config/gcloud/application_default_credentials.json"))
}

fn failure(error: impl std::fmt::Display) -> AuthError {
    AuthError::Failure {
        message: error.to_string(),
    }
}

uniffi::setup_scaffolding!();

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_google_token_uses_shared_lifecycle_shape() {
        let flow = GoogleFlow {
            credential: google_cloud_auth::credentials::testing::test_credentials(),
            access_token_ttl: Duration::from_secs(3600),
        };

        let token = flow.token().await.unwrap();

        assert_eq!(token.access_token, "test-only-token");
        assert_eq!(token.token_type, "Bearer");
        assert!(token.refresh_token.is_none());
        assert!(token.expires_at.is_some());
        assert!(token.scopes.is_empty());
    }

    #[test]
    fn google_options_use_a_one_hour_fallback_lifetime() {
        assert_eq!(GoogleAuthOptions::default().access_token_ttl_seconds, 3600);
    }
}
