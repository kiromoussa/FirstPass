import { describe, expect, it } from "vitest";
import { deriveChecklist } from "../fixtures";
import type { PlanFact } from "../types";

const sheetsFact = (names: string[]): PlanFact => ({
  key: "sheets",
  label: "Sheets present",
  value: names,
  unit: "docs",
  sheet: "—",
  bbox: null,
  confidence: 0.95,
});

describe("deriveChecklist", () => {
  it("marks documents present from detected content, not layout names", () => {
    // Real DWG layouts are named like SP-1/A1.0 — no keyword ever matches.
    const facts = [sheetsFact(["SP-1", "Model"])];
    const withoutTypes = deriveChecklist(facts);
    expect(withoutTypes.every((c) => c.present === false)).toBe(true);

    const withTypes = deriveChecklist(facts, [
      "site_plan",
      "floor_plan",
      "elevation",
      "energy_title24",
    ]);
    expect(withTypes.every((c) => c.present === true)).toBe(true);
  });

  it("reads docTypes embedded as a fact", () => {
    const facts: PlanFact[] = [
      sheetsFact(["A1.0"]),
      {
        key: "docTypes",
        label: "Document types",
        value: ["site_plan"],
        unit: "docs",
        sheet: "—",
        bbox: null,
        confidence: 0.9,
      },
    ];
    const checklist = deriveChecklist(facts);
    expect(checklist.find((c) => c.item === "Site plan")?.present).toBe(true);
    expect(checklist.find((c) => c.item === "Floor plan")?.present).toBe(false);
  });

  it("keeps the sheet-name keyword fallback", () => {
    const checklist = deriveChecklist([sheetsFact(["Site Plan", "Floor Plan", "Elevations", "Title-24 Report"])]);
    expect(checklist.every((c) => c.present === true)).toBe(true);
  });
});
