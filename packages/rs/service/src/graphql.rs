//! Reusable GraphQL query, mutation, GraphiQL, and subscription routing.

use async_graphql::{
    extensions::{Extension as GraphqlExtension, ExtensionContext, ExtensionFactory, NextExecute},
    http::{Credentials, GraphiQLSource, ALL_WEBSOCKET_PROTOCOLS},
    ObjectType, Request, Response as GraphqlResponse, Schema, SubscriptionType,
};
use async_graphql_axum::{GraphQL, GraphQLProtocol, GraphQLWebSocket};
use axum::{
    extract::{
        ws::{rejection::WebSocketUpgradeRejection, WebSocketUpgrade},
        Extension,
    },
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get as route_get,
    Router,
};
use std::sync::Arc;

/// GraphQL schema used by reusable service endpoints.
pub type ServiceSchema<Q, M, S> = Schema<Q, M, S>;

#[rustfmt::skip]
const SAMPLE_STORAGE_SOURCE: &str =
    // ============================================================================
    /*js*/r#"
      const configuredSampleStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        length: 0,
      };
"#
    // ============================================================================
;

/// Construct an introspectable schema with consumer-owned roots.
pub fn schema<Q, M, S>(query: Q, mutation: M, subscription: S) -> ServiceSchema<Q, M, S>
where
    Q: ObjectType + Send + Sync + 'static,
    M: ObjectType + Send + Sync + 'static,
    S: SubscriptionType + Send + Sync + 'static,
{
    Schema::build(query, mutation, subscription)
        .extension(ValidationOnlyFactory)
        .finish()
}

struct ValidationOnly;

struct ValidationOnlyFactory;

impl ExtensionFactory for ValidationOnlyFactory {
    fn create(&self) -> Arc<dyn GraphqlExtension> {
        Arc::new(ValidationOnlyExtension)
    }
}

struct ValidationOnlyExtension;

#[async_trait::async_trait]
impl GraphqlExtension for ValidationOnlyExtension {
    async fn execute(
        &self,
        ctx: &ExtensionContext<'_>,
        operation_name: Option<&str>,
        next: NextExecute<'_>,
    ) -> GraphqlResponse {
        if ctx.data_opt::<ValidationOnly>().is_some() {
            GraphqlResponse::default()
        } else {
            next.run(ctx, operation_name).await
        }
    }
}

async fn serve_get<Q, M, S>(
    protocol: Result<GraphQLProtocol, StatusCode>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    headers: HeaderMap,
    Extension(schema): Extension<ServiceSchema<Q, M, S>>,
    Extension(endpoint): Extension<GraphqlEndpoint>,
) -> Response
where
    Q: ObjectType + Send + Sync + 'static,
    M: ObjectType + Send + Sync + 'static,
    S: SubscriptionType + Send + Sync + 'static,
{
    match (upgrade, protocol) {
        (Ok(upgrade), Ok(protocol)) => upgrade
            .protocols(ALL_WEBSOCKET_PROTOCOLS)
            .on_upgrade(move |stream| GraphQLWebSocket::new(stream, schema, protocol).serve())
            .into_response(),
        (Ok(_), Err(status)) => status.into_response(),
        (Err(_), _) => graphiql(&headers, &endpoint),
    }
}

fn graphiql(headers: &HeaderMap, endpoint: &GraphqlEndpoint) -> Response {
    let accepts_html = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("text/html"));
    if !accepts_html {
        return (
            StatusCode::BAD_REQUEST,
            "GraphQL GET requires a WebSocket subscription or Accept: text/html",
        )
            .into_response();
    }
    let source = GraphiQLSource::build()
        .endpoint(endpoint.path)
        .subscription_endpoint(endpoint.path)
        .credentials(Credentials::Include)
        .title(&endpoint.ui.title)
        .finish()
        .replace("react.development.js", "react.production.min.js")
        .replace("react-dom.development.js", "react-dom.production.min.js");
    let source = endpoint
        .ui
        .default_document()
        .map_or(source.clone(), |document| {
            let document =
                serde_json::to_string(&document).expect("GraphQL samples serialize as JSON");
            source
                .replace(
                    "ReactDOM.createRoot(",
                    &format!("{SAMPLE_STORAGE_SOURCE}\n      ReactDOM.createRoot("),
                )
                .replace(
                    "defaultEditorToolsVisibility: true,",
                    &format!(
                        "defaultEditorToolsVisibility: true,\n          defaultQuery: {document},\n          storage: configuredSampleStorage,"
                    ),
                )
        });
    Html(source).into_response()
}

/// Named GraphQL example rendered in GraphiQL's operation picker.
#[derive(Clone, Debug)]
pub struct GraphqlSample {
    /// Human-readable example description.
    pub name: String,
    /// Complete named GraphQL operation document.
    pub document: String,
}

impl GraphqlSample {
    /// Construct one named sample operation.
    pub fn new(name: impl Into<String>, document: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            document: document.into(),
        }
    }
}

/// GraphiQL title and initial named operations.
#[derive(Clone, Debug)]
pub struct GraphqlUiConfig {
    /// Browser document title.
    pub title: String,
    /// Named operations shown in GraphiQL's operation picker.
    pub samples: Vec<GraphqlSample>,
}

impl Default for GraphqlUiConfig {
    fn default() -> Self {
        Self {
            title: "GraphiQL IDE".to_owned(),
            samples: Vec::new(),
        }
    }
}

