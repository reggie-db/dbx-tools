use std::path::PathBuf;

use dbx_tools_model::{refresh_generated_model_capabilities, refresh_generated_retired_models};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os().skip(1).map(PathBuf::from);
    let retired_models = arguments
        .next()
        .ok_or("usage: generate-model-metadata RETIRED_MODELS MODEL_CAPABILITIES")?;
    let model_capabilities = arguments
        .next()
        .ok_or("usage: generate-model-metadata RETIRED_MODELS MODEL_CAPABILITIES")?;
    if arguments.next().is_some() {
        return Err("usage: generate-model-metadata RETIRED_MODELS MODEL_CAPABILITIES".into());
    }
    let (retired_models_result, model_capabilities_result) = tokio::join!(
        refresh_generated_retired_models(&retired_models),
        refresh_generated_model_capabilities(&model_capabilities),
    );
    retired_models_result?;
    model_capabilities_result?;
    Ok(())
}
