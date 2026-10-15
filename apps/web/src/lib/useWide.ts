import { useSyncExternalStore } from "react";

const WIDE = "(min-width: 1280px)";

/** True when the window is wide enough to show the inspector beside the conversation. */
export function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(WIDE);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => window.matchMedia(WIDE).matches,
  );
}
