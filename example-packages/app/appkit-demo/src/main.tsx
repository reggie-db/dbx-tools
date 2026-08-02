import { AuthGate } from "@dbx-tools/ui-email/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

// `AuthGate` fronts the app with the email-OTP login when the server's email
// plugin has `auth` enabled (this demo is exposed through a public portr tunnel).
// It checks `/api/email/auth/status` on mount: if the gate is off or a session
// already exists it renders the app immediately, so it is inert in local dev
// where auth is disabled.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthGate
        title="dbx-tools demo"
        description="Sign in with your Databricks email to continue."
      >
        <App />
      </AuthGate>
    </ErrorBoundary>
  </StrictMode>,
);
