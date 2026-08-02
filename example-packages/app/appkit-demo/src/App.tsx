import { brand } from "@dbx-tools/shared-core";
import { Button, Separator } from "@dbx-tools/ui-appkit/react";
import { BrandIcon, BrandProvider, useBrand } from "@dbx-tools/ui-branding/react";
import { useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import Brand from "@/pages/Brand";
import Cards from "@/pages/Cards";
import Conversations from "@/pages/Conversations";
import Search from "@/pages/Search";
import Stream from "@/pages/Stream";

// Real browser routes so deep links (and refreshing on `/stream`) land
// on the right page. AppKit's dev and static servers already SPA-fallback
// any non-`/api`, non-`/query` path to index.html, so BrowserRouter is
// safe in both `bun run dev` and a deployed Databricks App.

type RouteDef = {
  path: string;
  label: string;
  description: string;
  element: React.ReactNode;
};

const BASE_ROUTES: RouteDef[] = [
  {
    path: "/stream",
    label: "Stream",
    description: "@mastra/client-js agent.stream()",
    element: <Stream />,
  },
  {
    path: "/conversations",
    label: "Conversations",
    description: "Multi-conversation storage with thread switcher",
    element: <Conversations />,
  },
  {
    path: "/cards",
    label: "Cards",
    description: "A simulated Teams chat where the agent answers in Adaptive Cards",
    element: <Cards />,
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
  return (
    <nav className="mx-auto flex max-w-6xl items-center gap-2 overflow-x-auto px-4 py-2 md:px-6">
      <Link to="/brand" className="mr-1 flex shrink-0 items-center gap-2 text-sm font-semibold">
        <BrandIcon className="size-6" />
        <span>{context.shortName}</span>
      </Link>
      <div className="flex items-center gap-1">
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
    </nav>
  );
};

const App = () => {
  const [brandContext, setBrandContext] = useState(brand.defaultBrandContext);
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
        <div className="flex h-dvh flex-col">
          <header>
            <Nav routes={routes} />
            <Separator />
          </header>
          <main className="min-h-0 flex-1">
            <Routes>
              <Route path="/" element={<Navigate to="/stream" replace />} />
              {routes.map((route) => (
                <Route key={route.path} path={route.path} element={route.element} />
              ))}
              <Route path="*" element={<Navigate to="/stream" replace />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </BrandProvider>
  );
};

export default App;
