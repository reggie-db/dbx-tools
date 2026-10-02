//! Tauri desktop runtime and shared rspc transport for the model proxy.

use std::sync::Arc;

#[cfg(feature = "desktop-codegen")]
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
};

use axum::{
    body::Bytes,
    extract::{Path as AxumPath, Query},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router as AxumRouter,
};
use dbx_tools_service_desktop::{
    configure_debug, handle_window_event, plugin as desktop_plugin, DesktopIcon, DesktopOptions,
    QUIT_REQUESTED_EVENT,
};
use rspc::{Error, ErrorCode, Router};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
#[cfg(feature = "desktop-codegen")]
use specta::{datatype::FunctionResultVariant, DataType, TypeMap};
#[cfg(feature = "desktop-codegen")]
use specta_typescript::{datatype, export_named_datatype, BigIntExportBehavior, Typescript};
use tauri::Listener;
use tokio_util::sync::CancellationToken;

use crate::{
    metrics::MetricsSnapshot,
    operator::{ModelControlInput, OperatorService},
    routes::AppState,
    runtime::RuntimeSelection,
    ProxyServer, ServerOptions,
};

type DesktopRouter = Arc<rspc::Router<DesktopContext>>;

#[derive(Clone)]
struct DesktopContext {
    operator: Option<OperatorService>,
    address: Option<String>,
}

impl DesktopContext {
    fn operator(&self) -> Result<OperatorService, Error> {
        self.operator
            .clone()
            .ok_or_else(|| rpc_error("model proxy is not running"))
    }
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    running: bool,
    address: Option<String>,
}

#[derive(RustEmbed)]
#[folder = "desktop/dist/"]
struct DesktopAssets;

#[derive(Clone)]
pub(crate) struct DesktopHttp {
    router: DesktopRouter,
    context: DesktopContext,
}

impl DesktopHttp {
    fn new(router: DesktopRouter, context: DesktopContext) -> Self {
        Self { router, context }
    }

    pub(crate) fn routes(self) -> AxumRouter<AppState> {
        let query_router = Arc::clone(&self.router);
        let query_context = self.context.clone();
        let mutation_router = self.router;
        let mutation_context = self.context;
        AxumRouter::new()
            .route(
                "/rspc/{*path}",
                get(
                    move |AxumPath(path): AxumPath<String>, Query(query): Query<RpcQuery>| {
                        let router = Arc::clone(&query_router);
                        let context = query_context.clone();
                        async move {
                            let input = query
                                .input
                                .map(|input| serde_json::from_str(&input))
                                .transpose();
                            rpc_response(router, context, rspc::ExecKind::Query, path, input).await
                        }
                    },
                )
                .post(move |AxumPath(path): AxumPath<String>, body: Bytes| {
                    let router = Arc::clone(&mutation_router);
                    let context = mutation_context.clone();
                    async move {
                        let input = (!body.is_empty())
                            .then(|| serde_json::from_slice(&body))
                            .transpose();
                        rpc_response(router, context, rspc::ExecKind::Mutation, path, input).await
                    }
                }),
            )
            .route("/", get(http_index))
            .fallback(get(http_asset))
    }
}

#[derive(Deserialize)]
struct RpcQuery {
    input: Option<String>,
}

async fn rpc_response(
    router: DesktopRouter,
    context: DesktopContext,
    kind: rspc::ExecKind,
    path: String,
    input: Result<Option<Value>, serde_json::Error>,
) -> axum::Json<Value> {
    let result = match input {
        Ok(input) => router.exec(context, kind, path, input).await,
        Err(error) => {
            return axum::Json(json!({
                "result": {
                    "type": "error",
                    "data": { "code": 400, "message": error.to_string() }
                }
            }));
        }
    };
    match result {
        Ok(data) => axum::Json(json!({
            "result": { "type": "response", "data": data }
        })),
        Err(error) => axum::Json(json!({
            "result": {
                "type": "error",
                "data": { "code": 500, "message": error.to_string() }
            }
        })),
    }
}

