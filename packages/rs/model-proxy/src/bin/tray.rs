//! Native tray controls for a running model-proxy service.

#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use clap::{CommandFactory, FromArgMatches, Parser};
use dbx_tools_core::{build_info, init_logging_with_verbose};
use dbx_tools_service::{
    tray::{
        replace_menu, run_tray, CheckMenuItem, Icon, Menu, MenuEvent, MenuId, MenuItem,
        PredefinedMenuItem, Submenu, TrayCli, TrayConfig, TrayControl, TrayHandle, TrayIcon,
    },
    ServiceConfig,
};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};

const CONTROL_HEADER: &str = "x-model-proxy-control";

#[derive(Clone, Debug, Parser)]
#[command(name = "dbx-model-proxy-tray")]
struct Cli {
    /// Model proxy base URL.
    #[arg(long, default_value = "http://127.0.0.1:4000")]
    url: String,
    #[command(flatten)]
    tray: TrayCli,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    profile: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    runtime: RuntimeStatus,
}

#[derive(Clone, Debug, Deserialize)]
struct ProfileSummary {
    name: String,
}

#[derive(Clone, Debug, Deserialize)]
struct Profiles {
    profiles: Vec<ProfileSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "profile")]
enum RuntimeSelection {
    Profile(String),
}

#[derive(Clone)]
struct ApiClient {
    base_url: String,
    client: Client,
}

