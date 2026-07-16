/**
 * Minimal AppKit UI example. Uses appkit-ui primitives when available;
 * falls back to a plain heading so the package compiles without a live workspace.
 */
export function App(): JSX.Element {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>AppKit client example</h1>
      <p>Wire @databricks/appkit-ui components here for a full Databricks App UI.</p>
    </main>
  );
}
