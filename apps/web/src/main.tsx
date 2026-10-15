import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./api";
import { router } from "./router";
import { ThemeProvider } from "./theme";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Auth and validation errors will not fix themselves; only retry when the server was unreachable.
      retry: (count, err) => err instanceof ApiError && err.code === "unreachable" && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Elemen #root tidak ditemukan");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
