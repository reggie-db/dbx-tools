use std::path::PathBuf;

use dbx_tools_model::refresh_generated_model_capabilities;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: generate-model-capabilities OUTPUT")?;
    refresh_generated_model_capabilities(&output).await?;
    Ok(())
}
