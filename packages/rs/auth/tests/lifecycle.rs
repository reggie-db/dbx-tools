use dbx_tools_auth::{
    credential_key, AuthClient, AuthOptions, AuthSession, CredentialStore, Error, FileLayout,
    FileStore, Result, Token, TokenProvider,
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use time::OffsetDateTime;

struct Provider {
    calls: AtomicUsize,
}

struct Session(AuthClient);

impl AuthSession for Session {
    fn auth_client(&self) -> &AuthClient {
        &self.0
    }
}

#[test]
fn lifecycle_options_have_shared_defaults_and_signed_refresh_windows() {
    let options = AuthOptions::default();
    assert_eq!(options.lock_timeout(), Duration::from_secs(30));
    assert_eq!(options.login_timeout(), Duration::from_secs(3600));
    assert_eq!(options.refresh_buffer(), time::Duration::seconds(300));
    let options = AuthOptions {
        refresh_buffer_seconds: -5,
        ..options
    };
    assert_eq!(options.refresh_buffer(), time::Duration::seconds(-5));
}

#[tokio::test]
async fn session_defaults_preserve_login_policy_refresh_and_logout() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(Provider {
        calls: AtomicUsize::new(0),
    });
    let store = Arc::new(FileStore::new(directory.path().to_path_buf()).unwrap());
    let session = Session(AuthClient::new(
        "key".into(),
        provider.clone(),
        store.clone(),
        AuthOptions::default(),
    ));
    assert!(matches!(
        session.token_with_login(Some(false)).await,
        Err(Error::LoginRequired(_))
    ));
    assert!(matches!(
        session.force_refresh().await,
        Err(Error::LoginRequired(_))
    ));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        session.token_with_login(None).await.unwrap().access_token,
        "access-0"
    );
    assert_eq!(
        session
            .token_with_login(Some(false))
            .await
            .unwrap()
            .access_token,
        "access-0"
    );
    assert_eq!(
        session
            .token_with_login(Some(true))
            .await
            .unwrap()
            .access_token,
        "access-1"
    );
    assert_eq!(
        session
            .refresh_rejected_token("access-0")
            .await
            .unwrap()
            .access_token,
        "access-1"
    );
    assert_eq!(
        session.force_refresh().await.unwrap().access_token,
        "access-2"
    );
    assert!(session.token().await.unwrap().refresh_token.is_none());
    assert_eq!(session.store_name(), "file");
    session.logout().await.unwrap();
    assert!(store.load("key").await.unwrap().is_none());
}

#[async_trait::async_trait]
impl TokenProvider for Provider {
    async fn authenticate(&self, _timeout: Duration) -> Result<Token> {
        let sequence = self.calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(10)).await;
        Ok(Token {
            access_token: format!("access-{sequence}"),
            token_type: "Bearer".into(),
            refresh_token: Some("refresh".into()),
            expires_at: Some(OffsetDateTime::now_utc() + time::Duration::hours(1)),
            scopes: vec!["scope".into()],
        })
    }
    async fn refresh(&self, _token: &Token) -> Result<Token> {
        self.authenticate(Duration::ZERO).await
    }
}

#[test]
fn credential_identity_is_provider_profile_and_sorted_scope_set() {
    let first = credential_key(
        "one".into(),
        None,
        vec!["b".into(), " a ".into(), "a".into()],
    );
    assert_eq!(
        first,
        credential_key("one".into(), None, vec!["a".into(), "b".into()])
    );
    assert_ne!(
        first,
        credential_key("two".into(), None, vec!["a".into(), "b".into()])
    );
    assert_ne!(
        first,
        credential_key(
            "one".into(),
            Some("profile".into()),
            vec!["a".into(), "b".into()]
        )
    );
    assert_ne!(first, credential_key("one".into(), None, vec!["a".into()]));
}

#[tokio::test]
async fn concurrent_logins_and_rejected_refreshes_mint_once() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(Provider {
        calls: AtomicUsize::new(0),
    });
    let store = Arc::new(FileStore::new(directory.path().to_path_buf()).unwrap());
    let first = AuthClient::new(
        "key".into(),
        provider.clone(),
        store.clone(),
        AuthOptions::default(),
    );
    let second = AuthClient::new(
        "key".into(),
        provider.clone(),
        Arc::new(FileStore::new(directory.path().to_path_buf()).unwrap()),
        AuthOptions::default(),
    );
    let (one, two) = tokio::join!(first.token_or_login(), second.token_or_login());
    assert_eq!(one.unwrap().access_token, two.unwrap().access_token);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let (one, two) = tokio::join!(
        first.refresh_rejected_token("access-0"),
        second.refresh_rejected_token("access-0")
    );
    assert_eq!(one.unwrap().access_token, two.unwrap().access_token);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    assert!(first.token().await.unwrap().refresh_token.is_none());
    assert!(store
        .load("key")
        .await
        .unwrap()
        .unwrap()
        .refresh_token
        .is_some());
    first.logout().await.unwrap();
    assert!(store.load("key").await.unwrap().is_none());
}

#[tokio::test]
async fn per_credential_files_and_locks_are_independent() {
    let directory = tempfile::tempdir().unwrap();
    let store =
        FileStore::with_layout(directory.path().to_path_buf(), FileLayout::PerCredential).unwrap();
    let first = store.lock("first", Duration::from_secs(1)).await.unwrap();
    let second = store.lock("second", Duration::from_secs(1)).await.unwrap();
    let provider = Provider {
        calls: AtomicUsize::new(0),
    };
    let token = provider.authenticate(Duration::ZERO).await.unwrap();
    store.save("first", &token).await.unwrap();
    store.save("second", &token).await.unwrap();
    store.delete("first").await.unwrap();
    assert!(store.load("first").await.unwrap().is_none());
    assert_eq!(store.load("second").await.unwrap().unwrap(), token);
    drop((first, second));
}

#[tokio::test]
async fn rejected_refresh_does_not_reuse_a_different_expired_token() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(Provider {
        calls: AtomicUsize::new(0),
    });
    let store = Arc::new(FileStore::new(directory.path().to_path_buf()).unwrap());
    let mut expired = provider.authenticate(Duration::ZERO).await.unwrap();
    expired.expires_at = Some(OffsetDateTime::now_utc() - time::Duration::hours(1));
    store.save("key", &expired).await.unwrap();
    let client = AuthClient::new(
        "key".into(),
        provider.clone(),
        store,
        AuthOptions::default(),
    );
    assert_eq!(
        client
            .refresh_rejected_token("older-token")
            .await
            .unwrap()
            .access_token,
        "access-1"
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
}
