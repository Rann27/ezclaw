import { describe, expect, it } from "vitest";
import { defaultVideoSpec, mergeVideoSpec, openrouterVideoBody, resolveVideoParams, venicePairedId, veniceVideoBody, xaiVideoBody } from "./video.js";

describe("resolveVideoParams", () => {
  it("snaps a duration to the nearest one the model lists", () => {
    const spec = mergeVideoSpec(defaultVideoSpec("venice-video"), { durations: [5, 10] });
    const r = resolveVideoParams(spec, { duration: 8 }, { start: false, end: false });
    expect(r.params.duration).toBe(10);
    expect(r.notes[0]).toContain("8 detik");
  });

  it("clamps a duration to the model's range and starts from its default", () => {
    const spec = defaultVideoSpec("xai-videos");
    expect(resolveVideoParams(spec, { duration: 30 }, { start: false, end: false }).params.duration).toBe(15);
    expect(resolveVideoParams(spec, {}, { start: false, end: false }).params.duration).toBe(8);
  });

  it("follows the start frame with adaptive when the model offers it", () => {
    const spec = mergeVideoSpec(defaultVideoSpec("venice-video"), { aspectRatios: ["adaptive", "16:9", "9:16"] });
    expect(resolveVideoParams(spec, {}, { start: true, end: false }).params.aspectRatio).toBe("adaptive");
    expect(resolveVideoParams(spec, { aspectRatio: "9:16" }, { start: true, end: false }).params.aspectRatio).toBe("9:16");
  });

  it("always gives Venice a ratio when the model lists ratios", () => {
    const spec = mergeVideoSpec(defaultVideoSpec("venice-video"), { aspectRatios: ["16:9", "9:16"] });
    const r = resolveVideoParams(spec, {}, { start: false, end: false });
    expect(r.params.aspectRatio).toBe("16:9");
    expect(r.notes[0]).toContain("16:9");
    // Models that list no ratio get none.
    expect(resolveVideoParams(mergeVideoSpec(spec, { aspectRatios: [] }), {}, { start: true, end: false }).params.aspectRatio).toBeUndefined();
  });

  it("sends no ratio to xAI with a start frame", () => {
    expect(resolveVideoParams(defaultVideoSpec("xai-videos"), {}, { start: true, end: false }).params.aspectRatio).toBeUndefined();
  });

  it("sends sound only to models where it can be switched", () => {
    expect(resolveVideoParams(defaultVideoSpec("xai-videos"), { audio: false }, { start: false, end: false }).params.audio).toBe(false);
    expect(resolveVideoParams(defaultVideoSpec("venice-video"), { audio: false }, { start: false, end: false }).params.audio).toBeUndefined();
  });
});

describe("video bodies", () => {
  const input = { modelId: "m", prompt: "p", params: { duration: 5, resolution: "720p", audio: true }, startFrame: "data:image/png;base64,AAA", endFrame: "data:image/png;base64,BBB" };

  it("OpenRouter: frames carry their frame_type", () => {
    const b = openrouterVideoBody(input);
    expect(b.frame_images).toEqual([
      { type: "image_url", image_url: { url: input.startFrame }, frame_type: "first_frame" },
      { type: "image_url", image_url: { url: input.endFrame }, frame_type: "last_frame" },
    ]);
    expect(b).toMatchObject({ duration: 5, resolution: "720p", generate_audio: true });
  });

  it("Venice: duration as a string with seconds, frames as image_url and end_image_url", () => {
    expect(veniceVideoBody(input)).toMatchObject({ duration: "5s", image_url: input.startFrame, end_image_url: input.endFrame, audio: true });
  });

  it("xAI: the start frame is an image object", () => {
    expect(xaiVideoBody(input)).toMatchObject({ image: { url: input.startFrame }, duration: 5, generate_audio: true });
  });

  it("pairs Venice text and image variants", () => {
    expect(venicePairedId("wan-2.5-preview-text-to-video")).toBe("wan-2.5-preview-image-to-video");
    expect(venicePairedId("wan-2.5-preview-image-to-video")).toBe("wan-2.5-preview-text-to-video");
    expect(venicePairedId("veo-3")).toBeNull();
  });
});
