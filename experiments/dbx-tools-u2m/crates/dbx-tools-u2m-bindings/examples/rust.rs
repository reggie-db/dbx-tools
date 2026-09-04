use dbx_tools_u2m_bindings::{create_persistent_auth, U2mOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let auth = create_persistent_auth(U2mOptions::default()).await?;
    let token = auth.token().await?;
    println!("{}", token.token_type);
    Ok(())
}
