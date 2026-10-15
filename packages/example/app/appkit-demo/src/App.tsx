import { brandUtils } from "@dbx-tools/shared-core";
import { getAuthStatus, logout as logoutAuth } from "@dbx-tools/ui/auth/react";
import { BrandIcon, BrandProvider, useBrand } from "@dbx-tools/ui/branding/react";
import { Button, Separator } from "@dbx-tools/ui/react";
import { MastraAssistant, useMastraAssistant } from "@dbx-tools/ui-mastra/react";
import { CircleHelpIcon, LoaderCircleIcon, LogOutIcon, PanelRightCloseIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";

const Brand = lazy(() => import("@/pages/Brand"));
const Bus = lazy(() => import("@/pages/Bus"));
const Chat = lazy(() => import("@/pages/Chat"));
const Search = lazy(() => import("@/pages/Search"));
const Lakebox = lazy(() => import("@/pages/Lakebox"));

const useVisualViewportShell = () => {
  useEffect(() => {
    const root = document.getElementById("root");
    const viewport = window.visualViewport;
    if (!root || !viewport) return;

    let animationFrame = 0;
    let settleTimer = 0;
    const commit = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        root.style.setProperty("--demo-visual-viewport-height", `${viewport.height}px`);
        root.style.setProperty("--demo-visual-viewport-top", `${viewport.offsetTop}px`);
        root.style.setProperty("--demo-visual-viewport-width", `${viewport.width}px`);
        root.style.setProperty("--demo-visual-viewport-left", `${viewport.offsetLeft}px`);
      });
    };
    const schedule = () => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(commit, 100);
    };

    commit();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    viewport.addEventListener("scrollend", commit);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(settleTimer);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      viewport.removeEventListener("scrollend", commit);
      root.style.removeProperty("--demo-visual-viewport-height");
      root.style.removeProperty("--demo-visual-viewport-top");
      root.style.removeProperty("--demo-visual-viewport-width");
      root.style.removeProperty("--demo-visual-viewport-left");
    };
  }, []);
};

// Real browser routes keep deep links refreshable while lazy page modules ensure
// each feature's dependencies load only when that route is selected. AppKit's
// dev and static servers SPA-fallback non-API paths to index.html.

type RouteDef = {
  path: string;
  label: string;
  description: string;
  guide: {
    summary: string;
    unlocks: readonly string[];
    useCases: readonly string[];
    docs: ReadonlyArray<{ label: string; href: string }>;
  };
  element: React.ReactNode;
};

const docsUrl = (path: string): string =>
  new URL(path, brandUtils.defaultBrandContext.links.documentation).toString();

