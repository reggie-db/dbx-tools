use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use dbx_tools_databricks::DatabricksAuthOptions;
use dbx_tools_lakebase_proxy::{databricks::LakebaseClient, proxy::PostgresProxy};
use futures::{stream, Sink, SinkExt, TryStreamExt};
use pgwire::{
    api::{
        auth::{
            cleartext::CleartextPasswordAuthStartupHandler, AuthSource,
            DefaultServerParameterProvider, LoginInfo, Password, ServerParameterProvider,
            StartupHandler,
        },
        cancel::DefaultCancelHandler,
        portal::Portal,
        query::{ExtendedQueryHandler, SimpleQueryHandler},
        results::{
            CopyEncoder, CopyResponse, CopyTextOptions, DataRowEncoder, DescribePortalResponse,
            DescribeStatementResponse, FieldFormat, FieldInfo, QueryResponse, Response, Tag,
        },
        stmt::{NoopQueryParser, StoredStatement},
        ClientInfo, ConnectionHandle, ConnectionManager, PgWireServerHandlers, Type,
    },
    error::{PgWireError, PgWireResult},
    messages::{response::NotificationResponse, PgWireBackendMessage},
    tokio::server::process_socket,
};
use rcgen::{generate_simple_self_signed, CertifiedKey};
use rustls::{
    pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer},
    ClientConfig, RootCertStore, ServerConfig,
};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

#[tokio::test]
async fn standard_postgres_client_uses_tls_upstream_and_preserves_startup_parameters() {
    let (upstream_port, tls, metadata) = start_upstream().await;
    let api = MockServer::start().await;
    mount_lakebase_api(&api, upstream_port).await;
    let directory = tempfile::tempdir().unwrap();
    let config_file = directory.path().join("databrickscfg");
    std::fs::write(
        &config_file,
        format!(
            "[PROFILE]\nhost = {}\nauth_type = pat\ntoken = profile-token\n",
            api.uri()
        ),
    )
    .unwrap();
    let databricks = LakebaseClient::with_auth_options(DatabricksAuthOptions {
        config_file: Some(config_file.to_string_lossy().into_owned()),
        ..Default::default()
    });
    let proxy = PostgresProxy::with_tls_config(databricks, tls);
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let proxy_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        proxy
            .handle(socket, std::time::Duration::from_secs(5))
            .await
            .unwrap();
    });

    let mut config = tokio_postgres::Config::new();
    config
        .host("127.0.0.1")
        .port(proxy_port)
        .user("PROFILE")
        .dbname("project")
        .application_name("proxy-e2e")
        .ssl_mode(tokio_postgres::config::SslMode::Disable);
    let (client, mut connection) = config.connect(tokio_postgres::NoTls).await.unwrap();
    let (notifications, mut received_notifications) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            match std::future::poll_fn(|context| connection.poll_message(context)).await {
                Some(Ok(tokio_postgres::AsyncMessage::Notification(notification))) => {
                    let _ = notifications.send(notification);
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            }
        }
    });

    let simple = client.simple_query("SELECT 1").await.unwrap();
    assert!(!simple.is_empty());
    let statement = client.prepare("SELECT 1").await.unwrap();
    let row = client.query_one(&statement, &[]).await.unwrap();
    assert_eq!(row.get::<_, i32>(0), 1);
    let copy = client
        .copy_out("COPY example TO STDOUT")
        .await
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    assert_eq!(
        copy.into_iter()
            .flat_map(|chunk| chunk.to_vec())
            .collect::<Vec<_>>(),
        b"1\n"
    );
    client.batch_execute("LISTEN proxy_events").await.unwrap();
    client.batch_execute("NOTIFY proxy_events").await.unwrap();
    let notification = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        received_notifications.recv(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(notification.channel(), "proxy_events");
    assert_eq!(notification.payload(), "forwarded");
    let cancel = client.cancel_token();
    let (query, cancel_result) =
        tokio::join!(client.simple_query("SELECT pg_sleep(10)"), async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            cancel.cancel_query(tokio_postgres::NoTls).await
        });
    cancel_result.unwrap();
    assert_eq!(
        query
            .unwrap_err()
            .as_db_error()
            .map(|error| error.code().code()),
        Some("57014")
    );
    let metadata = metadata.lock().unwrap().clone();
    assert_eq!(
        metadata.get("user").map(String::as_str),
        Some("user@example.com")
    );
    assert_eq!(
        metadata.get("database").map(String::as_str),
        Some("databricks_postgres")
    );
    assert_eq!(
        metadata.get("application_name").map(String::as_str),
        Some("proxy-e2e")
    );
}

