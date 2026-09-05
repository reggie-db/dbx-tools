# dbx-tools-google-auth

Rust-generated Python bindings for Google Application Default Credentials.

```python
from dbx_tools.google_auth import (
    GoogleAuthOptions,
    create_google_auth,
)

auth = await create_google_auth(GoogleAuthOptions())
token = await auth.token()
```

Credential discovery uses `GOOGLE_APPLICATION_CREDENTIALS`, gcloud's standard
ADC file, then the Google Cloud metadata service. Short-lived access tokens stay
in process memory. The ADC file is the only persistent credential store.

Use `gcloud auth application-default login` to create local user ADC. The
binding does not invoke gcloud.

The implementation and option semantics live in the
[Rust package](../../rs/google-auth/README.md). Shared token and lifecycle
records come directly from [`dbx-tools-auth`](../auth).
