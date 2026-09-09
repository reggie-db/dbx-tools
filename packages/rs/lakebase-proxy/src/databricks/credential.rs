//! Databricks Lakebase database credential generation.

use serde_json::{json, Value};

use super::{session::DatabricksSessionCache, DatabricksError};

const CREDENTIALS_PATH: &str = "/api/2.0/postgres/credentials";

pub(super) async fn generate_database_credential(
    sessions: &DatabricksSessionCache,
    startup_user: Option<&str>,
    endpoint: &str,
) -> Result<String, DatabricksError> {
    let profile = sessions.resolve_profile(startup_user)?;
    let response = sessions
        .get(profile.as_deref())
        .await?
        .post(
            CREDENTIALS_PATH,
            json!({
                "endpoint": endpoint,
            }),
        )
        .await?;
    response
        .get("token")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            DatabricksError::InvalidResponse("credential response did not contain token".into())
        })
}
