import { Link, createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { Shell } from "./components/Shell";
import { readLastMode } from "./modes";
const AgentPage = lazyRouteComponent(() => import("./pages/AgentPage"), "AgentPage");
const ChatPage = lazyRouteComponent(() => import("./pages/ChatPage"), "ChatPage");
const EditPage = lazyRouteComponent(() => import("./pages/EditPage"), "EditPage");
const ImagePage = lazyRouteComponent(() => import("./pages/ImagePage"), "ImagePage");
const EndpointsPage = lazyRouteComponent(() => import("./pages/settings/EndpointsPage"), "EndpointsPage");
const GeneralPage = lazyRouteComponent(() => import("./pages/settings/GeneralPage"), "GeneralPage");
const HarnessPage = lazyRouteComponent(() => import("./pages/settings/HarnessPage"), "HarnessPage");
const MemoryPage = lazyRouteComponent(() => import("./pages/settings/MemoryPage"), "MemoryPage");
const McpPage = lazyRouteComponent(() => import("./pages/settings/McpPage"), "McpPage");
const SkillsPage = lazyRouteComponent(() => import("./pages/settings/SkillsPage"), "SkillsPage");
const ModelsPage = lazyRouteComponent(() => import("./pages/settings/ModelsPage"), "ModelsPage");
const LibraryPage = lazyRouteComponent(() => import("./pages/LibraryPage"), "LibraryPage");
const SettingsLayout = lazyRouteComponent(() => import("./pages/settings/SettingsLayout"), "SettingsLayout");

function RoutePending() {
  return <p role="status" className="flex items-center gap-3 px-6 py-10 text-ui text-fg-2"><span className="node node-run" aria-hidden />Membuka ruang kerja</p>;
}

function NotFound() {
  return (
    <div className="mx-auto grid max-w-[var(--read-max)] gap-4 px-6 py-14">
      <h1 className="text-hero font-semibold">Halaman tidak ditemukan</h1>
      <p className="text-body text-fg-2">Alamat ini tidak ada di EZClaw.</p>
      <Link to="/chat" className="btn btn-secondary justify-self-start no-underline">
        Kembali ke Chat
      </Link>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFound });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: `/${readLastMode()}` });
  },
});

/** The thread is a search param, so moving between threads keeps one ChatPage mounted. */
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "chat",
  validateSearch: (search: Record<string, unknown>): { t?: string } => ({
    t: typeof search.t === "string" && search.t.length > 0 ? search.t : undefined,
  }),
  component: ChatPage,
});

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "agent",
  validateSearch: (search: Record<string, unknown>): { t?: string } => ({
    t: typeof search.t === "string" && search.t.length > 0 ? search.t : undefined,
  }),
  component: AgentPage,
});

const imageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "image",
  validateSearch: (search: Record<string, unknown>): { t?: string } => ({
    t: typeof search.t === "string" && search.t.length > 0 ? search.t : undefined,
  }),
  component: ImagePage,
});

const editRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "edit",
  validateSearch: (search: Record<string, unknown>): { t?: string; target?: string } => ({
    t: typeof search.t === "string" && search.t.length > 0 ? search.t : undefined,
    target: typeof search.target === "string" && search.target.length > 0 ? search.target : undefined,
  }),
  component: EditPage,
});

const libraryRoute = createRoute({ getParentRoute: () => rootRoute, path: "library", component: LibraryPage });

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "settings", component: SettingsLayout });
const settingsIndex = createRoute({ getParentRoute: () => settingsRoute, path: "/", component: GeneralPage });
const settingsEndpoints = createRoute({ getParentRoute: () => settingsRoute, path: "endpoints", component: EndpointsPage });
const settingsModels = createRoute({ getParentRoute: () => settingsRoute, path: "models", component: ModelsPage });
const settingsHarness = createRoute({ getParentRoute: () => settingsRoute, path: "harness", component: HarnessPage });
const settingsMemory = createRoute({ getParentRoute: () => settingsRoute, path: "memory", component: MemoryPage });
const settingsMcp = createRoute({ getParentRoute: () => settingsRoute, path: "mcp", component: McpPage });
const settingsSkills = createRoute({ getParentRoute: () => settingsRoute, path: "skills", component: SkillsPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  agentRoute,
  imageRoute,
  editRoute,
  libraryRoute,
  settingsRoute.addChildren([settingsIndex, settingsEndpoints, settingsModels, settingsHarness, settingsMemory, settingsMcp, settingsSkills]),
]);

export const router = createRouter({ routeTree, defaultPendingComponent: RoutePending });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
