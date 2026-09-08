//! PostgreSQL startup adaptation followed by an opaque bidirectional tunnel.

use std::{
    collections::{BTreeMap, HashMap},
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicI32, Ordering},
        Arc,
    },
    task::{Context, Poll},
};

use bytes::{Buf, Bytes, BytesMut};
use futures::{Sink, SinkExt, Stream, StreamExt};
use pgwire::{
    api::{
        client::{
            auth::{DefaultStartupHandler, StartupHandler},
            ClientInfo as UpstreamClientInfo, Config, ReadyState, ServerInformation,
        },
        ClientInfo as ServerClientInfo, DefaultClient, PgWireConnectionState,
    },
    error::{PgWireClientError, PgWireError, PgWireResult},
    messages::{
        cancel::CancelRequest,
        response::{ErrorResponse, GssEncResponse, ReadyForQuery, SslResponse, TransactionStatus},
        startup::{
            Authentication, BackendKeyData, NegotiateProtocolVersion, ParameterStatus, SecretKey,
            SslRequest, Startup,
        },
        PgWireBackendMessage, PgWireFrontendMessage, ProtocolVersion, SslNegotiationMetaMessage,
    },
    tokio::{client::PgWireMessageClientCodec, server::PgWireMessageServerCodec},
};
use rustls::{ClientConfig, RootCertStore};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::TcpStream,
};
use tokio_rustls::{client::TlsStream, TlsConnector};
use tokio_util::codec::Framed;

use crate::databricks::{DatabricksError, LakebaseClient, ResolvedLakebase};
use dbx_tools_databricks::{parse_lakebase_address, DatabricksClientError};

static NEXT_PROCESS_ID: AtomicI32 = AtomicI32::new(10_000);

#[derive(Clone)]
pub struct PostgresProxy {
    databricks: LakebaseClient,
    cancellations: CancellationRegistry,
    tls: TlsConnector,
}

impl PostgresProxy {
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

    pub fn with_tls_config(databricks: LakebaseClient, tls: Arc<ClientConfig>) -> Self {
        Self {
            databricks,
            cancellations: CancellationRegistry::default(),
            tls: TlsConnector::from(tls),
        }
    }

    pub async fn handle(
        &self,
        socket: TcpStream,
        startup_timeout: std::time::Duration,
    ) -> Result<(), io::Error> {
        let startup_deadline = tokio::time::Instant::now() + startup_timeout;
        let peer = socket.peer_addr()?;
        socket.set_nodelay(true)?;
        let mut local = Framed::new(
            socket,
            PgWireMessageServerCodec::new(DefaultClient::new(peer, false)),
        );
        let startup = match tokio::time::timeout_at(
            startup_deadline,
            read_startup(&mut local, &self.cancellations),
        )
        .await
        {
            Err(_) => {
                send_error(
                    &mut local,
                    &ProxyError::Protocol("startup timed out".into()),
                )
                .await?;
                return Ok(());
            }
            Ok(Ok(Some(startup))) => startup,
            Ok(Ok(None)) => return Ok(()),
            Ok(Err(error)) => {
                send_error(&mut local, &error).await?;
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
                send_error(&mut local, &error).await?;
                return Ok(());
            }
        };
        let resolved = match tokio::time::timeout_at(
            startup_deadline,
            self.databricks.discover(profile, &target),
        )
        .await
        {
            Ok(Ok(resolved)) => resolved,
            Ok(Err(error)) => {
                let error = ProxyError::from(error);
                send_error(&mut local, &error).await?;
                return Ok(());
            }
            Err(_) => {
                send_error(
                    &mut local,
                    &ProxyError::Connect("Lakebase discovery timed out".into()),
                )
                .await?;
                return Ok(());
            }
        };
        let password = match tokio::time::timeout_at(
            startup_deadline,
            self.databricks.credential(profile, &resolved.endpoint),
        )
        .await
        {
            Ok(Ok(password)) => password,
            Ok(Err(error)) => {
                let error = ProxyError::from(error);
                send_error(&mut local, &error).await?;
                return Ok(());
            }
            Err(_) => {
                send_error(
                    &mut local,
                    &ProxyError::Connect("Lakebase credential request timed out".into()),
                )
                .await?;
                return Ok(());
            }
        };
        let (upstream, info, protocol) = match tokio::time::timeout_at(
            startup_deadline,
            connect_upstream(&startup, &resolved, &password, self.tls.clone()),
        )
        .await
        {
            Ok(Ok(upstream)) => upstream,
            Ok(Err(error)) => {
                send_error(&mut local, &error).await?;
                return Ok(());
            }
            Err(_) => {
                let error = ProxyError::Connect("Lakebase connection timed out".into());
                send_error(&mut local, &error).await?;
                return Ok(());
            }
        };
        let process_id = NEXT_PROCESS_ID.fetch_add(1, Ordering::Relaxed);
        let secret = synthetic_secret(protocol, process_id);
        send_startup_complete(
            &mut local,
            &info,
            process_id,
            secret.clone(),
            startup.protocol_number_major,
            startup.protocol_number_minor,
            protocol,
        )
        .await?;
        let cancel_target = CancelTarget {
            tls: self.tls.clone(),
            host: resolved.host,
            port: resolved.port,
            process_id: info.process_id,
            secret: info.secret_key.clone(),
        };
        self.cancellations
            .insert(process_id, secret.clone(), cancel_target)
            .await;
        let result = tunnel(local, upstream).await;
        self.cancellations.remove(process_id, &secret).await;
        result
    }
}

