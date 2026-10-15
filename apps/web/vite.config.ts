import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const apiPort = Number(process.env.EZCLAW_API_PORT ?? 8787);
const webPort = Number(process.env.EZCLAW_WEB_PORT ?? 5173);

/** In dev the page comes from Vite, so Vite writes the session token that scripts/dev.mjs shared. */
function devSessionToken(): Plugin {
  return {
    name: "ezclaw-dev-session",
    apply: "serve",
    transformIndexHtml(html) {
      const token = process.env.EZCLAW_SESSION_TOKEN;
      return token ? html.replace("__EZCLAW_SESSION__", token) : html;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devSessionToken()],
  server: {
    host: "localhost",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
  },
});
