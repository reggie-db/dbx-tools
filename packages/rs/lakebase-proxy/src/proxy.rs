//! PostgreSQL startup adaptation followed by an opaque bidirectional tunnel.

mod cancellation;
mod startup;
mod statistics;
mod tunnel;

use std::{io, sync::Arc, time::Duration};

use dbx_tools_databricks::{parse_lakebase_address, DatabricksClientError};
use pgwire::error::{PgWireClientError, PgWireError};
use rustls::{ClientConfig, RootCertStore};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::databricks::{DatabricksError, LakebaseClient};

pub use statistics::{report_connection_stats, ConnectionStats};

use self::{
    cancellation::{PostgresCancelTarget, PostgresCancellationMap},
    startup::{
        connect_lakebase_postgres, new_local_postgres_framed, read_postgres_startup,
        send_postgres_error, send_postgres_startup_complete, StartupCompletion,
    },
    tunnel::tunnel_postgres_connection,
};

/// Loopback PostgreSQL proxy backed by per-connection Lakebase sessions.
#[derive(Clone)]
pub struct PostgresProxy {
    databricks: LakebaseClient,
    cancellations: PostgresCancellationMap,
    tls: TlsConnector,
}

impl PostgresProxy {
    /// Create a proxy with certificate-verified upstream TLS.
    pub fn new(databricks: LakebaseClient) -> Result<Self, ProxyError> {
        let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let tls = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|error| ProxyError::Connect(error.to_string()))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Self::with_tls_config(databricks, Arc::new(tls)))
    }

    /// Create a proxy with an explicit upstream TLS configuration.
    pub fn with_tls_config(databricks: LakebaseClient, tls: Arc<ClientConfig>) -> Self {
        Self {
            databricks,
            cancellations: PostgresCancellationMap::default(),
            tls: TlsConnector::from(tls),
        }
    }

    /// Handle one local PostgreSQL connection through startup and opaque tunneling.
    pub async fn handle(
        &self,
        socket: TcpStream,
        startup_timeout: Duration,
    ) -> Result<(), io::Error> {
        let startup_deadline = tokio::time::Instant::now() + startup_timeout;
        let peer = socket.peer_addr()?;
        socket.set_nodelay(true)?;
        let mut local = new_local_postgres_framed(socket, peer);
        let startup = match tokio::time::timeout_at(
            startup_deadline,
            read_postgres_startup(&mut local, &self.cancellations),
        )
        .await
        {
            Err(_) => {
                send_postgres_error(
                    &mut local,
                    &ProxyError::Protocol("startup timed out".into()),
                )
                .await?;
                return Ok(());
            }
            Ok(Ok(Some(startup))) => startup,
            Ok(Ok(None)) => return Ok(()),
            Ok(Err(error)) => {
                send_postgres_error(&mut local, &error).await?;
                return Ok(());
            }
        };
        let profile = startup
            .parameters
            .get("user")
            .map(String::as_str)
            .map(str::trim)
            .filter(|profile| !profile.is_empty());
        let target = match startup
            .parameters
            .get("database")
            .ok_or_else(|| ProxyError::Database("startup database is required".into()))
            .and_then(|database| {
                parse_lakebase_address(database)
                    .map_err(|error| ProxyError::Database(error.to_string()))
            }) {
            Ok(target) => target,
            Err(error) => {
                send_postgres_error(&mut local, &error).await?;
                return Ok(());
            }
        };
        let resolved = match tokio::time::timeout_at(
            startup_deadline,
            self.databricks.resolve_lakebase(profile, &target),
        )
        .await
        {
            Ok(Ok(resolved)) => resolved,
            Ok(Err(error)) => {
                let error = ProxyError::from(error);
                send_postgres_error(&mut local, &error).await?;
                return Ok(());
            }
            Err(_) => {
                send_postgres_error(
                    &mut local,
                    &ProxyError::Connect("Lakebase discovery timed out".into()),
                )
                .await?;
                return Ok(());
            }
        };
        let password = match tokio::time::timeout_at(
            startup_deadline,
            self.databricks
                .generate_database_credential(profile, &resolved.endpoint),
        )
        .await
        {
            Ok(Ok(password)) => password,
            Ok(Err(error)) => {
                let error = ProxyError::from(error);
                send_postgres_error(&mut local, &error).await?;
                return Ok(());
            }
            Err(_) => {
                send_postgres_error(
                    &mut local,
                    &ProxyError::Connect("Lakebase credential request timed out".into()),
                )
                .await?;
                return Ok(());
            }
        };
        let (upstream, info, protocol, transaction, negotiation) = match tokio::time::timeout_at(
            startup_deadline,
            connect_lakebase_postgres(&startup, &resolved, &password, self.tls.clone()),
        )
        .await
        {
            Ok(Ok(upstream)) => upstream,
            Ok(Err(error)) => {
                send_postgres_error(&mut local, &error).await?;
                return Ok(());
            }
            Err(_) => {
                let error = ProxyError::Connect("Lakebase connection timed out".into());
                send_postgres_error(&mut local, &error).await?;
                return Ok(());
            }
        };
        let process_id = self.cancellations.next_synthetic_process_id();
        let secret = self.cancellations.synthetic_secret(protocol, process_id);
        send_postgres_startup_complete(
            &mut local,
            StartupCompletion {
                info: &info,
                process_id,
                secret: secret.clone(),
                requested: (startup.protocol_number_major, startup.protocol_number_minor),
                protocol,
                transaction,
                negotiation,
            },
        )
        .await?;
        let cancel_target = PostgresCancelTarget::new(
            self.tls.clone(),
            resolved.host,
            resolved.port,
            info.process_id,
            info.secret_key.clone(),
        );
        self.cancellations
            .register_postgres_cancellation(process_id, &secret, cancel_target)
            .await;
        let result = tunnel_postgres_connection(local, upstream).await;
        self.cancellations
            .remove_postgres_cancellation(process_id, &secret)
            .await;
        result
    }
}