fn router() -> DesktopRouter {
    Router::<DesktopContext>::new()
        .query("desktop.status", |t| {
            t(|context, _: ()| async move {
                Ok::<_, Error>(DesktopStatus {
                    running: context.operator.is_some(),
                    address: context.address,
                })
            })
        })
        .query("metrics.current", |t| {
            t(|context, model: Option<String>| async move {
                Ok::<MetricsSnapshot, Error>(
                    context
                        .operator()?
                        .metrics(
                            model
                                .as_deref()
                                .map(str::trim)
                                .filter(|model| !model.is_empty()),
                        )
                        .await,
                )
            })
        })
        .query("auth.status", |t| {
            t(|context, _: ()| async move { Ok::<_, Error>(context.operator()?.auth_status()) })
        })
        .query("auth.profiles", |t| {
            t(|context, refresh: bool| async move {
                context.operator()?.profiles(refresh).map_err(rpc_error)
            })
        })
        .mutation("auth.switch", |t| {
            t(|context, selection: RuntimeSelection| async move {
                context
                    .operator()?
                    .switch(selection)
                    .await
                    .map_err(rpc_error)
            })
        })
        .mutation("rateLimits.cancelWaits", |t| {
            t(|context, input: ModelControlInput| async move {
                context
                    .operator()?
                    .cancel_waits(input)
                    .await
                    .map_err(rpc_error)
            })
        })
        .mutation("rateLimits.retryNow", |t| {
            t(|context, input: ModelControlInput| async move {
                context
                    .operator()?
                    .retry_now(input)
                    .await
                    .map_err(rpc_error)
            })
        })
        .build()
        .arced()
}

fn rpc_error(error: impl ToString) -> Error {
    Error::new(ErrorCode::InternalServerError, error.to_string())
}

#[cfg(feature = "desktop-codegen")]
fn bindings_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("desktop/src/bindings.ts")
}

#[cfg(feature = "desktop-codegen")]
/// Export TypeScript bindings from the same router used by Tauri and Axum.
pub fn export_bindings(path: impl AsRef<Path>) -> Result<(), Box<dyn std::error::Error>> {
    export_router_bindings(&router(), path.as_ref())?;
    Ok(())
}

#[cfg(feature = "desktop-codegen")]
fn export_router_bindings(
    router: &rspc::Router<DesktopContext>,
    path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)?;
    }
    let mut file = File::create(path)?;
    writeln!(
        file,
        "// This file was generated by [rspc](https://github.com/specta-rs/rspc). Do not edit this file manually."
    )?;

    let config = Typescript::new().bigint(BigIntExportBehavior::Number);
    let type_map = router.type_map();
    let queries = generate_procedures_ts(
        &config,
        router
            .queries()
            .iter()
            .map(|(key, procedure)| (key.as_str(), &procedure.ty.arg_ty, &procedure.ty.result_ty)),
        &type_map,
    )?;
    let mutations = generate_procedures_ts(
        &config,
        router
            .mutations()
            .iter()
            .map(|(key, procedure)| (key.as_str(), &procedure.ty.arg_ty, &procedure.ty.result_ty)),
        &type_map,
    )?;
    let subscriptions = generate_procedures_ts(
        &config,
        router
            .subscriptions()
            .iter()
            .map(|(key, procedure)| (key.as_str(), &procedure.ty.arg_ty, &procedure.ty.result_ty)),
        &type_map,
    )?;
    writeln!(
        file,
        r#"
export type Procedures = {{
    queries:{queries},
    mutations:{mutations},
    subscriptions:{subscriptions}
}};"#
    )?;
    for (_, ty) in type_map.iter() {
        writeln!(file, "\n{}", export_named_datatype(&config, ty, &type_map)?)?;
    }
    Ok(())
}

#[cfg(feature = "desktop-codegen")]
fn generate_procedures_ts<'a>(
    config: &Typescript,
    procedures: impl Iterator<Item = (&'a str, &'a DataType, &'a DataType)>,
    type_map: &TypeMap,
) -> Result<String, specta_typescript::ExportError> {
    let procedures = procedures
        .map(|(key, input, result)| {
            let input = match input {
                DataType::Tuple(definition) if definition.elements().is_empty() => {
                    "never".to_string()
                }
                input => datatype(
                    config,
                    &FunctionResultVariant::Value(input.clone()),
                    type_map,
                )?,
            };
            let result = datatype(
                config,
                &FunctionResultVariant::Value(result.clone()),
                type_map,
            )?;
            Ok(format!(
                r#"{{ key: "{key}", input: {input}, result: {result} }}"#
            ))
        })
        .collect::<Result<Vec<_>, specta_typescript::ExportError>>()?;
    Ok(if procedures.is_empty() {
        " never".to_string()
    } else {
        format!("\n        {}", procedures.join(" |\n        "))
    })
}

