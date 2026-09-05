# dbx-tools-google-auth

Google Application Default Credentials with the shared dbx-tools token
lifecycle.

The crate uses Google's native `google-cloud-auth` Rust library. Credential
discovery follows ADC:

1. `GOOGLE_APPLICATION_CREDENTIALS`;
2. gcloud's well-known `application_default_credentials.json`;
3. the Google Cloud metadata service.

For local user credentials, run `gcloud auth application-default login`. The
Rust package reads the same ADC file used by
`gcloud auth application-default print-access-token` and refreshes it without
invoking gcloud.

ADC remains the only persistent credential store. Short-lived access tokens
stay in process memory and use `dbx-tools-auth` for expiry checks,
check-lock-check refresh, rejected-token comparison, and in-process refresh
locks.

`GoogleAuthOptions.auth` accepts the shared `AuthOptions` record.
`GoogleAuthOptions.access_token_ttl_seconds` defaults to 3600 and applies only
when the native ADC provider omits expiry.

```rust
let auth = create_google_auth(GoogleAuthOptions::default()).await?;
let token = auth.token().await?;
```

The generated packages are
[`@dbx-tools/google-auth`](../../js/node/google-auth) and
[`dbx-tools-google-auth`](../../py/google-auth).