async fn read_startup(
    socket: &mut LocalFramed,
    cancellations: &CancellationRegistry,
) -> Result<Option<Startup>, ProxyError> {
    loop {
        let message = socket
            .next()
            .await
            .ok_or_else(|| ProxyError::Protocol("connection closed before startup".into()))??;
        match message {
            PgWireFrontendMessage::SslNegotiation(SslNegotiationMetaMessage::PostgresSsl(_)) => {
                socket
                    .send(PgWireBackendMessage::SslResponse(SslResponse::Refuse))
                    .await?;
                socket.set_state(PgWireConnectionState::AwaitingStartup);
            }
            PgWireFrontendMessage::SslNegotiation(SslNegotiationMetaMessage::PostgresGss(_)) => {
                socket
                    .send(PgWireBackendMessage::GssEncResponse(GssEncResponse::Refuse))
                    .await?;
                socket.set_state(PgWireConnectionState::AwaitingStartup);
            }
            PgWireFrontendMessage::SslNegotiation(SslNegotiationMetaMessage::None) => {
                socket.set_state(PgWireConnectionState::AwaitingStartup);
            }
            PgWireFrontendMessage::CancelRequest(cancel) => {
                cancellations.cancel(cancel).await;
                return Ok(None);
            }
            PgWireFrontendMessage::Startup(startup) => return Ok(Some(startup)),
            message => {
                return Err(ProxyError::Protocol(format!(
                    "expected SSLRequest, CancelRequest, or Startup, got {message:?}"
                )));
            }
        }
    }
}

async fn connect_upstream(
    startup: &Startup,
    resolved: &ResolvedLakebase,
    password: &str,
    tls: TlsConnector,
) -> Result<(UpstreamFramed, ServerInformation, ProtocolVersion), ProxyError> {
    let mut config = Config::new();
    config
        .host(&resolved.host)
        .port(resolved.port)
        .user(&resolved.user)
        .password(password)
        .dbname(&resolved.database);
    let protocol = ProtocolVersion::from_version_number(
        startup.protocol_number_major,
        startup.protocol_number_minor,
    )
    .unwrap_or(ProtocolVersion::PROTOCOL3_0);
    config.protocol_version(protocol);
    let config = Arc::new(config);
    let framed = connect_tls_socket(&resolved.host, resolved.port, tls).await?;
    let mut client = StartupClient::new(framed, Arc::clone(&config), protocol);
    let mut parameters = startup.parameters.clone();
    parameters.insert("user".into(), resolved.user.clone());
    parameters.insert("database".into(), resolved.database.clone());
    let mut handler = ProxyStartupHandler {
        inner: DefaultStartupHandler::new(),
        parameters,
    };
    handler.startup(&mut client).await?;
    while let Some(message) = client.next().await {
        if let ReadyState::Ready(info) = handler.on_message(&mut client, message?).await? {
            let protocol = client.protocol_version();
            return Ok((client.into_inner(), info, protocol));
        }
    }
    Err(ProxyError::Connect(
        "upstream closed before startup completed".into(),
    ))
}

