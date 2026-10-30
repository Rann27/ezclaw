import { describe, expect, it } from "vitest";
import { checkNativePicker } from "./services/nativePicker.js";

describe("native folder picker", () => {
  it.runIf(process.platform === "win32")("the dialog code compiles (nothing is shown)", async () => {
    expect(await checkNativePicker()).toBe(true);
  }, 60_000);
});
