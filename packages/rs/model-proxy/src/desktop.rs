//! Tauri desktop runtime and Specta IPC for the model proxy.

use std::sync::Arc;

#[cfg(feature = "desktop-codegen")]
use std::path::Path;

use dbx_tools_service_desktop::{
    configure_debug, handle_window_event, plugin as desktop_plugin, DesktopIcon, DesktopOptions,
    QUIT_REQUESTED_EVENT,
};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Listener, State, Wry};
use tauri_specta::{collect_commands, collect_events, Builder, Event};
use tokio_util::sync::CancellationToken;

use crate::{
    metrics::MetricsSnapshot,
    operator::{
        AuthStatus, CooldownRelease, ModelControlInput, OperatorService, Profiles,
        WaitCancellation,
    },
    runtime::RuntimeSelection,
    ProxyServer, ServerOptions,
};

#[derive(Clone)]
struct DesktopState {
    operator: Option<OperatorService>,
    address: Option<String>,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    running: bool,
    address: Option<String>,
}

#[derive(Clone, Debug, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
struct MetricsUpdated {
    snapshot: MetricsSnapshot,
}

#[tauri::command]
#[specta::specta]
async fn get_desktop_status(state: State<'_, DesktopState>) -> Result<DesktopStatus, String> {
    Ok(DesktopStatus {
        running: state.operator.is_some(),
        address: state.address.clone(),
    })
}

#[tauri::command]
#[specta::specta]
async fn get_metrics(
    state: State<'_, DesktopState>,
    model: Option<String>,
) -> Result<MetricsSnapshot, String> {
    Ok(operator(&state)?
        .metrics(
            model
                .as_deref()
                .map(str::trim)
                .filter(|model| !model.is_empty()),
        )
        .await)
}

#[tauri::command]
#[specta::specta]
async fn get_auth_status(state: State<'_, DesktopState>) -> Result<AuthStatus, String> {
    Ok(operator(&state)?.auth_status())
}

#[tauri::command]
#[specta::specta]
async fn list_profiles(
    state: State<'_, DesktopState>,
    refresh: bool,
) -> Result<Profiles, String> {
    operator(&state)?.profiles(refresh)
}

#[tauri::command]
#[specta::specta]
async fn switch_runtime(
    state: State<'_, DesktopState>,
    selection: RuntimeSelection,
) -> Result<AuthStatus, String> {
    operator(&state)?.switch(selection).await
}

#[tauri::command]
#[specta::specta]
async fn cancel_model_waits(
    state: State<'_, DesktopState>,
    input: ModelControlInput,
) -> Result<WaitCancellation, String> {
    operator(&state)?.cancel_waits(input).await
}

#[tauri::command]
#[specta::specta]
async fn retry_model_now(
    state: State<'_, DesktopState>,
    input: ModelControlInput,
) -> Result<CooldownRelease, String> {
    operator(&state)?.retry_now(input).await
}

fn operator(state: &DesktopState) -> Result<&OperatorService, String> {
    state
        .operator
        .as_ref()
        .ok_or_else(|| "model proxy is not running".to_owned())
}

fn bindings() -> Builder<Wry> {
    let builder = Builder::<Wry>::new()
        .commands(collect_commands![
            get_desktop_status,
            get_metrics,
            get_auth_status,
            list_profiles,
            switch_runtime,
            cancel_model_waits,
            retry_model_now,
        ])
        .events(collect_events![MetricsUpdated]);
    #[cfg(feature = "desktop-codegen")]
    let builder = builder.dangerously_cast_bigints_to_number();
    builder
}

#[cfg(feature = "desktop-codegen")]
pub fn export_bindings(path: impl AsRef<Path>) -> Result<(), Box<dyn std::error::Error>> {
    bindings().export(specta_typescript::Typescript::default(), path)?;
    Ok(())
}

pub fn run(
    server_options: Option<ServerOptions>,
    probe: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let server = server_options
        .map(|options| tauri::async_runtime::block_on(ProxyServer::bind(options)))
        .transpose()?;
    let operator = server
        .as_ref()
        .map(|server| OperatorService::new(server.state()));
    let address = server.as_ref().map(|server| server.address().to_string());
    let state = DesktopState {
        operator: operator.clone(),
        address,
    };
    let cancellation = CancellationToken::new();
    let specta = Arc::new(bindings());
    let invoke_handler = specta.invoke_handler();
    let desktop = DesktopOptions::new("Model Proxy", proxy_icon())
        .with_template_icon(cfg!(target_os = "macos"))
        .with_probe(probe);
    let tauri = configure_debug(tauri::Builder::default())
        .manage(state)
        .on_window_event(handle_window_event)
        .plugin(desktop_plugin(desktop))
        .invoke_handler(invoke_handler);
    let setup_specta = Arc::clone(&specta);
    let setup_cancellation = cancellation.clone();
    tauri
        .setup(move |app| {
            setup_specta.mount_events(app);
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
                    let result = server
                        .serve(server_cancellation.cancelled_owned())
                        .await;
                    if let Err(error) = result {
                        tracing::error!(%error, "model proxy desktop server stopped");
                        app_handle.exit(1);
                    } else {
                        app_handle.exit(0);
                    }
                });
            }
            if let Some(operator) = operator {
                start_metrics_events(app.handle().clone(), operator);
            }
            Ok(())
        })
        .run(tauri::generate_context!())?;
    Ok(())
}

fn start_metrics_events(app: AppHandle, operator: OperatorService) {
    #[cfg(feature = "metrics")]
    if let Some(mut receiver) = operator.subscribe() {
        tauri::async_runtime::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(()) => {
                        let _ = MetricsUpdated {
                            snapshot: operator.metrics(None).await,
                        }
                        .emit(&app);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
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
    fn committed_bindings_match_the_command_registry() {
        let directory = tempfile::tempdir().unwrap();
        let generated = directory.path().join("bindings.ts");
        export_bindings(&generated).unwrap();
        let committed =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("desktop/src/bindings.ts");
        assert_eq!(
            std::fs::read(generated).unwrap(),
            std::fs::read(committed).unwrap()
        );
    }
}