async fn connect_tls_socket(
    host: &str,
    port: u16,
    tls: TlsConnector,
) -> Result<UpstreamFramed, ProxyError> {
    let tcp = TcpStream::connect((host, port)).await?;
    tcp.set_nodelay(true)?;
    let mut framed = Framed::new(tcp, PgWireMessageClientCodec::default());
    framed
        .send(PgWireFrontendMessage::SslNegotiation(
            SslNegotiationMetaMessage::PostgresSsl(SslRequest::new()),
        ))
        .await?;
    match framed.next().await {
        Some(Ok(PgWireBackendMessage::SslResponse(SslResponse::Accept))) => {}
        Some(Ok(_)) => return Err(ProxyError::Connect("upstream refused TLS".into())),
        Some(Err(error)) => return Err(error.into()),
        None => {
            return Err(ProxyError::Connect(
                "upstream closed during TLS negotiation".into(),
            ));
        }
    }
    let parts = framed.into_parts();
    let prefixed = PrefixedIo::new(parts.io, parts.read_buf);
    let server_name = rustls::pki_types::ServerName::try_from(host.to_owned())
        .map_err(|error| ProxyError::Connect(error.to_string()))?;
    let stream = tls.connect(server_name, prefixed).await?;
    Ok(Framed::new(stream, PgWireMessageClientCodec::default()))
}

async fn send_startup_complete(
    socket: &mut LocalFramed,
    info: &ServerInformation,
    process_id: i32,
    secret: SecretKey,
    requested_major: u16,
    requested_minor: u16,
    protocol: ProtocolVersion,
) -> Result<(), io::Error> {
    if ProtocolVersion::from_version_number(requested_major, requested_minor) != Some(protocol) {
        socket
            .feed(PgWireBackendMessage::NegotiateProtocolVersion(
                NegotiateProtocolVersion::new(protocol.into(), vec![]),
            ))
            .await?;
    }
    socket
        .feed(PgWireBackendMessage::Authentication(Authentication::Ok))
        .await?;
    for (name, value) in &info.parameters {
        socket
            .feed(PgWireBackendMessage::ParameterStatus(ParameterStatus::new(
                name.clone(),
                value.clone(),
            )))
            .await?;
    }
    socket
        .feed(PgWireBackendMessage::BackendKeyData(BackendKeyData::new(
            process_id, secret,
        )))
        .await?;
    socket
        .feed(PgWireBackendMessage::ReadyForQuery(ReadyForQuery::new(
            TransactionStatus::Idle,
        )))
        .await?;
    socket.flush().await
}

async fn tunnel(local: LocalFramed, upstream: UpstreamFramed) -> Result<(), io::Error> {
    let local_parts = local.into_parts();
    let upstream_parts = upstream.into_parts();
    let mut local = local_parts.io;
    let mut upstream = upstream_parts.io;
    if !upstream_parts.read_buf.is_empty() {
        local.write_all(&upstream_parts.read_buf).await?;
    }
    if !local_parts.read_buf.is_empty() {
        upstream.write_all(&local_parts.read_buf).await?;
    }
    tokio::io::copy_bidirectional(&mut local, &mut upstream).await?;
    Ok(())
}

