import { describe, expect, it } from "vitest";
import { buildEnergyComplianceFinding, docTypesFromFacts } from "../corpus-compliance";
import type { PlanFact, Project } from "../types";

const project = (slug: string): Project =>
  ({ id: "t", name: "ADU", projectType: "detached_adu", citySlug: slug } as unknown as Project);

const facts: PlanFact[] = [
  { key: "unitSize", label: "Conditioned floor area", value: 800, unit: "sqft", sheet: "A1.0", bbox: null, confidence: 0.9 },
  { key: "sheets", label: "Sheets present", value: ["A1.0"], unit: "docs", sheet: "—", bbox: null, confidence: 0.95 },
];

describe("buildEnergyComplianceFinding", () => {
  it("cites a residential Title 24 Part 6 section, never the school-buildings table", async () => {
    const f = await buildEnergyComplianceFinding(project("los-angeles-ca"), facts, "los-angeles-ca", ["energy_title24"]);
    expect(f.id).toBe("f_energyTitle24");
    expect(f.status).toBe("NEEDS_REVIEW");
    // A real low-rise residential section number (150.x or 110.x), not a school table.
    expect(f.codeSection).toMatch(/\b1(?:50|10)\.\d/);
    expect(f.codeSection?.toLowerCase()).not.toContain("school");
    expect((f.codeText ?? "").length).toBeGreaterThan(50);
  });

  it("reports energy docs present when the vision classifier detected them", async () => {
    const f = await buildEnergyComplianceFinding(project("alameda-ca"), facts, "alameda-ca", ["energy_title24"]);
    expect(f.message.toLowerCase()).toContain("detected in the set");
  });

  it("reports energy docs missing when no CF1R / energy notes were found", async () => {
    const f = await buildEnergyComplianceFinding(project("alameda-ca"), facts, "alameda-ca", ["site_plan"]);
    expect(f.message.toLowerCase()).toContain("no cf1r");
  });

  it("detects energy docs from sheet text even without a docType", async () => {
    const withEnergySheet: PlanFact[] = [
      ...facts,
      { key: "unitSize", label: "note", value: "T-24 ENERGY COMPLIANCE CF1R", unit: "sqft", sheet: "T1.0", bbox: null, confidence: 0.5, raw: "T-24 ENERGY COMPLIANCE CF1R" },
    ];
    const f = await buildEnergyComplianceFinding(project("santa-ana-ca"), withEnergySheet, "santa-ana-ca", []);
    expect(f.message.toLowerCase()).toContain("detected in the set");
  });

  it("docTypesFromFacts reads an embedded docTypes fact", () => {
    const withDocTypes: PlanFact[] = [
      ...facts,
      { key: "docTypes", label: "Document types", value: ["site_plan", "energy_title24"], unit: "docs", sheet: "—", bbox: null, confidence: 0.9 },
    ];
    expect(docTypesFromFacts(withDocTypes)).toEqual(["site_plan", "energy_title24"]);
    expect(docTypesFromFacts(facts)).toEqual([]);
  });
});
