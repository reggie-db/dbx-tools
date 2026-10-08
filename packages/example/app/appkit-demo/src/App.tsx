import { brandUtils } from "@dbx-tools/shared-core";
import { getAuthStatus, logout as logoutAuth } from "@dbx-tools/ui/auth/react";
import { BrandIcon, BrandProvider, useBrand } from "@dbx-tools/ui/branding/react";
import { Button, Separator } from "@dbx-tools/ui/react";
import { MastraAssistant, useMastraAssistant } from "@dbx-tools/ui-mastra/react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";

const Brand = lazy(() => import("@/pages/Brand"));
const Bus = lazy(() => import("@/pages/Bus"));
const Cards = lazy(() => import("@/pages/Cards"));
const Chat = lazy(() => import("@/pages/Chat"));
const Search = lazy(() => import("@/pages/Search"));

// Real browser routes keep deep links refreshable while lazy page modules ensure
// each feature's dependencies load only when that route is selected. AppKit's
// dev and static servers SPA-fallback non-API paths to index.html.

type RouteDef = {
  path: string;
  label: string;
  description: string;
  element: React.ReactNode;
};

const BASE_ROUTES: RouteDef[] = [
  {
    path: "/chat",
    label: "Chat",
    description: "Streaming assistant with tools, history, and threads",
    element: <Chat />,
  },
  {
    path: "/cards",
    label: "Cards",
    description: "A simulated Teams chat where the agent answers in Adaptive Cards",
    element: <Cards />,
  },
  {
    path: "/bus",
    label: "Bus",
    description: "Postgres topic broadcasts shared live across multiple viewers",
    element: <Bus />,
  },
  {
    path: "/search",
    label: "Search",
    description: "AI Search (Vector Search) instant search, universal search, and results",
    element: <Search />,
  },
];

const Nav = ({ routes }: { routes: readonly RouteDef[] }) => {
  const { pathname } = useLocation();
  const { context } = useBrand();
  const assistant = useMastraAssistant();
  const [logoutEnabled, setLogoutEnabled] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getAuthStatus()
      .then((status) => {
        if (!cancelled) setLogoutEnabled(status.enabled && status.authenticated);
      })
      .catch(() => {
        if (!cancelled) setLogoutEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(async () => {
    if (!logoutEnabled || loggingOut) return;
    setLoggingOut(true);
    try {
      if (!(await logoutAuth())) setLoggingOut(false);
    } catch {
      setLoggingOut(false);
    }
  }, [loggingOut, logoutEnabled]);

  return (
    <nav className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2 md:px-6">
      <Link to="/brand" className="mr-1 flex shrink-0 items-center gap-2 text-sm font-semibold">
        <BrandIcon className="size-6" />
        <span>{context.shortName}</span>
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {routes.map((route) => (
          <Button
            key={route.path}
            asChild
            size="sm"
            variant={pathname === route.path ? "default" : "ghost"}
          >
            <Link to={route.path} title={route.description}>
              {route.label}
            </Link>
          </Button>
        ))}
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="shrink-0"
        onClick={() =>
          assistant.open({
            route: pathname,
            surface: "navigation",
          })
        }
      >
        Assistant
      </Button>
      {logoutEnabled ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto shrink-0"
          aria-busy={loggingOut}
          title="End the tunnel session"
          onClick={logout}
        >
          {loggingOut ? "Logging out..." : "Log out"}
        </Button>
      ) : null}
    </nav>
  );
};

const AssistantRouteContext = () => {
  const { pathname } = useLocation();
  const { setRequestContext } = useMastraAssistant();
  useEffect(() => {
    setRequestContext({ route: pathname, surface: "floating-assistant" });
  }, [pathname, setRequestContext]);
  return null;
};

const AppShell = ({ routes }: { routes: readonly RouteDef[] }) => {
  return (
    <MastraAssistant
      mode="overlay"
      side="right"
      resizable={{ defaultSize: 480, minSize: 360, storageKey: "demo-assistant-size" }}
      title="Workflow assistant"
      description="Persistent across every demo route"
      icon={<BrandIcon className="size-4" />}
      launcher={false}
      chat={{ showModelPicker: true, enableExport: true, threadPlacement: "top" }}
      className="h-dvh"
    >
      <div className="flex h-full flex-col">
        <AssistantRouteContext />
        <header>
          <Nav routes={routes} />
          <Separator />
        </header>
        <main className="flex min-h-0 flex-1 flex-col">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading page...
              </div>
            }
          >
            <Routes>
              <Route path="/" element={<Navigate to="/chat" replace />} />
              {routes.map((route) => (
                <Route key={route.path} path={route.path} element={route.element} />
              ))}
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </MastraAssistant>
  );
};

const App = () => {
  const [brandContext, setBrandContext] = useState(brandUtils.defaultBrandContext);
  const routes: RouteDef[] = [
    ...BASE_ROUTES,
    {
      path: "/brand",
      label: "Brand",
      description: "Live brand picker and rich email template previews",
      element: <Brand value={brandContext} onChange={setBrandContext} />,
    },
  ];

  return (
    // `applyToDocument` writes the brand CSS vars + sets `data-brand` (which
    // activates the inert `:root[data-brand]` token bridge) and updates the
    // page title + favicon whenever the picker changes the context.
    <BrandProvider context={brandContext} applyToDocument>
      <BrowserRouter>
        <AppShell routes={routes} />
      </BrowserRouter>
    </BrandProvider>
  );
};

export default App;
