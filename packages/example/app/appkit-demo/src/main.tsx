import { AuthGate } from "@dbx-tools/ui-auth/react";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

const App = lazy(() => import("./App.tsx"));

// `AuthGate` fronts the app with passkey-first Better Auth and email OTP recovery
// when the server's tunnel authGate is active.
// It checks `/api/email/auth/status` on mount: if the gate is off or a session
// already exists it renders the lazy app, so unauthenticated visitors do not
// download the feature UI and its chart/card/search dependencies.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthGate title="dbx-tools demo" description="Sign in with your email to continue.">
        <Suspense
          fallback={
            <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
              Loading application...
            </div>
          }
        >
          <App />
        </Suspense>
      </AuthGate>
    </ErrorBoundary>
  </StrictMode>,
);
