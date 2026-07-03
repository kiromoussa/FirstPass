import { describe, expect, it } from "vitest";
import {
  mapTileBboxToSheet,
  parseFactBbox,
  sanitizeExtractedFact,
  type FactRegion,
} from "../fact-sanitize";
import type { Unit } from "../types";

const HEIGHT = { key: "height", label: "Building height", unit: "ft" as Unit };

describe("parseFactBbox", () => {
  it("accepts a valid normalized bbox", () => {
    expect(parseFactBbox([0.1, 0.2, 0.3, 0.4])).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("treats the [0,0,0,0] 'cannot localize' sentinel as no bbox", () => {
    expect(parseFactBbox([0, 0, 0, 0])).toBeNull();
  });

  it("rejects malformed boxes", () => {
    expect(parseFactBbox(null)).toBeNull();
    expect(parseFactBbox([0.1, 0.2, 0.3])).toBeNull();
    expect(parseFactBbox([1.2, 0, 0.1, 0.1])).toBeNull();
    expect(parseFactBbox([-0.1, 0, 0.1, 0.1])).toBeNull();
    expect(parseFactBbox([0.1, 0.1, -0.2, 0.1])).toBeNull();
    expect(parseFactBbox(["a", 0, 0.1, 0.1])).toBeNull();
  });

  it("clamps slight overshoot instead of discarding", () => {
    expect(parseFactBbox([0.9, 0.9, 0.2, 0.2])).toEqual([0.9, 0.9, expect.closeTo(0.1), expect.closeTo(0.1)]);
  });
});

describe("mapTileBboxToSheet", () => {
  it("re-normalizes a tile bbox to full-sheet coordinates", () => {
    const mapped = mapTileBboxToSheet([0.5, 0.5, 0.1, 0.1], { row: 1, col: 2, rows: 2, cols: 2 });
    expect(mapped[0]).toBeCloseTo(0.75);
    expect(mapped[1]).toBeCloseTo(0.25);
    expect(mapped[2]).toBeCloseTo(0.05);
    expect(mapped[3]).toBeCloseTo(0.05);
  });

  it("is the identity for a 1x1 grid", () => {
    expect(mapTileBboxToSheet([0.2, 0.3, 0.1, 0.1], { row: 1, col: 1, rows: 1, cols: 1 })).toEqual([
      0.2, 0.3, 0.1, 0.1,
    ]);
  });
});

describe("sanitizeExtractedFact", () => {
  it("returns null when the model produced no usable number", () => {
    expect(sanitizeExtractedFact(HEIGHT, undefined)).toBeNull();
    expect(sanitizeExtractedFact(HEIGHT, { value: "tall" })).toBeNull();
    expect(sanitizeExtractedFact(HEIGHT, { value: NaN })).toBeNull();
  });

  it("clamps confidence into 0..1", () => {
    const f = sanitizeExtractedFact(HEIGHT, { value: 19, confidence: 1.7, raw: "", sheet: "A5.0" });
    expect(f?.confidence).toBeLessThanOrEqual(1);
  });

  it("boosts confidence when the quoted label agrees with the value", () => {
    const f = sanitizeExtractedFact(HEIGHT, {
      value: 19,
      confidence: 0.8,
      raw: `TOP OF ROOF ±19'-0"`,
      sheet: "A5.0",
    });
    expect(f?.confidence).toBeCloseTo(0.9);
  });

  it("caps confidence below the review threshold on contradiction", () => {
    const f = sanitizeExtractedFact(HEIGHT, {
      value: 12,
      confidence: 0.9,
      raw: `TOP OF ROOF ±19'-0"`,
      sheet: "A5.0",
    });
    expect(f?.confidence).toBeLessThanOrEqual(0.5);
    expect(f?.raw).toContain("cross-check");
  });

  it("keeps sheet names clean of tile-grid suffixes", () => {
    const f = sanitizeExtractedFact(HEIGHT, {
      value: 19,
      confidence: 0.8,
      raw: "",
      sheet: "A5.0 (row 1, col 2)",
    });
    expect(f?.sheet).toBe("A5.0");
  });

  it("maps a tile bbox back to sheet coordinates via the region map", () => {
    const tileRegions = new Map<string, FactRegion>([
      ["A5.0 (row 1, col 2)", { x: 0.5, y: 0, w: 0.5, h: 0.5 }],
    ]);
    const f = sanitizeExtractedFact(
      HEIGHT,
      { value: 19, confidence: 0.8, raw: "", sheet: "A5.0", bbox: [0.5, 0.5, 0.2, 0.2], tile: "A5.0 (row 1, col 2)" },
      { tileRegions }
    );
    expect(f?.bbox?.[0]).toBeCloseTo(0.75);
    expect(f?.bbox?.[1]).toBeCloseTo(0.25);
    expect(f?.bbox?.[2]).toBeCloseTo(0.1);
    expect(f?.bbox?.[3]).toBeCloseTo(0.1);
  });

  it("drops the bbox when the cited tile is unknown (coords unmappable)", () => {
    const tileRegions = new Map<string, FactRegion>([
      ["A5.0 (row 1, col 1)", { x: 0, y: 0, w: 0.5, h: 0.5 }],
    ]);
    const f = sanitizeExtractedFact(
      HEIGHT,
      { value: 19, confidence: 0.8, raw: "", sheet: "A5.0", bbox: [0.5, 0.5, 0.2, 0.2], tile: "nope" },
      { tileRegions }
    );
    expect(f?.bbox).toBeNull();
  });

  it("keeps an image-normalized bbox when no region map is in play", () => {
    const f = sanitizeExtractedFact(HEIGHT, {
      value: 19,
      confidence: 0.8,
      raw: "",
      sheet: "A5.0",
      bbox: [0.5, 0.5, 0.2, 0.2],
    });
    expect(f?.bbox).toEqual([0.5, 0.5, 0.2, 0.2]);
  });
});
