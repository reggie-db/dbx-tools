import { SshManager } from "@dbx-tools/ui-ssh/react";

const Ssh = () => (
  <div className="mx-auto h-full w-full max-w-6xl overflow-auto p-4 md:p-6">
    <div className="mb-4">
      <h1 className="text-lg font-semibold">SSH</h1>
      <p className="text-sm text-muted-foreground">
        Manage existing machines and routes to services running on them.
      </p>
    </div>
    <SshManager />
  </div>
);

export default Ssh;
