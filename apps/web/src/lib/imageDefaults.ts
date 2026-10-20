import type { ImageParams } from "@ezclaw/core";

/** Set only when the owner turned Venice safe mode on; off is the default. */
const SAFE_MODE_KEY = "ezclaw.venice.safeMode.on";

function safeModeOn(): boolean {
  try {
    return localStorage.getItem(SAFE_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Starting params for a new Image or Edit thread. */
export function newImageParams(): ImageParams {
  return withSafeModePref({});
}

/**
 * Params of an opened thread with the safe-mode choice applied. The switch is a standing preference,
 * not part of one thread, so reopening a thread (or reloading) never changes what gets sent.
 */
export function withSafeModePref(params: ImageParams): ImageParams {
  const { safeMode: _drop, ...rest } = params;
  return safeModeOn() ? { ...rest, safeMode: true } : rest;
}

export function rememberSafeMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(SAFE_MODE_KEY, "1");
    else localStorage.removeItem(SAFE_MODE_KEY);
    // The old key from when safe mode was on by default.
    localStorage.removeItem("ezclaw.venice.safeMode");
  } catch {
    // Private windows may refuse storage; the switch still applies to this thread.
  }
}
