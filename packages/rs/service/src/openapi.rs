//! Reusable aide OpenAPI finalization, serving, and export.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use aide::{
    axum::ApiRouter,
    generate::GenContext,
    openapi::{
        Info, MediaType, OpenApi, Operation, RequestBody, Response as OpenApiResponse, SchemaObject,
    },
    operation::{set_body, OperationInput, OperationOutput},
    scalar::Scalar,
};
use axum::{
    extract::Extension,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response as AxumResponse},
    routing::get,
    Router,
};

use crate::Result;

/// Preferred live OpenAPI document path.
pub const OPENAPI_YAML_PATH: &str = "/api/openapi.yaml";
/// JSON OpenAPI document path used by generators and clients.
pub const OPENAPI_JSON_PATH: &str = "/api/openapi.json";
/// Interactive Scalar API root.
pub const API_ROOT_PATH: &str = "/api";
/// Interactive Scalar API documentation path.
pub const API_DOCS_PATH: &str = "/api/docs";

/// Final Axum router plus the exact OpenAPI document it serves.
pub struct ServiceApi<S> {
    /// Runtime Axum router.
    pub router: Router<S>,
    /// Shared OpenAPI document generated from the runtime routes.
    pub document: Arc<OpenApi>,
}

fn freeform_media_type() -> MediaType {
    MediaType {
        schema: Some(SchemaObject {
            json_schema: schemars::json_schema!(true),
            example: None,
            external_docs: None,
        }),
        ..MediaType::default()
    }
}

/// Documentation adapter for an untyped JSON request body.
pub struct FreeformJsonInput;

impl OperationInput for FreeformJsonInput {
    fn operation_input(ctx: &mut GenContext, operation: &mut Operation) {
        let mut body = RequestBody {
            description: Some("Protocol-specific JSON request body.".to_owned()),
            required: true,
            ..RequestBody::default()
        };
        body.content
            .insert("application/json".to_owned(), freeform_media_type());
        set_body(ctx, operation, body);
    }
}

/// Documentation adapter for JSON or raw server-sent event responses.
pub struct JsonOrEventStreamOutput;

impl OperationOutput for JsonOrEventStreamOutput {
    type Inner = serde_json::Value;

    fn operation_response(
        _ctx: &mut GenContext,
        _operation: &mut Operation,
    ) -> Option<OpenApiResponse> {
        let mut response = OpenApiResponse {
            description: "Protocol response returned as JSON or a raw event stream.".to_owned(),
            ..OpenApiResponse::default()
        };
        for media_type in ["application/json", "text/event-stream"] {
            response
                .content
                .insert(media_type.to_owned(), freeform_media_type());
        }
        Some(response)
    }

    fn inferred_responses(
        ctx: &mut GenContext,
        operation: &mut Operation,
    ) -> Vec<(Option<u16>, OpenApiResponse)> {
        Self::operation_response(ctx, operation)
            .map(|response| vec![(Some(200), response)])
            .unwrap_or_default()
    }
}

async fn json_spec(Extension(document): Extension<Arc<OpenApi>>) -> impl IntoResponse {
    axum::Json((*document).clone())
}

async fn yaml_spec(Extension(document): Extension<Arc<OpenApi>>) -> AxumResponse {
    match serde_yaml::to_string(document.as_ref()) {
        Ok(body) => (
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/yaml; charset=utf-8"),
            )],
            body,
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("OpenAPI YAML serialization failed: {error}"),
        )
            .into_response(),
    }
}

