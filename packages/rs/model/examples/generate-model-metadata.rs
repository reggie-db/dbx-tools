use std::path::PathBuf;

use dbx_tools_model::{
    refresh_generated_model_capabilities, refresh_generated_model_rate_limits,
    refresh_generated_retired_models,
};

const USAGE: &str =
    "usage: generate-model-metadata RETIRED_MODELS MODEL_CAPABILITIES MODEL_RATE_LIMITS";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os().skip(1).map(PathBuf::from);
    let retired_models = arguments.next().ok_or(USAGE)?;
    let model_capabilities = arguments.next().ok_or(USAGE)?;
    let model_rate_limits = arguments.next().ok_or(USAGE)?;
    if arguments.next().is_some() {
        return Err(USAGE.into());
    }
    let (retired_models_result, model_capabilities_result, model_rate_limits_result) = tokio::join!(
        refresh_generated_retired_models(&retired_models),
        refresh_generated_model_capabilities(&model_capabilities),
        refresh_generated_model_rate_limits(&model_rate_limits),
    );
    retired_models_result?;
    model_capabilities_result?;
    model_rate_limits_result?;
    Ok(())
}
