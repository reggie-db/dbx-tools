use std::{fs, path::PathBuf};

use dbx_tools_model::{
    ModelClass, ModelProfile, ModelQuery, ModelStatus, RankedModel, ReasoningEffort,
    ServingEndpointSummary,
};
use serde::Serialize;
use ts_rs::{Config, TS};

const USAGE: &str = "usage: generate-model-contracts OUTPUT";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os().skip(1).map(PathBuf::from);
    let output = arguments.next().ok_or(USAGE)?;
    if arguments.next().is_some() {
        return Err(USAGE.into());
    }

    let declarations = [
        runtime_enum("ModelClass", &ModelClass::ORDER)?,
        runtime_enum("ReasoningEffort", &ReasoningEffort::ALL)?,
        exported::<ModelProfile>(),
        exported::<ModelStatus>(),
        exported::<ServingEndpointSummary>(),
        exported::<ModelQuery>(),
        exported::<RankedModel>(),
    ];
    let contents = format!(
        "// Generated from packages/rs/model. Do not edit.\n\n{}\n",
        declarations.join("\n\n")
    );
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::read_to_string(&output).ok().as_deref() != Some(contents.as_str()) {
        fs::write(output, contents)?;
    }
    Ok(())
}

fn exported<T: TS>() -> String {
    format!("export {}", T::decl(&Config::default()))
        .replace("{ [key in string]: string }", "Record<string, string>")
}

fn runtime_enum<T>(name: &str, values: &[T]) -> Result<String, serde_json::Error>
where
    T: Copy + std::fmt::Debug + Serialize,
{
    let serialized = values
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, serde_json::Error>>()?;
    let entries = values
        .iter()
        .zip(&serialized)
        .map(|(value, wire)| format!("  {value:?}: {wire},"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        "export const {name} = {{\n{entries}\n}} as const;\nexport type {name} = {};",
        serialized.join(" | ")
    ))
}