async fn http_index() -> Response {
    embedded_asset("index.html")
}

async fn http_asset(uri: axum::http::Uri) -> Response {
    embedded_asset(uri.path())
}

fn embedded_asset(path: &str) -> Response {
    let normalized = path.trim_start_matches('/');
    let Some(asset) = DesktopAssets::get(normalized) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = mime_guess::from_path(normalized)
        .first_raw()
        .unwrap_or("application/octet-stream");
    let cache_control = if normalized == "index.html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static(cache_control),
            ),
        ],
        asset.data.into_owned(),
    )
        .into_response()
}

/// Run the Tauri shell with an optional in-process proxy server.
pub async fn run(
    server_options: Option<ServerOptions>,
    probe: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let server = match server_options {
        Some(options) => Some(ProxyServer::bind(options).await?),
        None => None,
    };
    let operator = server
        .as_ref()
        .map(|server| OperatorService::new(server.state()));
    let context = DesktopContext {
        operator,
        address: server.as_ref().map(|server| server.address().to_string()),
    };
    let router = router();
    #[cfg(all(debug_assertions, feature = "desktop-codegen"))]
    export_router_bindings(&router, &bindings_path())?;
    let server = server
        .map(|server| server.with_desktop(DesktopHttp::new(Arc::clone(&router), context.clone())));
    let cancellation = CancellationToken::new();
    let desktop = DesktopOptions::new("Model Proxy", proxy_icon())
        .with_template_icon(cfg!(target_os = "macos"))
        .with_probe(probe);
    let rspc_context = context.clone();
    let tauri = configure_debug(tauri::Builder::default())
        .on_window_event(handle_window_event)
        .plugin(desktop_plugin(desktop))
        .plugin(rspc_tauri::plugin(router, move |_| rspc_context.clone()));
    let setup_cancellation = cancellation.clone();
    tauri
        .setup(move |app| {
            let quit_cancellation = setup_cancellation.clone();
            app.listen(QUIT_REQUESTED_EVENT, move |_| quit_cancellation.cancel());
            if let Some(server) = server {
                let app_handle = app.handle().clone();
                let server_cancellation = setup_cancellation.clone();
                let signal_cancellation = setup_cancellation.clone();
                tauri::async_runtime::spawn(async move {
                    dbx_tools_core::shutdown_signal().await;
                    signal_cancellation.cancel();
                });
                tauri::async_runtime::spawn(async move {
                    let result = server.serve(server_cancellation.cancelled_owned()).await;
                    if let Err(error) = result {
                        tracing::error!(%error, "model proxy desktop server stopped");
                        app_handle.exit(1);
                    } else {
                        app_handle.exit(0);
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())?;
    Ok(())
}

fn proxy_icon() -> DesktopIcon {
    let mut rgba = Vec::with_capacity(32 * 32 * 4);
    let color = if cfg!(target_os = "macos") {
        [0x00, 0x00, 0x00, 0xff]
    } else {
        [0xff, 0x36, 0x21, 0xff]
    };
    let rectangles = [
        (4, 13, 6, 6),
        (24, 4, 6, 6),
        (24, 13, 6, 6),
        (24, 22, 6, 6),
        (10, 15, 6, 2),
        (16, 6, 2, 20),
        (18, 6, 6, 2),
        (18, 15, 6, 2),
        (18, 24, 6, 2),
    ];
    for y in 0..32 {
        for x in 0..32 {
            let inside = rectangles.iter().any(|(left, top, width, height)| {
                (*left..*left + *width).contains(&x) && (*top..*top + *height).contains(&y)
            });
            rgba.extend_from_slice(if inside { &color } else { &[0, 0, 0, 0] });
        }
    }
    DesktopIcon::new(rgba, 32, 32)
}

#[cfg(all(test, feature = "desktop-codegen"))]
mod tests {
    use super::*;

    #[test]
    fn committed_bindings_match_the_rspc_router() {
        let directory = tempfile::tempdir().unwrap();
        let generated = directory.path().join("bindings.ts");
        export_bindings(&generated).unwrap();
        assert_eq!(
            std::fs::read(generated).unwrap(),
            std::fs::read(bindings_path()).unwrap()
        );
    }
}
