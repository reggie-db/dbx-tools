//! PostgreSQL startup, authentication, and upstream TLS negotiation.

use std::{
    collections::BTreeMap,
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use bytes::BytesMut;
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
        response::{ErrorResponse, GssEncResponse, ReadyForQuery, SslResponse, TransactionStatus},
        startup::{
            Authentication, BackendKeyData, NegotiateProtocolVersion, ParameterStatus, SecretKey,
            SslRequest, Startup,
        },
        DecodeContext, PgWireBackendMessage, PgWireFrontendMessage, ProtocolVersion,
        SslNegotiationMetaMessage,
    },
    tokio::{client::PgWireMessageClientCodec, server::PgWireMessageServerCodec},
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
};
use tokio_rustls::{client::TlsStream, TlsConnector};
use tokio_util::codec::{Decoder, Encoder, Framed};

use crate::databricks::ResolvedLakebase;

use super::{cancellation::PostgresCancellationMap, tunnel::PrefixedIo, ProxyError};

pub(super) type LocalFramed = Framed<TcpStream, PgWireMessageServerCodec<()>>;
type TlsIo = TlsStream<PrefixedIo<TcpStream>>;
pub(super) type UpstreamFramed = Framed<TlsIo, PostgresClientCodec>;

pub(super) async fn read_postgres_startup(
    socket: &mut LocalFramed,
    cancellations: &PostgresCancellationMap,
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
            PgWireFrontendMessage::CancelRequest(cancel_request) => {
                cancellations
                    .forward_postgres_cancellation(cancel_request)
                    .await;
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

pub(super) async fn connect_lakebase_postgres(
    startup: &Startup,
    resolved: &ResolvedLakebase,
    password: &str,
    tls: TlsConnector,
) -> Result<
    (
        UpstreamFramed,
        ServerInformation,
        ProtocolVersion,
        TransactionStatus,
        Option<(i32, Vec<String>)>,
    ),
    ProxyError,
> {
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
    let framed = connect_postgres_tls(&resolved.host, resolved.port, tls, protocol).await?;
    let mut client = PostgresStartupClient::new(framed, Arc::clone(&config), protocol);
    let mut parameters = startup.parameters.clone();
    parameters.insert("user".into(), resolved.user.clone());
    parameters.insert("database".into(), resolved.database.clone());
    let mut handler = ProxyStartupHandler {
        inner: DefaultStartupHandler::new(),
        parameters,
        negotiation: None,
    };
    handler.startup(&mut client).await?;
    while let Some(message) = client.next().await {
        let message = message?;
        if let PgWireBackendMessage::NegotiateProtocolVersion(value) = &message {
            handler.negotiation = Some((
                value.newest_minor_protocol,
                value.unsupported_options.clone(),
            ));
        }
        if let ReadyState::Ready(info) = handler.on_message(&mut client, message).await? {
            let protocol = client.protocol_version();
            let transaction = client.transaction_status();
            return Ok((
                client.into_inner(),
                info,
                protocol,
                transaction,
                handler.negotiation,
            ));
        }
    }
    Err(ProxyError::Connect(
        "upstream closed before startup completed".into(),
    ))
}

pub(super) async fn connect_postgres_tls(
    host: &str,
    port: u16,
    tls: TlsConnector,
    protocol: ProtocolVersion,
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
    Ok(Framed::new(stream, PostgresClientCodec::new(protocol)))
}

pub(super) async fn send_postgres_startup_complete(
    socket: &mut LocalFramed,
    completion: StartupCompletion<'_>,
) -> Result<(), io::Error> {
    if let Some((newest, unsupported)) = completion.negotiation {
        socket
            .feed(PgWireBackendMessage::NegotiateProtocolVersion(
                NegotiateProtocolVersion::new(newest, unsupported),
            ))
            .await?;
    } else if ProtocolVersion::from_version_number(completion.requested.0, completion.requested.1)
        != Some(completion.protocol)
    {
        socket
            .feed(PgWireBackendMessage::NegotiateProtocolVersion(
                NegotiateProtocolVersion::new(completion.protocol.into(), vec![]),
            ))
            .await?;
    }
    socket
        .feed(PgWireBackendMessage::Authentication(Authentication::Ok))
        .await?;
    for (name, value) in &completion.info.parameters {
        socket
            .feed(PgWireBackendMessage::ParameterStatus(ParameterStatus::new(
                name.clone(),
                value.clone(),
            )))
            .await?;
    }
    socket
        .feed(PgWireBackendMessage::BackendKeyData(BackendKeyData::new(
            completion.process_id,
            completion.secret,
        )))
        .await?;
    socket
        .feed(PgWireBackendMessage::ReadyForQuery(ReadyForQuery::new(
            completion.transaction,
        )))
        .await?;
    socket.flush().await
}

pub(super) async fn send_postgres_error(
    socket: &mut LocalFramed,
    error: &ProxyError,
) -> Result<(), io::Error> {
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

pub(super) struct StartupCompletion<'a> {
    pub(super) info: &'a ServerInformation,
    pub(super) process_id: i32,
    pub(super) secret: SecretKey,
    pub(super) requested: (u16, u16),
    pub(super) protocol: ProtocolVersion,
    pub(super) transaction: TransactionStatus,
    pub(super) negotiation: Option<(i32, Vec<String>)>,
}

pub(super) fn new_local_postgres_framed(
    socket: TcpStream,
    peer: std::net::SocketAddr,
) -> LocalFramed {
    Framed::new(
        socket,
        PgWireMessageServerCodec::new(DefaultClient::new(peer, false)),
    )
}

pub(super) struct PostgresClientCodec {
    context: DecodeContext,
}

impl PostgresClientCodec {
    fn new(protocol: ProtocolVersion) -> Self {
        Self {
            context: DecodeContext::new(protocol),
        }
    }
}

impl Decoder for PostgresClientCodec {
    type Item = PgWireBackendMessage;
    type Error = PgWireError;

    fn decode(&mut self, source: &mut BytesMut) -> Result<Option<Self::Item>, Self::Error> {
        PgWireBackendMessage::decode(source, &self.context)
    }
}

impl Encoder<PgWireFrontendMessage> for PostgresClientCodec {
    type Error = PgWireError;

    fn encode(
        &mut self,
        message: PgWireFrontendMessage,
        destination: &mut BytesMut,
    ) -> Result<(), Self::Error> {
        message.encode(destination)
    }
}

struct PostgresStartupClient<S> {
    socket: Framed<S, PostgresClientCodec>,
    config: Arc<Config>,
    parameters: BTreeMap<String, String>,
    process_id: i32,
    secret: SecretKey,
    protocol: ProtocolVersion,
    transaction: TransactionStatus,
}

impl<S> PostgresStartupClient<S> {
    fn new(
        mut socket: Framed<S, PostgresClientCodec>,
        config: Arc<Config>,
        protocol: ProtocolVersion,
    ) -> Self {
        socket.codec_mut().context.protocol_version = protocol;
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

    fn into_inner(self) -> Framed<S, PostgresClientCodec> {
        self.socket
    }
}

impl<S: AsyncRead + Unpin> Stream for PostgresStartupClient<S> {
    type Item = PgWireResult<PgWireBackendMessage>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.get_mut().socket).poll_next(context)
    }
}

impl<S: AsyncWrite + Unpin> Sink<PgWireFrontendMessage> for PostgresStartupClient<S> {
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

impl<S> UpstreamClientInfo for PostgresStartupClient<S> {
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
        self.socket.codec_mut().context.protocol_version = protocol;
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
    negotiation: Option<(i32, Vec<String>)>,
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