const BASE_ROUTES: RouteDef[] = [
  {
    path: "/chat",
    label: "Chat",
    description: "One chat for governed agents and direct Genie conversations",
    guide: {
      summary:
        "Use the same conversation shell for a tool-using Mastra agent or a direct AI/BI Genie conversation. The Genie-only switch keeps both modes beside the same thread history.",
      unlocks: [
        "Streaming answers with governed tools, approvals, charts, and tables",
        "Persistent threads, history, model selection, export, and MLflow feedback",
        "Direct Genie conversations without a second application surface",
        "Mastra skills, memory, and search tools behind one authenticated AppKit route",
        "Consistent citations and visualization rendering across agent and Genie responses",
      ],
      useCases: [
        "A data-platform copilot that can search, query Genie, and request approved actions",
        "An analyst Q&A experience where Genie owns the conversation and visualizations",
        "A support assistant that keeps user context across multiple work sessions",
        "An operations agent that drafts email or external actions for human approval",
        "A governed assistant that traces every turn and captures reviewer feedback in MLflow",
      ],
      docs: [
        {
          label: "Configure a Mastra agent",
          href: docsUrl("guides/agents-and-genie/#register-a-mastra-agent"),
        },
        {
          label: "Render Mastra chat",
          href: docsUrl("guides/agents-and-genie/#render-mastra-chat"),
        },
        {
          label: "Render direct Genie chat",
          href: docsUrl("guides/agents-and-genie/#render-direct-genie-chat"),
        },
      ],
    },
    element: <Chat />,
  },
  {
    path: "/lakebox",
    label: "Lakebox",
    description: "Persistent per-user terminal, desktop, services, and metrics",
    guide: {
      summary:
        "Give each authenticated app user a persistent Linux workspace inside one app-owned Databricks Lakebox, without exposing workspace credentials to workloads.",
      unlocks: [
        "Browser terminal and desktop access with persistent user homes",
        "App-routed OCI services created from governed agent tools",
        "User isolation, service controls, and live machine-level metrics",
        "Repeatable showcase recipes an agent can deploy without exposing Docker access",
        "One app-owned runtime with deterministic user routing and no workload credentials",
      ],
      useCases: [
        "Run data-science tools that need a full Linux environment beside an AppKit app",
        "Let an agent create and manage a temporary visualization or development service",
        "Provide durable workspaces for workshops, investigations, or operator workflows",
        "Create a self-contained 3D dog scene and deploy it as a routed browser service",
        "Deploy an MS Paint-style editor or a platformer game from the Lakebox showcase skill",
      ],
      docs: [
        {
          label: "Configure Lakebox",
          href: docsUrl("packages/appkit-lakebox/#register-the-plugin"),
        },
        {
          label: "Create a Lakebox service",
          href: docsUrl("packages/appkit-lakebox/#create-a-service"),
        },
        {
          label: "Render Lakebox controls",
          href: docsUrl("guides/lakebox/#render-lakebox-controls"),
        },
      ],
    },
    element: <Lakebox />,
  },
  {
    path: "/search",
    label: "AI Search",
    description: "Instant, universal, and composable governed search",
    guide: {
      summary:
        "Put governed Databricks AI Search behind drop-in React controls and agent tools, with a Lakebase full-text option when Vector Search is not configured.",
      unlocks: [
        "Search-as-you-type over a configured index",
        "Universal search across multiple indexes with merged results",
        "The same search contract for React screens and Mastra agent tools",
        "A provider switch between governed Vector Search and Lakebase full-text search",
        "Index lifecycle APIs for seeding demos, updating documents, and deleting test data",
      ],
      useCases: [
        "Search product, support, or policy knowledge from an internal application",
        "Let an agent retrieve grounded records before it answers or acts",
        "Prototype locally with Lakebase, then move to governed Vector Search",
        "Build result cards that update while a user types without a separate search service",
        "Search multiple governed domains while preserving each hit's source index and score",
      ],
      docs: [
        {
          label: "Choose a search provider",
          href: docsUrl("packages/search/#choose-a-search-provider"),
        },
        {
          label: "Add search to a Mastra agent",
          href: docsUrl("packages/search/#add-search-to-a-mastra-agent"),
        },
      ],
    },
    element: <Search />,
  },
  {
    path: "/bus",
    label: "Message Bus",
    description: "Postgres topic broadcasts shared live across multiple viewers",
    guide: {
      summary:
        "Use Lakebase or PostgreSQL LISTEN/NOTIFY as a typed, app-scoped message bus for live coordination between browser sessions, replicas, and background work.",
      unlocks: [
        "Low-latency topic broadcasts across app replicas and connected clients",
        "Typed envelopes with sender identity and application metadata",
        "Optional persisted replay when consumers need to catch up",
        "SSE delivery to browsers without adding a separate broker or websocket service",
        "App-scoped topics that keep replica coordination separate from business data tables",
      ],
      useCases: [
        "Refresh dashboards when a long-running workflow completes",
        "Broadcast agent progress or shared operator events to every viewer",
        "Coordinate cache invalidation or lightweight work signals across replicas",
        "Notify reviewers when an approval request or background export is ready",
        "Keep multiple operator screens synchronized during an incident or rollout",
      ],
      docs: [
        {
          label: "Use the topic bus",
          href: docsUrl("packages/postgres/#topic-bus"),
        },
        {
          label: "Replay persisted messages",
          href: docsUrl("packages/postgres/#replay-with-persist"),
        },
      ],
    },
    element: <Bus />,
  },
];

