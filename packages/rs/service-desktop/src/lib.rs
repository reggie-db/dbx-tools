//! Reusable Tauri tray and window behavior for dbx-tools services.

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, WindowEvent,
};

/// Event emitted when the tray's Quit item requests consumer shutdown.
pub const QUIT_REQUESTED_EVENT: &str = "service-desktop://quit-requested";

/// RGBA icon supplied by a consumer for the native system tray.
#[derive(Clone, Debug)]
pub struct DesktopIcon {
    /// Row-major RGBA pixel bytes.
    pub rgba: Vec<u8>,
    /// Icon width in pixels.
    pub width: u32,
    /// Icon height in pixels.
    pub height: u32,
}

impl DesktopIcon {
    /// Construct a tray icon from owned RGBA pixels.
    pub fn new(rgba: Vec<u8>, width: u32, height: u32) -> Self {
        Self {
            rgba,
            width,
            height,
        }
    }

    fn image(&self) -> Image<'static> {
        Image::new_owned(self.rgba.clone(), self.width, self.height)
    }
}

/// Consumer identity and startup policy for the reusable Tauri shell.
#[derive(Clone, Debug)]
pub struct DesktopOptions {
    /// Native window and tray title.
    pub title: String,
    /// Menu label that reveals the main window.
    pub open_label: String,
    /// Consumer-owned tray icon.
    pub icon: DesktopIcon,
    /// Whether macOS should render the icon as a system template image.
    pub icon_as_template: bool,
    /// Create the native shell only long enough to verify capability.
    pub probe: bool,
}

impl DesktopOptions {
    /// Construct desktop options with an `Open <title>` menu item.
    pub fn new(title: impl Into<String>, icon: DesktopIcon) -> Self {
        let title = title.into();
        Self {
            open_label: format!("Open {title}"),
            title,
            icon,
            icon_as_template: false,
            probe: false,
        }
    }

    /// Select native template rendering for the tray icon.
    pub fn with_template_icon(mut self, icon_as_template: bool) -> Self {
        self.icon_as_template = icon_as_template;
        self
    }

    /// Select capability-probe mode.
    pub fn with_probe(mut self, probe: bool) -> Self {
        self.probe = probe;
        self
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!("desktop main window is unavailable");
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Build the reusable Open/Quit tray plugin and close-to-tray behavior.
pub fn plugin<R: Runtime>(options: DesktopOptions) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("service-desktop")
        .setup(move |app, _api| {
            let open = MenuItem::with_id(app, "open", &options.open_label, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let open_id = open.id().clone();
            let quit_id = quit.id().clone();
            TrayIconBuilder::with_id("service-desktop")
                .tooltip(&options.title)
                .icon(options.icon.image())
                .icon_as_template(options.icon_as_template)
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    if event.id() == &open_id {
                        show_main_window(app);
                    } else if event.id() == &quit_id {
                        let _ = app.emit(QUIT_REQUESTED_EVENT, ());
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            if options.probe {
                app.exit(0);
            }
            Ok(())
        })
        .build()
}

/// Hide the main window when its close control is used.
pub fn handle_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
}

/// Attach the localhost-only connector when its debug feature is enabled.
pub fn configure_debug(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(feature = "debug-mcp")]
    {
        builder.plugin(
            tauri_plugin_connector::ConnectorBuilder::new()
                .bind_address("127.0.0.1")
                .build(),
        )
    }
    #[cfg(not(feature = "debug-mcp"))]
    {
        builder
    }
}
