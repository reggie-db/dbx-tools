fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args().skip(1);
    let output: std::path::PathBuf = match arguments.next().as_deref() {
        None => std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("desktop/src/bindings.ts"),
        Some("--output") => arguments.next().ok_or("--output requires a path")?.into(),
        Some(argument) => return Err(format!("unexpected argument: {argument}").into()),
    };
    if arguments.next().is_some() {
        return Err("only one output path may be supplied".into());
    }
    dbx_tools_model_proxy::desktop::export_bindings(output)
}