/// Errors produced while establishing or adapting a PostgreSQL proxy connection.
#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    /// Databricks or Lakebase authentication failed.
    #[error("authentication failed: {0}")]
    Authentication(String),
    /// The requested Lakebase database could not be resolved.
    #[error("database resolution failed: {0}")]
    Database(String),
    /// PostgreSQL startup or protocol handling failed.
    #[error("PostgreSQL protocol failed: {0}")]
    Protocol(String),
    /// The upstream Lakebase connection could not be established.
    #[error("upstream connection failed: {0}")]
    Connect(String),
    /// A network I/O operation failed.
    #[error(transparent)]
    Io(#[from] io::Error),
    /// PostgreSQL wire encoding or decoding failed.
    #[error(transparent)]
    PgWire(#[from] PgWireError),
    /// The upstream PostgreSQL client protocol failed.
    #[error(transparent)]
    PgWireClient(#[from] PgWireClientError),
}

impl ProxyError {
    fn sqlstate(&self) -> &'static str {
        match self {
            Self::Authentication(_) => "28000",
            Self::Database(_) => "3D000",
            Self::PgWireClient(PgWireClientError::RemoteError(error))
                if error.code.starts_with("28") =>
            {
                "28000"
            }
            Self::PgWireClient(
                PgWireClientError::IoError(_) | PgWireClientError::UnexpectedEOF,
            )
            | Self::Connect(_)
            | Self::Io(_) => "08001",
            Self::Protocol(_) | Self::PgWire(_) | Self::PgWireClient(_) => "08P01",
        }
    }
}

impl From<DatabricksError> for ProxyError {
    fn from(error: DatabricksError) -> Self {
        match error {
            DatabricksError::Client(DatabricksClientError::Authentication(error)) => {
                Self::Authentication(error)
            }
            error => Self::Database(error.to_string()),
        }
    }
}
