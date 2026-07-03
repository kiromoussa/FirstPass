import { describe, expect, it } from "vitest";
import { compareNumeric, normalize, scoreFrom, suggestFix } from "../compliance";
import type { PlanFact, Rule, Unit } from "../types";

const fact = (value: number | null, unit: Unit = "ft", confidence = 0.9): PlanFact => ({
  key: "height",
  label: "Building height",
  value,
  unit,
  sheet: "A5.0",
  bbox: null,
  confidence,
});

const rule = (threshold: number, operator: "<=" | ">=" = "<=", unit: Unit = "ft"): Rule => ({
  key: "height",
  label: "Height limit",
  appliesTo: "detached_adu",
  operator,
  threshold,
  unit,
  sourceId: "S1",
  description: "Max height",
});

describe("normalize", () => {
  it("passes through same units", () => {
    expect(normalize(19, "ft", "ft")).toBe(19);
    expect(normalize(19, null, null)).toBe(19);
  });

  it("converts compatible units", () => {
    expect(normalize(24, "in", "ft")).toBe(2);
    expect(normalize(288, "sqin", "sqft")).toBe(2);
  });

  it("returns null for incompatible units", () => {
    expect(normalize(19, "ft", "sqft")).toBeNull();
  });
});

describe("compareNumeric", () => {
  it("flags unit mismatches for review instead of comparing raw numbers", () => {
    const res = compareNumeric(fact(19, "ft"), rule(850, "<=", "sqft"));
    expect(res.status).toBe("NEEDS_REVIEW");
    expect(res.detail).toContain("cannot compare");
  });

  it("still gates on missing value and low confidence", () => {
    expect(compareNumeric(fact(null), rule(16)).status).toBe("NEEDS_REVIEW");
    expect(compareNumeric(fact(19, "ft", 0.5), rule(16)).status).toBe("NEEDS_REVIEW");
  });

  it("PASS / WARNING / FAIL with the exceedance delta in the detail", () => {
    expect(compareNumeric(fact(12), rule(16)).status).toBe("PASS");
    const warn = compareNumeric(fact(15.5), rule(16));
    expect(warn.status).toBe("WARNING");
    const failRes = compareNumeric(fact(19), rule(16));
    expect(failRes.status).toBe("FAIL");
    expect(failRes.detail).toContain("by 3ft");
  });

  it("compares >= minimums", () => {
    expect(compareNumeric(fact(9.8), rule(4, ">=")).status).toBe("PASS");
    const res = compareNumeric(fact(2), rule(4, ">="));
    expect(res.status).toBe("FAIL");
    expect(res.detail).toContain("by 2ft");
  });
});

describe("suggestFix", () => {
  it("names the exact delta on a FAIL (never a bare flag)", () => {
    const fix = suggestFix(fact(19), rule(16), "FAIL", "Height limit");
    expect(fix).toContain("Reduce");
    expect(fix).toContain("3ft");
    expect(fix).toContain("19ft");
  });

  it("suggests increases against minimums", () => {
    const fix = suggestFix(fact(2), rule(4, ">="), "FAIL", "Rear setback");
    expect(fix).toContain("Increase");
    expect(fix).toContain("2ft");
  });

  it("degrades gracefully without a measured value", () => {
    const fix = suggestFix(fact(null), rule(16), "FAIL", "Height limit");
    expect(fix).toContain("meets the cited");
  });

  it("says something useful for WARNING and NEEDS_REVIEW", () => {
    expect(suggestFix(fact(15.5), rule(16), "WARNING", "Height limit")).toContain("close to");
    expect(suggestFix(fact(null), rule(16), "NEEDS_REVIEW", "Height limit")).toContain("verify");
  });
});

describe("scoreFrom", () => {
  it("keeps the existing deterministic scoring", () => {
    expect(scoreFrom(["PASS", "PASS"])).toBe(100);
    expect(scoreFrom(["FAIL", "WARNING", "NEEDS_REVIEW"])).toBe(60);
  });
});
