# dbx-tools-google

Python bindings for Google integrations. The current surface provides Google
Application Default Credentials through the native Rust implementation.

```python
from dbx_tools.google import GoogleAuthOptions, create_google_auth

auth = await create_google_auth(GoogleAuthOptions())
token = await auth.token()
```

ADC checks `GOOGLE_APPLICATION_CREDENTIALS`, gcloud's well-known credentials
file, then the Google Cloud metadata service. Install from PyPI with
`pip install dbx-tools-google`.
