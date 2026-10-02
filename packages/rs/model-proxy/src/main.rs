//! Command-line entry point for the Databricks model proxy.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    dbx_tools_model_proxy::execute()
}
