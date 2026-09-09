# dbx-tools-google-rs

Generated Python bindings for Google Application Default Credentials from the
`dbx-tools-google` Rust crate.

```python
from dbx_tools.google_rs.bindings import GoogleAuthOptions, create_google_auth

auth = await create_google_auth(GoogleAuthOptions())
token = await auth.token()
```

ADC checks `GOOGLE_APPLICATION_CREDENTIALS`, gcloud's well-known credentials
file, then the Google Cloud metadata service. Install from PyPI with
`pip install dbx-tools-google-rs`.
