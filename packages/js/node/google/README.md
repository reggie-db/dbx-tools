# @dbx-tools/google

Google integrations backed by native Rust libraries. The current surface is
Google Application Default Credentials.

```ts
import { createGoogleAuth, GoogleAuthOptions } from "@dbx-tools/google";

const auth = await createGoogleAuth(GoogleAuthOptions.create({}));
const token = await auth.token();
```

ADC checks `GOOGLE_APPLICATION_CREDENTIALS`, gcloud's well-known credentials
file, then the Google Cloud metadata service. It never invokes gcloud or
rewrites ADC. Shared token lifecycle types come from `@dbx-tools/client`.