const Nav = ({
  routes,
  guideOpen,
  onShowGuide,
}: {
  routes: readonly RouteDef[];
  guideOpen: boolean;
  onShowGuide: () => void;
}) => {
  const { pathname } = useLocation();
  const { context } = useBrand();
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
    <nav className="demo-nav mx-auto flex max-w-6xl items-center gap-2 px-2 py-2 sm:px-4 md:px-6">
      <Link to="/brand" className="mr-1 flex shrink-0 items-center gap-2 text-sm font-semibold">
        <BrandIcon className="size-6" />
        <span className="hidden sm:inline">{context.shortName}</span>
      </Link>
      <NavRouteStrip routes={routes} pathname={pathname} />
      {!guideOpen || logoutEnabled ? (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!guideOpen ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="hidden size-8 xl:inline-flex"
              aria-label="Show demo guide"
              title="Show demo guide"
              onClick={onShowGuide}
            >
              <CircleHelpIcon className="size-4" />
            </Button>
          ) : null}
          {logoutEnabled ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label={loggingOut ? "Logging out" : "Log out"}
              aria-busy={loggingOut}
              title="End the tunnel session"
              onClick={logout}
            >
              {loggingOut ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <LogOutIcon className="size-4" />
              )}
            </Button>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
};

const NavRouteStrip = ({ routes, pathname }: { routes: readonly RouteDef[]; pathname: string }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      const remaining = element.scrollWidth - element.clientWidth - element.scrollLeft;
      setOverflow({ left: element.scrollLeft > 2, right: remaining > 2 });
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [routes]);

  useEffect(() => {
    const element = scrollRef.current;
    const activeRoute = element?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!element || !activeRoute) return;
    scrollElementIntoContainer(element, activeRoute);
  }, [pathname]);

  const scroll = (direction: -1 | 1) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(120, element.clientWidth * 0.7),
      behavior: "smooth",
    });
  };

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={scrollRef}
        className="flex min-w-0 scroll-smooth items-center gap-1 overflow-x-auto"
      >
        {routes.map((route) => (
          <Button
            key={route.path}
            asChild
            size="sm"
            variant={pathname === route.path ? "default" : "ghost"}
          >
            <Link
              to={route.path}
              title={route.description}
              aria-current={pathname === route.path ? "page" : undefined}
            >
              {route.label}
            </Link>
          </Button>
        ))}
      </div>
      {overflow.left ? (
        <button
          type="button"
          className="absolute inset-y-0 left-0 flex w-8 items-center justify-start bg-gradient-to-r from-background via-background/95 to-transparent pl-0.5 text-lg font-semibold sm:hidden"
          aria-label="Show previous navigation tabs"
          onClick={() => scroll(-1)}
        >
          <span aria-hidden="true">‹</span>
        </button>
      ) : null}
      {overflow.right ? (
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-end bg-gradient-to-l from-background via-background/95 to-transparent pr-0.5 text-lg font-semibold sm:hidden"
          aria-label="Show more navigation tabs"
          onClick={() => scroll(1)}
        >
          <span aria-hidden="true">›</span>
        </button>
      ) : null}
    </div>
  );
};

function scrollElementIntoContainer(container: HTMLElement, element: HTMLElement): void {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  if (elementRect.left < containerRect.left) {
    container.scrollBy({ left: elementRect.left - containerRect.left, behavior: "smooth" });
  } else if (elementRect.right > containerRect.right) {
    container.scrollBy({ left: elementRect.right - containerRect.right, behavior: "smooth" });
  }
}

const AssistantRouteContext = () => {
  const { pathname } = useLocation();
  const { setRequestContext } = useMastraAssistant();
  useEffect(() => {
    setRequestContext({ route: pathname, surface: "floating-assistant" });
  }, [pathname, setRequestContext]);
  return null;
};