impl ApiClient {
    fn new(base_url: String) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            client: Client::builder().timeout(Duration::from_secs(20)).build()?,
        })
    }

    fn status(&self) -> Result<AuthStatus, Box<dyn std::error::Error>> {
        Ok(self
            .client
            .get(format!("{}/api/auth", self.base_url))
            .send()?
            .error_for_status()?
            .json()?)
    }

    fn wait_for_status(&self) -> AuthStatus {
        loop {
            if let Ok(status) = self.status() {
                return status;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    fn profiles(&self) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        let profiles = self
            .client
            .get(format!("{}/api/auth/profiles", self.base_url))
            .send()?
            .error_for_status()?
            .json::<Profiles>()?
            .profiles;
        Ok(profiles.into_iter().map(|profile| profile.name).collect())
    }

    fn switch(&self, profile: String) -> Result<AuthStatus, Box<dyn std::error::Error>> {
        Ok(self
            .client
            .put(format!("{}/api/auth", self.base_url))
            .header(reqwest::header::ORIGIN, &self.base_url)
            .header(CONTROL_HEADER, "1")
            .json(&RuntimeSelection::Profile(profile))
            .send()?
            .error_for_status()?
            .json()?)
    }
}

#[derive(Clone)]
enum Action {
    Open(String),
    Profile(String),
    Quit,
}

fn proxy_targets(url: &str) -> [(&'static str, String); 3] {
    let url = url.trim_end_matches('/');
    [
        ("Open Models", format!("{url}/v1/models")),
        ("Open API", format!("{url}/api")),
        ("Open GraphQL", format!("{url}/graphql")),
    ]
}

fn menu(
    url: &str,
    current: &str,
    profiles: Option<&[String]>,
) -> Result<(Menu, HashMap<MenuId, Action>), Box<dyn std::error::Error>> {
    let menu = Menu::new();
    let address = Submenu::new(format!("Proxy: {url}"), true);
    let profile_menu = Submenu::new(current, true);
    let mut actions = HashMap::new();
    for (label, target) in proxy_targets(url) {
        let item = MenuItem::new(label, true, None);
        actions.insert(item.id().clone(), Action::Open(target));
        address.append(&item)?;
    }
    if let Some(profiles) = profiles {
        for profile in profiles {
            let item = CheckMenuItem::new(profile, true, profile == current, None);
            actions.insert(item.id().clone(), Action::Profile(profile.clone()));
            profile_menu.append(&item)?;
        }
    } else {
        profile_menu.append(&MenuItem::new("Loading profiles...", false, None))?;
    }
    let quit = MenuItem::new("Quit", true, None);
    actions.insert(quit.id().clone(), Action::Quit);
    menu.append_items(&[
        &address,
        &profile_menu,
        &PredefinedMenuItem::separator(),
        &quit,
    ])?;
    Ok((menu, actions))
}

fn refresh_profiles(
    handle: TrayHandle,
    api: ApiClient,
    current: Arc<Mutex<String>>,
    actions: Arc<Mutex<HashMap<MenuId, Action>>>,
) {
    std::thread::spawn(move || match api.profiles() {
        Ok(profiles) => {
            let profile = current
                .lock()
                .map(|profile| profile.clone())
                .unwrap_or_else(|_| "Profile unavailable".to_owned());
            let url = api.base_url.clone();
            handle.dispatch(move |tray| match menu(&url, &profile, Some(&profiles)) {
                Ok((menu, next_actions)) => {
                    if let Ok(mut registered) = actions.lock() {
                        *registered = next_actions;
                    }
                    if let Err(error) = replace_menu(tray, menu) {
                        tracing::error!(%error, "tray profile menu update failed");
                    }
                }
                Err(error) => tracing::error!(%error, "tray profile menu could not be built"),
            });
        }
        Err(error) => tracing::warn!(%error, "Databricks profiles could not be loaded"),
    });
}

fn proxy_icon() -> Result<Icon, Box<dyn std::error::Error>> {
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
    Ok(Icon::from_rgba(rgba, 32, 32)?)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::from_arg_matches(&Cli::command().version(build_info::version()).get_matches())?;
    init_logging_with_verbose(false)?;
    let api = ApiClient::new(cli.url.clone())?;
    let current_profile = if cli.tray.probe {
        "Model Proxy".to_owned()
    } else {
        api.wait_for_status().runtime.profile
    };
    let current = Arc::new(Mutex::new(current_profile.clone()));
    let actions = Arc::new(Mutex::new(HashMap::<MenuId, Action>::new()));
    let handle = Arc::new(Mutex::new(None::<TrayHandle>));
    let (initial_menu, initial_actions) = menu(&cli.url, &current_profile, None)?;
    *actions.lock().map_err(|_| "tray action lock is poisoned")? = initial_actions;

    let ready_api = api.clone();
    let ready_current = Arc::clone(&current);
    let ready_actions = Arc::clone(&actions);
    let ready_handle = Arc::clone(&handle);
    let on_ready = Arc::new(move |tray_handle: TrayHandle| {
        if let Ok(mut stored) = ready_handle.lock() {
            *stored = Some(tray_handle.clone());
        }
        refresh_profiles(
            tray_handle,
            ready_api.clone(),
            Arc::clone(&ready_current),
            Arc::clone(&ready_actions),
        );
    });

    let menu_api = api.clone();
    let menu_current = Arc::clone(&current);
    let menu_actions = Arc::clone(&actions);
    let menu_handle = Arc::clone(&handle);
    let on_menu = Arc::new(move |event: &MenuEvent, _tray: &TrayIcon| {
        let action = menu_actions
            .lock()
            .map_err(|_| "tray action lock is poisoned")?
            .get(&event.id)
            .cloned();
        match action {
            Some(Action::Quit) => Ok(TrayControl::Quit),
            Some(Action::Open(target)) => {
                std::thread::spawn(move || {
                    if let Err(error) = open::that(&target) {
                        tracing::error!(%error, url = target, "tray link could not be opened");
                    }
                });
                Ok(TrayControl::Continue)
            }
            Some(Action::Profile(profile)) => {
                let Some(tray_handle) = menu_handle
                    .lock()
                    .map_err(|_| "tray handle lock is poisoned")?
                    .clone()
                else {
                    return Ok(TrayControl::Continue);
                };
                let api = menu_api.clone();
                let current = Arc::clone(&menu_current);
                let actions = Arc::clone(&menu_actions);
                std::thread::spawn(move || match api.switch(profile) {
                    Ok(status) => {
                        if let Ok(mut selected) = current.lock() {
                            *selected = status.runtime.profile;
                        }
                        refresh_profiles(tray_handle, api, current, actions);
                    }
                    Err(error) => tracing::error!(%error, "Databricks profile switch failed"),
                });
                Ok(TrayControl::Continue)
            }
            None => Ok(TrayControl::Continue),
        }
    });

    let service = ServiceConfig::new("model-proxy", 4000)?
        .with_invalid_runtime_detector(dbx_tools_core::is_databricks_app);
    run_tray(
        cli.tray,
        TrayConfig {
            service,
            title: "Model Proxy".to_owned(),
            icon: proxy_icon()?,
            menu: initial_menu,
            icon_as_template: cfg!(target_os = "macos"),
            on_ready,
            on_menu,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_targets_use_the_configured_base_url() {
        assert_eq!(
            proxy_targets("http://127.0.0.1:4001/"),
            [
                ("Open Models", "http://127.0.0.1:4001/v1/models".to_owned()),
                ("Open API", "http://127.0.0.1:4001/api".to_owned()),
                ("Open GraphQL", "http://127.0.0.1:4001/graphql".to_owned()),
            ]
        );
    }
}
