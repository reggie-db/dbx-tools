fn main() {
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_none() {
        return;
    }
    println!("cargo:rerun-if-changed=desktop/dist");
    println!("cargo:rerun-if-changed=desktop/src");
    println!("cargo:rerun-if-changed=desktop/src-tauri/tauri.conf.json");
    let desktop_debug = std::env::var_os("CARGO_FEATURE_DESKTOP_DEBUG").is_some();
    let capabilities = if desktop_debug {
        "desktop/src-tauri/debug-capabilities/**/*"
    } else {
        "desktop/src-tauri/capabilities/**/*"
    };
    if desktop_debug {
        let config = std::env::var("TAURI_CONFIG").unwrap_or_else(|_| {
            r#"{"app":{"windows":[{"label":"main","title":"Model Proxy","width":1240,"height":860,"minWidth":920,"minHeight":680,"center":true,"resizable":true,"visible":true}],"security":{"capabilities":["mcp"],"csp":"default-src 'self'; connect-src ipc: http://ipc.localhost ws://127.0.0.1:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-eval'"},"withGlobalTauri":true}}"#.to_owned()
        });
        std::env::set_var("TAURI_CONFIG", &config);
        println!("cargo:rustc-env=TAURI_CONFIG={config}");
    }
    tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern(capabilities))
        .expect("model-proxy Tauri configuration must be valid");
}