async fn start_upstream() -> (
    u16,
    Arc<ClientConfig>,
    Arc<Mutex<std::collections::HashMap<String, String>>>,
) {
    let CertifiedKey { cert, signing_key } =
        generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let certificate = cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(signing_key.serialize_der()));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let server = ServerConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate.clone()], key)
        .unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(certificate).unwrap();
    let client = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let metadata = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let manager = Arc::new(ConnectionManager::new());
    let handlers = Arc::new(TestHandlers {
        query: Arc::new(TestQuery {
            metadata: Arc::clone(&metadata),
            parser: Arc::new(NoopQueryParser::new()),
        }),
        cancel: Arc::new(DefaultCancelHandler::new(Arc::clone(&manager))),
        manager,
    });
    tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let handlers = Arc::clone(&handlers);
            let tls = TlsAcceptor::from(Arc::new(server.clone()));
            tokio::spawn(async move {
                let _ = process_socket(socket, Some(tls), handlers).await;
            });
        }
    });
    (port, Arc::new(client), metadata)
}

async fn mount_lakebase_api(api: &MockServer, upstream_port: u16) {
    let project = "/api/2.0/postgres/projects/project";
    Mock::given(method("GET"))
        .and(path(project))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "projects/project"
        })))
        .mount(api)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{project}/branches")))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "branches": [{"name": "projects/project/branches/production"}]
        })))
        .mount(api)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{project}/branches/production/endpoints")))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "endpoints": [{
                "name": "projects/project/branches/production/endpoints/primary",
                "status": {
                    "endpoint_type": "READ_WRITE",
                    "current_state": "READY",
                    "hosts": {"host": "localhost", "port": upstream_port}
                }
            }]
        })))
        .mount(api)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{project}/branches/production/databases")))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "databases": [{
                "name": "projects/project/branches/production/databases/databricks-postgres",
                "status": {"postgres_database": "databricks_postgres"}
            }]
        })))
        .mount(api)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/2.0/preview/scim/v2/Me"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "userName": "user@example.com"
        })))
        .mount(api)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/2.0/postgres/credentials"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "token": "database-token"
        })))
        .mount(api)
        .await;
}

struct TestHandlers {
    query: Arc<TestQuery>,
    cancel: Arc<DefaultCancelHandler>,
    manager: Arc<ConnectionManager>,
}

impl PgWireServerHandlers for TestHandlers {
    fn simple_query_handler(&self) -> Arc<impl SimpleQueryHandler> {
        Arc::clone(&self.query)
    }

    fn extended_query_handler(&self) -> Arc<impl ExtendedQueryHandler> {
        Arc::clone(&self.query)
    }

    fn startup_handler(&self) -> Arc<impl StartupHandler> {
        Arc::new(
            CleartextPasswordAuthStartupHandler::new(TestPassword, TestParameters)
                .with_connection_manager(Arc::clone(&self.manager)),
        )
    }

    fn cancel_handler(&self) -> Arc<impl pgwire::api::cancel::CancelHandler> {
        Arc::clone(&self.cancel)
    }
}

#[derive(Debug)]
struct TestPassword;

#[async_trait]
impl AuthSource for TestPassword {
    async fn get_password(&self, _: &LoginInfo) -> PgWireResult<Password> {
        Ok(Password::new(None, b"database-token".to_vec()))
    }
}

struct TestParameters;

impl ServerParameterProvider for TestParameters {
    fn server_parameters<C>(&self, client: &C) -> Option<std::collections::HashMap<String, String>>
    where
        C: ClientInfo,
    {
        DefaultServerParameterProvider::default().server_parameters(client)
    }
}

struct TestQuery {
    metadata: Arc<Mutex<std::collections::HashMap<String, String>>>,
    parser: Arc<NoopQueryParser>,
}