const AppShell = ({ routes }: { routes: readonly RouteDef[] }) => {
  const { pathname } = useLocation();
  const route = routes.find((candidate) => candidate.path === pathname) ?? routes[0]!;
  const [guideOpen, setGuideOpen] = useState(() => {
    try {
      return window.localStorage.getItem(GUIDE_STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const updateGuideOpen = (next: boolean) => {
    setGuideOpen(next);
    try {
      window.localStorage.setItem(GUIDE_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // The in-session control still works when storage is unavailable.
    }
  };
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
      className="h-full"
    >
      <div className="flex h-full flex-col">
        <AssistantRouteContext />
        <header className="demo-header shrink-0">
          <Nav routes={routes} guideOpen={guideOpen} onShowGuide={() => updateGuideOpen(true)} />
          <Separator />
        </header>
        <main className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
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
          </section>
          <DemoGuide route={route} open={guideOpen} onHide={() => updateGuideOpen(false)} />
        </main>
      </div>
    </MastraAssistant>
  );
};

const GUIDE_STORAGE_KEY = "demo-guide-open";

const DemoGuide = ({
  route,
  open,
  onHide,
}: {
  route: RouteDef;
  open: boolean;
  onHide: () => void;
}) => {
  if (!open) return null;

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-muted/20 xl:flex 2xl:w-96">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Demo guide</p>
          <h2 className="text-base font-semibold text-foreground">{route.label}</h2>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          aria-label="Hide demo guide"
          title="Hide demo guide"
          onClick={onHide}
        >
          <PanelRightCloseIcon className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 text-sm">
        <p className="leading-6 text-foreground/85">{route.guide.summary}</p>
        <GuideList title="What this unlocks" items={route.guide.unlocks} />
        <GuideList title="Example use cases" items={route.guide.useCases} />
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Read the docs</h3>
          <div className="space-y-1">
            {route.guide.docs.map((doc) => (
              <a
                key={doc.href}
                href={doc.href}
                target="_blank"
                rel="noreferrer"
                className="block rounded-md px-2 py-1.5 font-medium text-primary hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {doc.label}
              </a>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
};

const GuideList = ({ title, items }: { title: string; items: readonly string[] }) => (
  <section className="space-y-2">
    <h3 className="text-sm font-semibold text-foreground">{title}</h3>
    <ul className="space-y-2 text-muted-foreground">
      {items.map((item) => (
        <li key={item} className="flex gap-2 leading-5">
          <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  </section>
);

const App = () => {
  useVisualViewportShell();
  const [brandContext, setBrandContext] = useState(brandUtils.defaultBrandContext);
  const routes: RouteDef[] = [
    ...BASE_ROUTES,
    {
      path: "/brand",
      label: "Brand",
      description: "Live brand picker and rich email template previews",
      guide: {
        summary:
          "Apply one portable brand context to AppKit tokens, browser metadata, icons, and email presentation while still allowing a message-specific campaign identity.",
        unlocks: [
          "One typed source for application colors, typography, icons, and metadata",
          "Brand-aware authentication, navigation, email chrome, and rendered messages",
          "Scoped overrides for partner, event, or campaign communication",
          "Synchronized favicons, sender identity, document metadata, and AppKit design tokens",
          "Browser previews that reuse the same React Email card delivered to recipients",
        ],
        useCases: [
          "Ship the same internal application for multiple business units or customers",
          "Keep approval previews visually identical to delivered React Email messages",
          "Apply a temporary campaign identity without changing the surrounding app",
          "White-label a Databricks application while preserving one implementation and route set",
          "Send incident, launch, or weekly digest email with the correct message-specific identity",
        ],
        docs: [
          { label: "Apply application branding", href: docsUrl("packages/ui/#branding") },
          { label: "Render email surfaces", href: docsUrl("packages/ui/#email") },
        ],
      },
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
