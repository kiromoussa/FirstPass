// Regression test for the Oak St. incident (2026-07-23): a user project with
// NO plan attached (no planMime, no apsUrn) must never be graded against the
// curated demo reference facts. Every applicable dimensional rule must surface
// as NEEDS_REVIEW that says no plan is attached — no fabricated FAIL/PASS.
import { describe, it, expect } from "vitest";
import { runPipeline } from "../pipeline";
import { BandChannel } from "../integrations/band";
import type { Project, ProjectState } from "../types";

const NO_PLAN_PROJECT: Project = {
  id: "test-no-plan",
  ownerId: "user_test",
  name: "No Plan Attached",
  address: "1216 E 92nd St, Los Angeles, CA 90002",
  projectType: "single_family",
  jurisdictionId: "los-angeles-ca",
  citySlug: "los-angeles-ca",
  status: "created",
  createdAt: 0,
};

describe("runPipeline with no plan attached", () => {
  it("grades nothing as measured and flags every dimensional check for review", async () => {
    const channel = BandChannel.open(NO_PLAN_PROJECT.id, NO_PLAN_PROJECT);
    let last: ProjectState | undefined;
    for await (const state of runPipeline(NO_PLAN_PROJECT, channel)) {
      last = state;
    }
    expect(last).toBeDefined();
    const findings = last!.findings;

    // No fact may carry a value — the demo reference numbers (1180 sqft,
    // 18 ft, 4 ft, 3 ft on sheets A-1/A-2/A-3) must not leak in.
    for (const f of last!.facts.filter((f) => f.key !== "sheets")) {
      expect(f.value, `fact ${f.key} must be null`).toBeNull();
      expect(f.confidence).toBe(0);
    }

    // Every numeric single_family rule for LA must produce a finding
    // (the old loop silently skipped rules with no extracted fact).
    const numeric = [
      "height",
      "setbackFront",
      "setbackRear",
      "setbackSide",
      "lotCoverage",
      "far",
      "parking",
    ];
    for (const key of numeric) {
      const f = findings.find((x) => x.ruleKey === key);
      expect(f, `finding for ${key} must exist`).toBeDefined();
      expect(f!.status, `${key} must be NEEDS_REVIEW, got ${f!.status}`).toBe("NEEDS_REVIEW");
      expect(f!.message).toMatch(/no plan set is attached/i);
    }

    // No dimensional FAIL or PASS can exist when nothing was measured.
    const dimensional = findings.filter((f) => numeric.includes(f.ruleKey));
    expect(dimensional.some((f) => f.status === "FAIL" || f.status === "PASS")).toBe(false);
  }, 120_000);
});
