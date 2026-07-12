import { greet } from "@dbx-tools/shared-core";

export function App() {
  return (
    <main>
      <h1>{greet("dbx-tools")}</h1>
    </main>
  );
}
