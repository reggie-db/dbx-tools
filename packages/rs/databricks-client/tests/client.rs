use dbx_tools_databricks_client::Client;

#[test]
fn central_client_exposes_generated_services() {
    let client = Client::new("https://example.cloud.databricks.com");

    let _ = &client.dataquality;
    let _ = &client.jobs;
    let _ = &client.postgres;
}
