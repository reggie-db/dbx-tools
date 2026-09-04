use std::time::Duration;

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};

use dbx_tools_u2m::{CredentialStore, Error, Result, StorageLock, Token};

pub struct PostgresStore {
    pool: PgPool,
}

impl PostgresStore {
    pub async fn connect(url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(url)
            .await
            .map_err(sqlx_error)?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS dbx_tools_u2m_tokens (profile TEXT PRIMARY KEY, token JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
        )
        .execute(&pool)
        .await
        .map_err(sqlx_error)?;
        Ok(Self { pool })
    }
}

struct PostgresLock(#[allow(dead_code)] sqlx::pool::PoolConnection<sqlx::Postgres>);
impl StorageLock for PostgresLock {}

#[async_trait]
impl CredentialStore for PostgresStore {
    async fn load(&self, profile: &str) -> Result<Option<Token>> {
        let raw: Option<serde_json::Value> =
            sqlx::query_scalar("SELECT token FROM dbx_tools_u2m_tokens WHERE profile = $1")
                .bind(profile)
                .fetch_optional(&self.pool)
                .await
                .map_err(sqlx_error)?;
        raw.map(serde_json::from_value)
            .transpose()
            .map_err(Into::into)
    }

    async fn save(&self, profile: &str, token: &Token) -> Result<()> {
        sqlx::query(
            "INSERT INTO dbx_tools_u2m_tokens(profile, token) VALUES ($1, $2) ON CONFLICT(profile) DO UPDATE SET token = EXCLUDED.token, updated_at = now()",
        )
        .bind(profile)
        .bind(serde_json::to_value(token)?)
        .execute(&self.pool)
        .await
        .map_err(sqlx_error)?;
        Ok(())
    }

    async fn delete(&self, profile: &str) -> Result<()> {
        sqlx::query("DELETE FROM dbx_tools_u2m_tokens WHERE profile = $1")
            .bind(profile)
            .execute(&self.pool)
            .await
            .map_err(sqlx_error)?;
        Ok(())
    }

    async fn lock(&self, profile: &str, timeout: Duration) -> Result<Box<dyn StorageLock>> {
        let mut connection = self.pool.acquire().await.map_err(sqlx_error)?;
        let lock_id = advisory_lock_id(profile);
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
                .bind(lock_id)
                .fetch_one(&mut *connection)
                .await
                .map_err(sqlx_error)?;
            if acquired {
                return Ok(Box::new(PostgresLock(connection)));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(Error::LockTimeout(profile.to_owned()));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn name(&self) -> &'static str {
        "postgres"
    }
}

fn advisory_lock_id(profile: &str) -> i64 {
    let digest = Sha256::digest(format!("dbx-tools-u2m:{profile}").as_bytes());
    i64::from_be_bytes(digest[..8].try_into().expect("SHA-256 has eight bytes"))
}

fn sqlx_error(error: sqlx::Error) -> Error {
    Error::Storage(format!("Postgres: {error}"))
}