impl GraphqlUiConfig {
    /// Construct an empty GraphiQL configuration.
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            ..Self::default()
        }
    }

    /// Append one named sample operation.
    pub fn sample(mut self, sample: GraphqlSample) -> Self {
        self.samples.push(sample);
        self
    }

    fn default_document(&self) -> Option<String> {
        (!self.samples.is_empty()).then(|| {
            self.samples
                .iter()
                .map(|sample| format!("# {}\n{}", sample.name, sample.document))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
    }
}

/// Validate every configured sample against a schema without running resolvers.
pub async fn validate_samples<Q, M, S>(
    schema: &ServiceSchema<Q, M, S>,
    ui: &GraphqlUiConfig,
) -> Result<(), String>
where
    Q: ObjectType + Send + Sync + 'static,
    M: ObjectType + Send + Sync + 'static,
    S: SubscriptionType + Send + Sync + 'static,
{
    for sample in &ui.samples {
        let response = schema
            .execute(Request::new(&sample.document).data(ValidationOnly))
            .await;
        if !response.errors.is_empty() {
            return Err(format!(
                "GraphQL sample {:?} failed validation:\n{:#?}",
                sample.name, response.errors
            ));
        }
    }
    Ok(())
}

#[derive(Clone)]
struct GraphqlEndpoint {
    path: &'static str,
    ui: GraphqlUiConfig,
}

/// Build GET, POST, GraphiQL, multipart, and WebSocket routes on one GraphQL path.
pub fn routes<Q, M, S, State>(path: &'static str, schema: ServiceSchema<Q, M, S>) -> Router<State>
where
    Q: ObjectType + Send + Sync + 'static,
    M: ObjectType + Send + Sync + 'static,
    S: SubscriptionType + Send + Sync + 'static,
    State: Clone + Send + Sync + 'static,
{
    routes_with_ui(path, schema, GraphqlUiConfig::default())
}

/// Build GraphQL routes with consumer-owned GraphiQL examples.
pub fn routes_with_ui<Q, M, S, State>(
    path: &'static str,
    schema: ServiceSchema<Q, M, S>,
    ui: GraphqlUiConfig,
) -> Router<State>
where
    Q: ObjectType + Send + Sync + 'static,
    M: ObjectType + Send + Sync + 'static,
    S: SubscriptionType + Send + Sync + 'static,
    State: Clone + Send + Sync + 'static,
{
    let graphql = GraphQL::new(schema.clone());
    Router::new()
        .route(path, route_get(serve_get::<Q, M, S>).post_service(graphql))
        .layer(Extension(GraphqlEndpoint { path, ui }))
        .layer(Extension(schema))
}

#[cfg(test)]
mod tests {
    use async_graphql::{EmptyMutation, Object, Subscription};
    use axum::body::to_bytes;
    use futures::{stream, Stream, StreamExt};

    use super::*;

    struct QueryRoot;

    #[Object]
    impl QueryRoot {
        /// Return one fixture value.
        async fn value(&self) -> u64 {
            42
        }
    }

    struct SubscriptionRoot;

    #[Subscription]
    impl SubscriptionRoot {
        /// Stream two fixture values.
        async fn values(&self) -> impl Stream<Item = u64> {
            stream::iter([1, 2])
        }
    }

    #[tokio::test]
    async fn schema_supports_queries_introspection_and_subscriptions() {
        let schema = schema(QueryRoot, EmptyMutation, SubscriptionRoot);
        let response = schema
            .execute("{ value __type(name: \"SubscriptionRoot\") { fields { name description } } }")
            .await;
        assert!(response.errors.is_empty());
        let payload = response.data.into_json().unwrap();
        assert_eq!(payload["value"], 42);
        assert_eq!(payload["__type"]["fields"][0]["name"], "values");
        assert_eq!(
            payload["__type"]["fields"][0]["description"],
            "Stream two fixture values."
        );

        let values = schema
            .execute_stream("subscription { values }")
            .map(|response| response.data.into_json().unwrap()["values"].clone())
            .collect::<Vec<_>>()
            .await;
        assert_eq!(values, [1, 2]);
    }

    #[tokio::test]
    async fn configured_samples_validate_without_waiting_for_subscription_values() {
        let schema = schema(QueryRoot, EmptyMutation, SubscriptionRoot);
        let valid = GraphqlUiConfig::default()
            .sample(GraphqlSample::new("Query", "query QuerySample { value }"))
            .sample(GraphqlSample::new(
                "Subscription",
                "subscription SubscriptionSample { values }",
            ));
        validate_samples(&schema, &valid).await.unwrap();

        let invalid = GraphqlUiConfig::default().sample(GraphqlSample::new(
            "Invalid",
            "query InvalidSample { missing }",
        ));
        assert!(validate_samples(&schema, &invalid)
            .await
            .unwrap_err()
            .contains("missing"));
    }

    #[tokio::test]
    async fn graphiql_requires_html_and_renders_configured_samples() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, "text/html".parse().unwrap());
        let endpoint = GraphqlEndpoint {
            path: "/api/fixture",
            ui: GraphqlUiConfig::new("Fixture GraphQL").sample(GraphqlSample::new(
                "Fixture query",
                "query FixtureQuery { value }",
            )),
        };
        let response = graphiql(&headers, &endpoint);
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(body.contains("<title>Fixture GraphQL</title>"));
        assert!(body.contains("query FixtureQuery"));
        assert!(body.contains("storage: configuredSampleStorage"));
        assert!(body.contains("subscriptionUrl: createUrl('/api/fixture', true)"));

        let response = graphiql(&HeaderMap::new(), &endpoint);
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
