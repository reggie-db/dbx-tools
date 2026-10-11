import { SandboxTerminal } from "@dbx-tools/ui-databricks-sandbox/react";
import { Navigate, useParams } from "react-router-dom";

const SandboxTerminalPage = () => {
  const { machineId } = useParams<{ machineId: string }>();
  if (!machineId) return <Navigate to="/sandbox" replace />;
  return <SandboxTerminal machineId={machineId} className="min-h-0 flex-1" />;
};

export default SandboxTerminalPage;