impl TestQuery {
    fn response(format: FieldFormat) -> PgWireResult<Response> {
        let schema = Arc::new(vec![FieldInfo::new(
            "?column?".into(),
            None,
            None,
            Type::INT4,
            format,
        )]);
        let mut encoder = DataRowEncoder::new(Arc::clone(&schema));
        encoder.encode_field(&1)?;
        Ok(Response::Query(QueryResponse::new(
            schema,
            stream::iter(vec![Ok(encoder.take_row())]),
        )))
    }

    fn copy_response() -> PgWireResult<Response> {
        let schema = Arc::new(vec![FieldInfo::new(
            "value".into(),
            None,
            None,
            Type::INT4,
            FieldFormat::Text,
        )]);
        let mut encoder = CopyEncoder::new_text(Arc::clone(&schema), CopyTextOptions::default());
        encoder.encode_field(&1)?;
        Ok(Response::CopyOut(CopyResponse::new(
            0,
            schema.len(),
            stream::iter(vec![Ok(encoder.take_copy())]),
        )))
    }
}

#[async_trait]
impl SimpleQueryHandler for TestQuery {
    async fn do_query<C>(&self, client: &mut C, query: &str) -> PgWireResult<Vec<Response>>
    where
        C: ClientInfo + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::Error: std::fmt::Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        *self.metadata.lock().unwrap() = client.metadata().clone();
        if query.contains("pg_sleep") {
            let handle = client
                .session_extensions()
                .get::<Arc<ConnectionHandle>>()
                .expect("connection has cancellation handle");
            let canceled = handle.start_query().await;
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => {
                    return Ok(vec![Response::Execution(Tag::new("SELECT 1"))]);
                }
                _ = canceled => return Err(PgWireError::QueryCanceled),
            }
        }
        if query.to_ascii_uppercase().starts_with("COPY ") {
            return Ok(vec![Self::copy_response()?]);
        }
        if query
            .trim()
            .to_ascii_uppercase()
            .starts_with("NOTIFY PROXY_EVENTS")
        {
            client
                .send(PgWireBackendMessage::NotificationResponse(
                    NotificationResponse::new(1, "proxy_events".into(), "forwarded".into()),
                ))
                .await?;
            return Ok(vec![Response::Execution(Tag::new("NOTIFY"))]);
        }
        if query
            .trim()
            .to_ascii_uppercase()
            .starts_with("LISTEN PROXY_EVENTS")
        {
            return Ok(vec![Response::Execution(Tag::new("LISTEN"))]);
        }
        Ok(vec![Self::response(FieldFormat::Text)?])
    }
}

#[async_trait]
impl ExtendedQueryHandler for TestQuery {
    type Statement = String;
    type QueryParser = NoopQueryParser;

    fn query_parser(&self) -> Arc<Self::QueryParser> {
        Arc::clone(&self.parser)
    }

    async fn do_query<C>(
        &self,
        client: &mut C,
        portal: &Portal<Self::Statement>,
        _: usize,
    ) -> PgWireResult<Response>
    where
        C: ClientInfo + Unpin + Send + Sync,
    {
        *self.metadata.lock().unwrap() = client.metadata().clone();
        if portal
            .statement
            .statement
            .to_ascii_uppercase()
            .starts_with("COPY ")
        {
            return Self::copy_response();
        }
        Self::response(portal.result_column_format.format_for(0))
    }

    async fn do_describe_statement<C>(
        &self,
        _: &mut C,
        _: &StoredStatement<Self::Statement>,
    ) -> PgWireResult<DescribeStatementResponse>
    where
        C: ClientInfo + Unpin + Send + Sync,
    {
        Ok(DescribeStatementResponse::new(
            vec![],
            vec![FieldInfo::new(
                "?column?".into(),
                None,
                None,
                Type::INT4,
                FieldFormat::Binary,
            )],
        ))
    }

    async fn do_describe_portal<C>(
        &self,
        _: &mut C,
        portal: &Portal<Self::Statement>,
    ) -> PgWireResult<DescribePortalResponse>
    where
        C: ClientInfo + Unpin + Send + Sync,
    {
        Ok(DescribePortalResponse::new(vec![FieldInfo::new(
            "?column?".into(),
            None,
            None,
            Type::INT4,
            portal.result_column_format.format_for(0),
        )]))
    }
}
