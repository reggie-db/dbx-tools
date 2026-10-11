import { SshManager } from "@dbx-tools/ui-databricks-sandbox/react";

const Sandboxes = () => (
  <div className="mx-auto h-full w-full max-w-6xl overflow-auto p-4 md:p-6">
    <h1 className="mb-4 text-lg font-semibold">Sandboxes</h1>
    <SshManager />
  </div>
);

export default Sandboxes;
