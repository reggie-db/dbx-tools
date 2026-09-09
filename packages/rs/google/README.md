# dbx-tools-google

Google integrations backed by native Rust libraries. The current surface is
Google Application Default Credentials.

Credential discovery follows ADC:

1. `GOOGLE_APPLICATION_CREDENTIALS`;
2. gcloud's well-known `application_default_credentials.json`;
3. the Google Cloud metadata service.

The package never invokes gcloud or rewrites ADC. Configure local user
credentials with `gcloud auth application-default login`. ADC is the only
persistent credential store; short-lived tokens use `dbx-tools-core`'
shared auth lifecycle and remain in process memory.

```rust
let auth = create_google_auth(GoogleAuthOptions::default()).await?;
let token = auth.token().await?;
```

UniFFI bindings are published as `@dbx-tools/google-rs` and
`dbx-tools-google-rs`.
