use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use async_trait::async_trait;
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock};

use super::{CredentialStore, StorageLock};
use crate::{Error, Result, Token};

pub struct MemoryStore {
    tokens: RwLock<HashMap<String, Token>>,
    locks: StdMutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self {
            tokens: RwLock::new(HashMap::new()),
            locks: StdMutex::new(HashMap::new()),
        }
    }
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

struct MemoryLock {
    _guard: OwnedMutexGuard<()>,
}

impl StorageLock for MemoryLock {}

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
        let gate = {
            let mut locks = self
                .locks
                .lock()
                .map_err(|_| Error::Storage("memory lock registry is poisoned".into()))?;
            Arc::clone(
                locks
                    .entry(profile.to_owned())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let guard = tokio::time::timeout(timeout, gate.lock_owned())
            .await
            .map_err(|_| Error::LockTimeout(profile.to_owned()))?;
        Ok(Box::new(MemoryLock { _guard: guard }))
    }

    fn name(&self) -> &'static str {
        "memory"
    }
}
