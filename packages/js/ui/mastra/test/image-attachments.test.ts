import { describe, expect, it } from "bun:test";
import { fitImageDimensions, MAX_COMPOSER_IMAGE_EDGE } from "../src/react/_image-attachments.ts";

describe("fitImageDimensions", () => {
  it("keeps images already within the maximum edge unchanged", () => {
    expect(fitImageDimensions(1200, 800)).toEqual({ width: 1200, height: 800 });
  });

  it("shrinks landscape images while preserving their aspect ratio", () => {
    expect(fitImageDimensions(6000, 3000)).toEqual({
      width: MAX_COMPOSER_IMAGE_EDGE,
      height: MAX_COMPOSER_IMAGE_EDGE / 2,
    });
  });

  it("shrinks portrait images while preserving their aspect ratio", () => {
    expect(fitImageDimensions(3000, 6000)).toEqual({
      width: MAX_COMPOSER_IMAGE_EDGE / 2,
      height: MAX_COMPOSER_IMAGE_EDGE,
    });
  });
});
