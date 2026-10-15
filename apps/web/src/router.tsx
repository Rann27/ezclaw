import { Link, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { Shell } from "./components/Shell";
import { readLastMode } from "./modes";
import { AgentPage } from "./pages/AgentPage";
import { ChatPage } from "./pages/ChatPage";
import { EditPage } from "./pages/EditPage";
import { ImagePage } from "./pages/ImagePage";
import { EndpointsPage } from "./pages/settings/EndpointsPage";
import { GeneralPage } from "./pages/settings/GeneralPage";
import { HarnessPage } from "./pages/settings/HarnessPage";
import { ModelsPage } from "./pages/settings/ModelsPage";
import { SettingsLayout } from "./pages/settings/SettingsLayout";

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

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "settings", component: SettingsLayout });
const settingsIndex = createRoute({ getParentRoute: () => settingsRoute, path: "/", component: GeneralPage });
const settingsEndpoints = createRoute({ getParentRoute: () => settingsRoute, path: "endpoints", component: EndpointsPage });
const settingsModels = createRoute({ getParentRoute: () => settingsRoute, path: "models", component: ModelsPage });
const settingsHarness = createRoute({ getParentRoute: () => settingsRoute, path: "harness", component: HarnessPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  agentRoute,
  imageRoute,
  editRoute,
  settingsRoute.addChildren([settingsIndex, settingsEndpoints, settingsModels, settingsHarness]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
