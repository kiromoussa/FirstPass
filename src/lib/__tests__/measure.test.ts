import { describe, expect, it } from "vitest";
import {
  convertValue,
  crossCheckFactValue,
  parseAllMeasures,
  parseMeasure,
} from "../measure";

describe("parseMeasure", () => {
  it("parses architectural feet-inches", () => {
    expect(parseMeasure(`19'-0"`)).toMatchObject({ value: 19, unit: "ft" });
    expect(parseMeasure(`9'-10"`)?.value).toBeCloseTo(9.8333, 3);
    expect(parseMeasure(`9' - 10"`)?.value).toBeCloseTo(9.8333, 3);
    expect(parseMeasure(`9'-10 1/2"`)?.value).toBeCloseTo(9.875, 3);
  });

  it("parses feet-inches inside a real plan label", () => {
    expect(parseMeasure(`TOP OF ROOF ±19'-0"`)).toMatchObject({ value: 19, unit: "ft" });
  });

  it("parses square-feet variants", () => {
    expect(parseMeasure("361 SQ.FT.")).toMatchObject({ value: 361, unit: "sqft" });
    expect(parseMeasure("800 SF")).toMatchObject({ value: 800, unit: "sqft" });
    expect(parseMeasure("1,200 sq ft")).toMatchObject({ value: 1200, unit: "sqft" });
    expect(parseMeasure("5.7 square feet")).toMatchObject({ value: 5.7, unit: "sqft" });
  });

  it("parses plain feet, inches, percent, counts", () => {
    expect(parseMeasure("18'")).toMatchObject({ value: 18, unit: "ft" });
    expect(parseMeasure("18 ft")).toMatchObject({ value: 18, unit: "ft" });
    expect(parseMeasure(`24"`)).toMatchObject({ value: 24, unit: "in" });
    expect(parseMeasure("44 in min")).toMatchObject({ value: 44, unit: "in" });
    expect(parseMeasure("45%")).toMatchObject({ value: 45, unit: "pct" });
    expect(parseMeasure("2 parking spaces")).toMatchObject({ value: 2, unit: "spaces" });
    expect(parseMeasure("3 dwelling units")).toMatchObject({ value: 3, unit: "units" });
  });

  it("treats a bare number as unit-unknown", () => {
    expect(parseMeasure("19")).toMatchObject({ value: 19, unit: "unknown" });
    expect(parseMeasure("SETBACK NINE")).toBeNull();
    expect(parseMeasure("")).toBeNull();
    expect(parseMeasure(null)).toBeNull();
  });

  it("never double-parses a feet-inches string as separate ft + in", () => {
    const all = parseAllMeasures(`19'-0"`);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ value: 19, unit: "ft" });
  });

  it("finds every dimension in a multi-value label", () => {
    const all = parseAllMeasures("LOT 5,000 SF, ADU 800 SF");
    expect(all.map((m) => m.value)).toEqual([5000, 800]);
    expect(all.every((m) => m.unit === "sqft")).toBe(true);
  });
});

describe("convertValue", () => {
  it("converts between compatible units", () => {
    expect(convertValue(24, "in", "ft")).toBe(2);
    expect(convertValue(2, "ft", "in")).toBe(24);
    expect(convertValue(288, "sqin", "sqft")).toBe(2);
    expect(convertValue(361, "sqft", "sqft")).toBe(361);
  });

  it("refuses incompatible units", () => {
    expect(convertValue(5, "ft", "sqft")).toBeNull();
    expect(convertValue(5, "pct", "ft")).toBeNull();
    expect(convertValue(5, null, "ft")).toBeNull();
  });
});

describe("crossCheckFactValue", () => {
  it("agrees when the label matches the extracted value", () => {
    expect(crossCheckFactValue(19, "ft", `TOP OF ROOF ±19'-0"`).verdict).toBe("agree");
    expect(crossCheckFactValue(9.8, "ft", `9'-10"`).verdict).toBe("agree");
    expect(
      crossCheckFactValue(361, "sqft", "EXISTING (361 SQ.FT.) GARAGE TO BE CONVERTED").verdict
    ).toBe("agree");
  });

  it("agrees across unit conversion (label in inches, fact in ft)", () => {
    expect(crossCheckFactValue(2, "ft", `24" CLEAR`).verdict).toBe("agree");
  });

  it("disagrees when the single unambiguous label value contradicts", () => {
    const res = crossCheckFactValue(12, "ft", `TOP OF ROOF ±19'-0"`);
    expect(res.verdict).toBe("disagree");
    expect(res.expected).toBe(19);
  });

  it("stays unverified when the label is ambiguous", () => {
    // Two candidates, neither matching → never claim contradiction.
    expect(crossCheckFactValue(300, "sqft", "LOT 5,000 SF, ADU 800 SF").verdict).toBe(
      "unverified"
    );
    // Bare number is unit-ambiguous — matches earn agreement, mismatches don't accuse.
    expect(crossCheckFactValue(9, "ft", "9").verdict).toBe("agree");
    expect(crossCheckFactValue(108, "ft", "9").verdict).toBe("unverified");
    // No parseable dimension at all.
    expect(crossCheckFactValue(9, "ft", "REAR YARD").verdict).toBe("unverified");
  });

  it("never judges the sheets/docs pseudo-fact", () => {
    expect(crossCheckFactValue(3, "docs", "3 sheets").verdict).toBe("unverified");
  });
});
