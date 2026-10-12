import { SshManager } from "@dbx-tools/ui-databricks-sandbox/react";

const Sandboxes = () => (
  <div className="mx-auto h-full w-full max-w-6xl overflow-auto p-3 sm:p-4 md:p-6">
    <h1 className="sr-only">Sandboxes</h1>
    <SshManager />
  </div>
);

export default Sandboxes;
