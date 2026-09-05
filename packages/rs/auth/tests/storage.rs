use std::{sync::Arc, time::Duration};

use dbx_tools_auth::{CredentialStore, FileStore, MemoryStore, Token};
use tempfile::tempdir;
use time::OffsetDateTime;

fn token(value: &str) -> Token {
    Token {
        access_token: value.to_owned(),
        token_type: "Bearer".to_owned(),
        refresh_token: Some("refresh".to_owned()),
        expires_at: Some(OffsetDateTime::now_utc() + time::Duration::hours(1)),
        scopes: vec!["all-apis".to_owned(), "offline_access".to_owned()],
    }
}

#[tokio::test]
async fn memory_store_round_trips_tokens() {
    let store = MemoryStore::new();
    store.save("profile", &token("access")).await.unwrap();
    assert_eq!(
        store.load("profile").await.unwrap().unwrap().access_token,
        "access"
    );
    store.delete("profile").await.unwrap();
    assert!(store.load("profile").await.unwrap().is_none());
}

#[tokio::test]
async fn file_store_round_trips_tokens() {
    let directory = tempdir().unwrap();
    let store = FileStore::new(directory.path().to_path_buf()).unwrap();
    store.save("profile", &token("access")).await.unwrap();
    assert_eq!(
        store.load("profile").await.unwrap().unwrap().access_token,
        "access"
    );
    let raw = std::fs::read_to_string(directory.path().join("token-cache.json")).unwrap();
    assert!(raw.contains("\"version\": 1"));
    assert!(raw.contains("\"profile\""));
    assert!(raw.contains("\"expiry\""));
}

#[tokio::test]
async fn file_refresh_locks_are_exclusive_across_profiles() {
    let directory = tempdir().unwrap();
    let first = Arc::new(FileStore::new(directory.path().to_path_buf()).unwrap());
    let second = Arc::new(FileStore::new(directory.path().to_path_buf()).unwrap());
    let held = first.lock("profile", Duration::from_secs(1)).await.unwrap();
    let error = match second
        .lock("other-profile", Duration::from_millis(100))
        .await
    {
        Ok(_) => panic!("second store unexpectedly acquired the profile lock"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("timed out"));
    drop(held);
    second
        .lock("profile", Duration::from_secs(1))
        .await
        .unwrap();
}

#[tokio::test]
async fn file_store_preserves_other_cli_entries() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("token-cache.json");
    let existing = serde_json::json!({"access_token": "cli", "custom": {"future": true}});
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "version": 1, "tokens": {"other": existing}
        }))
        .unwrap(),
    )
    .unwrap();
    let store = FileStore::new(directory.path().to_path_buf()).unwrap();
    let held = store.lock("profile", Duration::from_secs(1)).await.unwrap();
    store.save("profile", &token("access")).await.unwrap();
    store.delete("profile").await.unwrap();
    drop(held);
    let actual: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(actual["tokens"]["other"], existing);
}
