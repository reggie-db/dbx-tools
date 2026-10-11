import { SandboxStats } from "@dbx-tools/ui-databricks-sandbox/react";
import { Navigate, useParams } from "react-router-dom";

const SandboxStatsPage = () => {
  const { machineId } = useParams<{ machineId: string }>();
  if (!machineId) return <Navigate to="/sandbox" replace />;
  return <SandboxStats machineId={machineId} />;
};

export default SandboxStatsPage;
