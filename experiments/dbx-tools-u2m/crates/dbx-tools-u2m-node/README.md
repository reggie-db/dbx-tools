# dbx-tools-u2m Node bindings

Generated Node.js bindings using `uniffi-bindgen-react-native`'s new N-API target and the `@ubjs/node` runtime. This is the Node runtime, not the React Native JSI runtime.

Build and run the example:

```bash
npm install
npm run build
DATABRICKS_CONFIG_PROFILE=DEFAULT npm run example
```

```js
import { createPersistentAuth, U2mOptions } from "@dbx-tools/u2m-native";

const auth = await createPersistentAuth(U2mOptions.create({ profile: "DEFAULT" }));
await auth.challenge();
const token = await auth.token();
const refreshed = await auth.forceRefreshToken();
```

Names mirror Go's `PersistentAuth`: `Challenge`, `Token`, and `ForceRefreshToken`. UniFFI renders them as lower camel case in TypeScript.
