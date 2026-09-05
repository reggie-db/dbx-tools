use std::{collections::HashMap, path::PathBuf, time::Duration};

use async_trait::async_trait;
use tokio::sync::RwLock;

use super::{CredentialStore, FileStore, StorageLock};
use crate::{Result, Token};

pub struct MemoryStore {
    tokens: RwLock<HashMap<String, Token>>,
    lock_store: FileStore,
}

impl MemoryStore {
    pub fn new(lock_directory: PathBuf) -> Result<Self> {
        Ok(Self {
            tokens: RwLock::new(HashMap::new()),
            lock_store: FileStore::new(lock_directory)?,
        })
    }
}

#[async_trait]
impl CredentialStore for MemoryStore {
    async fn load(&self, profile: &str) -> Result<Option<Token>> {
        Ok(self.tokens.read().await.get(profile).cloned())
    }

    async fn save(&self, profile: &str, token: &Token) -> Result<()> {
        self.tokens
            .write()
            .await
            .insert(profile.to_owned(), token.clone());
        Ok(())
    }

    async fn delete(&self, profile: &str) -> Result<()> {
        self.tokens.write().await.remove(profile);
        Ok(())
    }

    async fn lock(&self, profile: &str, timeout: Duration) -> Result<Box<dyn StorageLock>> {
        Ok(Box::new(
            self.lock_store.acquire_file_lock(profile, timeout).await?,
        ))
    }

    fn name(&self) -> &'static str {
        "memory"
    }
}