async fn send_error(socket: &mut LocalFramed, error: &ProxyError) -> Result<(), io::Error> {
    socket
        .send(PgWireBackendMessage::ErrorResponse(ErrorResponse::new(
            vec![
                (b'S', "FATAL".into()),
                (b'C', error.sqlstate().into()),
                (b'M', error.to_string()),
            ],
        )))
        .await
}

fn synthetic_secret(protocol: ProtocolVersion, process_id: i32) -> SecretKey {
    let secret = process_id.rotate_left(13) ^ 0x5a17_2c4d;
    if protocol == ProtocolVersion::PROTOCOL3_0 {
        SecretKey::I32(secret)
    } else {
        SecretKey::Bytes(Bytes::copy_from_slice(&secret.to_be_bytes()))
    }
}

type LocalFramed = Framed<TcpStream, PgWireMessageServerCodec<()>>;
type TlsIo = TlsStream<PrefixedIo<TcpStream>>;
type UpstreamFramed = Framed<TlsIo, PgWireMessageClientCodec>;

struct StartupClient<S> {
    socket: Framed<S, PgWireMessageClientCodec>,
    config: Arc<Config>,
    parameters: BTreeMap<String, String>,
    process_id: i32,
    secret: SecretKey,
    protocol: ProtocolVersion,
    transaction: TransactionStatus,
}

impl<S> StartupClient<S> {
    fn new(
        socket: Framed<S, PgWireMessageClientCodec>,
        config: Arc<Config>,
        protocol: ProtocolVersion,
    ) -> Self {
        Self {
            socket,
            config,
            parameters: BTreeMap::new(),
            process_id: -1,
            secret: SecretKey::default(),
            protocol,
            transaction: TransactionStatus::Idle,
        }
    }

    fn into_inner(self) -> Framed<S, PgWireMessageClientCodec> {
        self.socket
    }
}

impl<S: AsyncRead + Unpin> Stream for StartupClient<S> {
    type Item = PgWireResult<PgWireBackendMessage>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.get_mut().socket).poll_next(context)
    }
}

impl<S: AsyncWrite + Unpin> Sink<PgWireFrontendMessage> for StartupClient<S> {
    type Error = PgWireError;

    fn poll_ready(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.get_mut().socket).poll_ready(context)
    }

    fn start_send(self: Pin<&mut Self>, message: PgWireFrontendMessage) -> Result<(), Self::Error> {
        Pin::new(&mut self.get_mut().socket).start_send(message)
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.get_mut().socket).poll_flush(context)
    }

    fn poll_close(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.get_mut().socket).poll_close(context)
    }
}

impl<S> UpstreamClientInfo for StartupClient<S> {
    fn config(&self) -> &Config {
        &self.config
    }

    fn server_parameters(&self) -> &BTreeMap<String, String> {
        &self.parameters
    }

    fn set_server_parameter(&mut self, name: String, value: String) {
        self.parameters.insert(name, value);
    }

    fn process_id(&self) -> i32 {
        self.process_id
    }

    fn secret_key(&self) -> &SecretKey {
        &self.secret
    }

    fn protocol_version(&self) -> ProtocolVersion {
        self.protocol
    }

    fn set_protocol_version(&mut self, protocol: ProtocolVersion) {
        self.protocol = protocol;
    }

    fn transaction_status(&self) -> TransactionStatus {
        self.transaction
    }

    fn set_transaction_status(&mut self, transaction: TransactionStatus) {
        self.transaction = transaction;
    }
}

struct ProxyStartupHandler {
    inner: DefaultStartupHandler,
    parameters: BTreeMap<String, String>,
}

#[async_trait::async_trait]
impl StartupHandler for ProxyStartupHandler {
    async fn startup<C>(&mut self, client: &mut C) -> Result<(), PgWireClientError>
    where
        C: UpstreamClientInfo + Sink<PgWireFrontendMessage> + Unpin + Send,
        PgWireClientError: From<<C as Sink<PgWireFrontendMessage>>::Error>,
    {
        let (major, minor) = client.protocol_version().version_number();
        let mut startup = Startup::new();
        startup.protocol_number_major = major;
        startup.protocol_number_minor = minor;
        startup.parameters = self.parameters.clone();
        client.send(PgWireFrontendMessage::Startup(startup)).await?;
        Ok(())
    }