/// Finalize typed aide routes and attach JSON, YAML, and Scalar endpoints.
pub fn finish<S>(
    router: ApiRouter<S>,
    title: impl Into<String>,
    version: impl Into<String>,
) -> ServiceApi<S>
where
    S: Clone + Send + Sync + 'static,
{
    aide::generate::infer_responses(true);
    let mut document = OpenApi {
        info: Info {
            title: title.into(),
            version: version.into(),
            ..Info::default()
        },
        ..OpenApi::default()
    };
    let router = router.finish_api(&mut document);
    let document = Arc::new(document);
    let router = router
        .route(OPENAPI_JSON_PATH, get(json_spec))
        .route(OPENAPI_YAML_PATH, get(yaml_spec))
        .route(
            API_DOCS_PATH,
            Scalar::new(OPENAPI_YAML_PATH).axum_route().into(),
        )
        .route(
            API_ROOT_PATH,
            Scalar::new(OPENAPI_YAML_PATH).axum_route().into(),
        )
        .layer(Extension(Arc::clone(&document)));
    ServiceApi { router, document }
}

/// Write one OpenAPI document as JSON or YAML based on the output extension.
pub fn write(document: &OpenApi, output: impl AsRef<Path>) -> Result<()> {
    let output = output.as_ref();
    let contents = match output.extension().and_then(|value| value.to_str()) {
        Some("yaml" | "yml") => serde_yaml::to_string(document)?,
        _ => serde_json::to_string_pretty(document)?,
    };
    fs::write(output, contents)?;
    Ok(())
}

/// Export when argv contains `--generate-spec [path]`.
pub fn export_requested(
    document: &OpenApi,
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<bool> {
    let arguments = arguments.into_iter().collect::<Vec<_>>();
    let Some(index) = arguments
        .iter()
        .position(|argument| argument == "--generate-spec")
    else {
        return Ok(false);
    };
    let output = arguments
        .get(index + 1)
        .filter(|value| !value.to_string_lossy().starts_with('-'))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("openapi.json"));
    write(document, output)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use aide::axum::ApiRouter;
    use axum::Json;
    use axum_typed_routing::{api_route, TypedApiRouter};
    use schemars::JsonSchema;
    use serde::Serialize;

    use super::*;

    #[derive(JsonSchema, Serialize)]
    struct FixtureResponse {
        /// Requested fixture identifier.
        id: u64,
    }

    #[api_route(GET "/fixtures/{id}")]
    async fn fixture(id: u64) -> Json<FixtureResponse> {
        Json(FixtureResponse { id })
    }

    #[test]
    fn typed_routes_generate_one_equivalent_json_and_yaml_document() {
        let service = finish(
            ApiRouter::new().typed_api_route(fixture),
            "Fixture API",
            "1.2.3",
        );
        assert_eq!(service.document.info.title, "Fixture API");
        assert!(service
            .document
            .paths
            .as_ref()
            .is_some_and(|paths| paths.paths.contains_key("/fixtures/{id}")));

        let directory = tempfile::tempdir().unwrap();
        let json_path = directory.path().join("openapi.json");
        let yaml_path = directory.path().join("openapi.yaml");
        write(service.document.as_ref(), &json_path).unwrap();
        write(service.document.as_ref(), &yaml_path).unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(json_path).unwrap()).unwrap();
        let yaml: serde_json::Value =
            serde_yaml::from_slice(&fs::read(yaml_path).unwrap()).unwrap();
        assert_eq!(json, yaml);
        assert_eq!(json["info"]["version"], "1.2.3");
    }

    #[test]
    fn export_argument_defaults_to_json_and_accepts_yaml() {
        let service = finish(
            ApiRouter::new().typed_api_route(fixture),
            "Fixture API",
            "1.2.3",
        );
        let directory = tempfile::tempdir().unwrap();
        let yaml_path = directory.path().join("fixture.yaml");
        assert!(export_requested(
            service.document.as_ref(),
            [
                OsString::from("fixture"),
                OsString::from("--generate-spec"),
                yaml_path.as_os_str().to_owned(),
            ],
        )
        .unwrap());
        assert!(yaml_path.is_file());
        assert!(
            !export_requested(service.document.as_ref(), [OsString::from("fixture")],).unwrap()
        );
    }
}
