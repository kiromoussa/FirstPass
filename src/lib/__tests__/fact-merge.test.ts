import { describe, expect, it } from "vitest";
import { mergePlanFactSets, needsVisionPass } from "../fact-merge";
import type { PlanFact, Unit } from "../types";

const fact = (key: string, value: number | string[] | null, confidence: number, unit: Unit = "ft", extra: Partial<PlanFact> = {}): PlanFact => ({
  key,
  label: key,
  value,
  unit,
  sheet: "A1.0",
  bbox: null,
  confidence,
  raw: "",
  ...extra,
});

const fullSet = (overrides: Record<string, PlanFact> = {}): PlanFact[] => [
  overrides.unitSize ?? fact("unitSize", 361, 0.9, "sqft"),
  overrides.height ?? fact("height", 19, 0.9),
  overrides.setbackRear ?? fact("setbackRear", 9.8, 0.9),
  overrides.setbackSide ?? fact("setbackSide", 8, 0.9),
  overrides.sheets ?? fact("sheets", ["A1.0"], 0.95, "docs"),
];

describe("needsVisionPass", () => {
  it("skips the vision pass when all core metrics are confidently read", () => {
    expect(needsVisionPass(fullSet())).toBe(false);
  });

  it("runs when a core metric is unread", () => {
    expect(needsVisionPass(fullSet({ height: fact("height", null, 0) }))).toBe(true);
  });

  it("runs when a core metric is low-confidence", () => {
    expect(needsVisionPass(fullSet({ height: fact("height", 19, 0.5) }))).toBe(true);
  });

  it("runs after a reader failure", () => {
    expect(
      needsVisionPass(fullSet({ sheets: fact("sheets", [], 0, "docs", { readError: "truncated" }) }))
    ).toBe(true);
  });
});

describe("mergePlanFactSets", () => {
  it("takes the only pass that read a value", () => {
    const doc = fullSet({ height: fact("height", null, 0) });
    const vis = fullSet({ height: fact("height", 19, 0.8) });
    const merged = mergePlanFactSets(doc, vis);
    expect(merged.find((f) => f.key === "height")).toMatchObject({ value: 19, confidence: 0.8 });
  });

  it("boosts confidence when two independent reads agree", () => {
    const doc = fullSet({ height: fact("height", 19, 0.8) });
    const vis = fullSet({ height: fact("height", 19.0, 0.85) });
    const merged = mergePlanFactSets(doc, vis);
    expect(merged.find((f) => f.key === "height")?.confidence).toBeCloseTo(0.9);
  });

  it("caps confidence below the review threshold when reads contradict", () => {
    const doc = fullSet({ unitSize: fact("unitSize", 361, 0.9, "sqft") });
    const vis = fullSet({ unitSize: fact("unitSize", 500, 0.8, "sqft") });
    const merged = mergePlanFactSets(doc, vis);
    const m = merged.find((f) => f.key === "unitSize");
    expect(m?.value).toBe(361); // higher-confidence read wins…
    expect(m?.confidence).toBeLessThanOrEqual(0.6); // …but is routed to review
    expect(m?.raw).toContain("two-pass cross-check");
  });

  it("keeps the null fact when neither pass read the value", () => {
    const doc = fullSet({ height: fact("height", null, 0) });
    const vis = fullSet({ height: fact("height", null, 0) });
    expect(mergePlanFactSets(doc, vis).find((f) => f.key === "height")?.value).toBeNull();
  });

  it("prefers the document pass's real sheet names over synthetic page labels", () => {
    const doc = fullSet({ sheets: fact("sheets", ["A1.0", "A2.0"], 0.9, "docs") });
    const vis = fullSet({ sheets: fact("sheets", ["page 1", "page 2"], 0.95, "docs") });
    const merged = mergePlanFactSets(doc, vis);
    expect(merged.find((f) => f.key === "sheets")?.value).toEqual(["A1.0", "A2.0"]);
  });

  it("falls back to the vision pass's page labels when the doc pass has none", () => {
    const doc = fullSet({ sheets: fact("sheets", [], 0, "docs", { readError: "truncated" }) });
    const vis = fullSet({ sheets: fact("sheets", ["page 1"], 0.95, "docs") });
    const merged = mergePlanFactSets(doc, vis).find((f) => f.key === "sheets");
    expect(merged?.value).toEqual(["page 1"]);
    expect(merged?.readError).toBeUndefined();
  });

  it("keeps the reader error when BOTH passes failed", () => {
    const doc = fullSet({ sheets: fact("sheets", [], 0, "docs", { readError: "API error" }) });
    const vis = fullSet({
      sheets: fact("sheets", ["page 1", "page 2"], 0.95, "docs", { readError: "API error" }),
    });
    const merged = mergePlanFactSets(doc, vis).find((f) => f.key === "sheets");
    expect(merged?.readError).toBe("API error");
  });
});