    async fn on_authentication<C>(
        &mut self,
        client: &mut C,
        message: Authentication,
    ) -> Result<(), PgWireClientError>
    where
        C: UpstreamClientInfo
            + Stream<Item = PgWireResult<PgWireBackendMessage>>
            + Sink<PgWireFrontendMessage>
            + Unpin
            + Send,
        PgWireClientError: From<<C as Sink<PgWireFrontendMessage>>::Error>,
    {
        self.inner.on_authentication(client, message).await
    }

    async fn on_backend_key<C>(
        &mut self,
        client: &mut C,
        message: BackendKeyData,
    ) -> Result<(), PgWireClientError>
    where
        C: UpstreamClientInfo + Sink<PgWireFrontendMessage> + Unpin + Send,
        PgWireClientError: From<<C as Sink<PgWireFrontendMessage>>::Error>,
    {
        self.inner.on_backend_key(client, message).await
    }

    async fn on_ready_for_query<C>(
        &mut self,
        client: &mut C,
        message: ReadyForQuery,
    ) -> Result<ServerInformation, PgWireClientError>
    where
        C: UpstreamClientInfo + Sink<PgWireFrontendMessage> + Unpin + Send,
        PgWireClientError: From<<C as Sink<PgWireFrontendMessage>>::Error>,
    {
        self.inner.on_ready_for_query(client, message).await
    }
}

#[derive(Clone, Default)]
struct CancellationRegistry {
    targets: Arc<tokio::sync::Mutex<HashMap<(i32, SecretKey), CancelTarget>>>,
}

impl CancellationRegistry {
    async fn insert(&self, process_id: i32, secret: SecretKey, target: CancelTarget) {
        self.targets
            .lock()
            .await
            .insert((process_id, secret), target);
    }

    async fn remove(&self, process_id: i32, secret: &SecretKey) {
        self.targets
            .lock()
            .await
            .remove(&(process_id, secret.clone()));
    }

    async fn cancel(&self, request: CancelRequest) {
        let target = self
            .targets
            .lock()
            .await
            .get(&(request.pid, request.secret_key))
            .cloned();
        if let Some(target) = target {
            let _ = target.cancel().await;
        }
    }
}

#[derive(Clone)]
struct CancelTarget {
    tls: TlsConnector,
    host: String,
    port: u16,
    process_id: i32,
    secret: SecretKey,
}

impl CancelTarget {
    async fn cancel(&self) -> Result<(), ProxyError> {
        let mut socket = connect_tls_socket(&self.host, self.port, self.tls.clone()).await?;
        socket
            .send(PgWireFrontendMessage::CancelRequest(CancelRequest::new(
                self.process_id,
                self.secret.clone(),
            )))
            .await?;
        socket.close().await?;
        Ok(())
    }
}

struct PrefixedIo<S> {
    inner: S,
    prefix: BytesMut,
}

impl<S> PrefixedIo<S> {
    fn new(inner: S, prefix: BytesMut) -> Self {
        Self { inner, prefix }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for PrefixedIo<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !self.prefix.is_empty() {
            let length = self.prefix.len().min(buffer.remaining());
            buffer.put_slice(&self.prefix[..length]);
            self.prefix.advance(length);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(context, buffer)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedIo<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        Pin::new(&mut self.inner).poll_write(context, buffer)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        Pin::new(&mut self.inner).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        Pin::new(&mut self.inner).poll_shutdown(context)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("authentication failed: {0}")]
    Authentication(String),
    #[error("database resolution failed: {0}")]
    Database(String),
    #[error("PostgreSQL protocol failed: {0}")]
    Protocol(String),
    #[error("upstream connection failed: {0}")]
    Connect(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    PgWire(#[from] PgWireError),
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
