use std::{path::PathBuf, sync::Arc, time::Duration};

use dbx_tools_u2m::{
    open_store, AuthClient, AuthOptions, CredentialStore, Profile, ProfileOptions, StoreBackend,
    StoreOptions, TargetKind,
};
use pyo3::{exceptions::PyRuntimeError, prelude::*};
use time::Duration as TimeDuration;

#[pyclass(get_all, frozen)]
#[derive(Clone)]
struct AccessToken {
    access_token: String,
    token_type: String,
    expiry: Option<String>,
    scopes: Vec<String>,
}

#[pymethods]
impl AccessToken {
    fn __repr__(&self) -> String {
        format!(
            "AccessToken(token_type={:?}, expiry={:?}, scopes={:?})",
            self.token_type, self.expiry, self.scopes
        )
    }
}

#[pyclass]
struct U2mClient {
    runtime: tokio::runtime::Runtime,
    inner: Arc<AuthClient>,
}

#[pymethods]
impl U2mClient {
    #[new]
    #[pyo3(signature = (
        profile=None,
        host=None,
        account_id=None,
        workspace_id=None,
        config_file=None,
        client_id=None,
        scopes=None,
        target=None,
        storage=None,
        cache_dir=None,
        postgres_url=None,
        lock_timeout_seconds=30,
        login_timeout_seconds=3600,
        refresh_buffer_seconds=300,
    ))]
    #[allow(clippy::too_many_arguments)]
    fn new(
        profile: Option<String>,
        host: Option<String>,
        account_id: Option<String>,
        workspace_id: Option<String>,
        config_file: Option<String>,
        client_id: Option<String>,
        scopes: Option<Vec<String>>,
        target: Option<String>,
        storage: Option<String>,
        cache_dir: Option<String>,
        postgres_url: Option<String>,
        lock_timeout_seconds: u64,
        login_timeout_seconds: u64,
        refresh_buffer_seconds: i64,
    ) -> PyResult<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(binding_error)?;
        let profile = Profile::from_sources(ProfileOptions {
            profile,
            host,
            account_id,
            workspace_id,
            client_id,
            scopes,
            target: target.as_deref().map(parse_target).transpose()?,
            config_file: config_file.as_deref().map(PathBuf::from),
        })
        .map_err(binding_error)?;
        let store = runtime.block_on(open_binding_store(
            storage.as_deref(),
            cache_dir.as_deref(),
            config_file.as_deref(),
            postgres_url.as_deref(),
        ))?;
        let inner = AuthClient::new(
            profile,
            store,
            AuthOptions {
                refresh_buffer: TimeDuration::seconds(refresh_buffer_seconds),
                lock_timeout: Duration::from_secs(lock_timeout_seconds),
                login_timeout: Duration::from_secs(login_timeout_seconds),
            },
        )
        .map_err(binding_error)?;
        Ok(Self {
            runtime,
            inner: Arc::new(inner),
        })
    }

    fn login(&self, py: Python<'_>) -> PyResult<AccessToken> {
        py.allow_threads(|| self.runtime.block_on(self.inner.login()))
            .map(Into::into)
            .map_err(binding_error)
    }

    fn token(&self, py: Python<'_>) -> PyResult<AccessToken> {
        py.allow_threads(|| self.runtime.block_on(self.inner.token()))
            .map(Into::into)
            .map_err(binding_error)
    }

    fn token_or_login(&self, py: Python<'_>) -> PyResult<AccessToken> {
        py.allow_threads(|| self.runtime.block_on(self.inner.token_or_login()))
            .map(Into::into)
            .map_err(binding_error)
    }

    fn force_refresh(&self, py: Python<'_>) -> PyResult<AccessToken> {
        py.allow_threads(|| self.runtime.block_on(self.inner.force_refresh()))
            .map(Into::into)
            .map_err(binding_error)
    }

    fn logout(&self, py: Python<'_>) -> PyResult<()> {
        py.allow_threads(|| self.runtime.block_on(self.inner.logout()))
            .map_err(binding_error)
    }

    #[getter]
    fn profile(&self) -> String {
        self.inner.profile().name.clone()
    }

    #[getter]
    fn host(&self) -> String {
        self.inner.profile().host.to_string()
    }

    #[getter]
    fn storage(&self) -> String {
        self.inner.store_name().to_owned()
    }
}

impl From<dbx_tools_u2m::Token> for AccessToken {
    fn from(token: dbx_tools_u2m::Token) -> Self {
        Self {
            access_token: token.access_token,
            token_type: token.token_type,
            expiry: token.expires_at.map(|value| value.to_string()),
            scopes: token.scopes,
        }
    }
}

async fn open_binding_store(
    storage: Option<&str>,
    cache_dir: Option<&str>,
    config_file: Option<&str>,
    postgres_url: Option<&str>,
) -> PyResult<Arc<dyn CredentialStore>> {
    #[cfg(feature = "postgres")]
    if let Some(url) = postgres_url {
        return Ok(Arc::new(
            dbx_tools_u2m_postgres::PostgresStore::connect(url)
                .await
                .map_err(binding_error)?,
        ));
    }
    #[cfg(not(feature = "postgres"))]
    if postgres_url.is_some() {
        return Err(PyRuntimeError::new_err(
            "Postgres support was not compiled in",
        ));
    }

    open_store(StoreOptions {
        backend: storage.map(parse_storage).transpose()?,
        cache_dir: cache_dir.map(PathBuf::from),
        config_file: config_file.map(PathBuf::from),
    })
    .await
    .map_err(binding_error)
}

fn parse_target(value: &str) -> PyResult<TargetKind> {
    match value.trim().to_ascii_lowercase().as_str() {
        "workspace" => Ok(TargetKind::Workspace),
        "account" => Ok(TargetKind::Account),
        "unified" => Ok(TargetKind::Unified),
        _ => Err(PyRuntimeError::new_err(
            "target must be workspace, account, or unified",
        )),
    }
}

fn parse_storage(value: &str) -> PyResult<StoreBackend> {
    match value.trim().to_ascii_lowercase().as_str() {
        "auto" => Ok(StoreBackend::Auto),
        "memory" => Ok(StoreBackend::Memory),
        "file" | "plaintext" => Ok(StoreBackend::File),
        "keyring" | "secure" => Ok(StoreBackend::Keyring),
        _ => Err(PyRuntimeError::new_err(
            "storage must be auto, memory, file, or keyring",
        )),
    }
}

fn binding_error(error: impl std::fmt::Display) -> PyErr {
    PyRuntimeError::new_err(error.to_string())
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<AccessToken>()?;
    module.add_class::<U2mClient>()?;
    Ok(())
}
