import { describe, expect, it } from "vitest";
import { drawingFindings, parseObservations } from "../drawing-review";

const obs = (check: string, location: string, value: number, unit: string, raw: string) => ({
  check, location, value, unit, raw, sheet: "A2.0", confidence: 0.9, tile: "", bbox: [0, 0, 0, 0],
});

describe("drawing review", () => {
  const facts = parseObservations({
    observations: [
      obs("egressSillHeight", "Bedroom 1", 48, "in", 'SILL HT 48"'),
      obs("egressSillHeight", "Bedroom 2", 40, "in", 'SILL HT 40"'),
      obs("ceilingHeight", "Living", 8, "ft", "CLG HT 8'-0\""),
      obs("egressOpeningArea", "Bedroom 1", 5.2, "sqft", "NCO 5.2 SF"),
      obs("smokeAlarm", "Bedroom 2", 0, "count", "no SD symbol"),
      obs("stairRiser", "Stair", 0.65, "ft", "RISER 7.8\""),
      obs("notACheck", "X", 1, "in", ""),
    ],
  });
  const byId = Object.fromEntries(drawingFindings(facts, "alameda-ca").map((f) => [f.id, f]));

  it("fails a sill over 44in and names the room", () => {
    const f = byId.f_drawing_egressSillHeight;
    expect(f.status).toBe("FAIL");
    expect(f.message).toContain("Bedroom 1");
    expect(f.codeSection).toContain("R319.2.3");
    expect(f.codeText).toContain("44 inches");
  });

  it("passes a compliant ceiling", () => expect(byId.f_drawing_ceilingHeight.status).toBe("PASS"));

  it("routes grade-floor-range escape openings and missing alarms to review, not FAIL", () => {
    expect(byId.f_drawing_egressOpeningArea.status).toBe("NEEDS_REVIEW");
    expect(byId.f_drawing_smokeAlarm.status).toBe("NEEDS_REVIEW");
  });

  it("converts units before comparing (0.65ft riser = 7.8in > 7.75in)", () =>
    expect(byId.f_drawing_stairRiser.status).toBe("FAIL"));

  it("skips CRC checks for commercial projects", () =>
    expect(drawingFindings(facts, "alameda-ca", "commercial")).toEqual([]));

  it("bounds a slider's clear opening by its unit size and fails a 4x2 slider", () => {
    const n = (check: string, value: number, extra: object) => ({ ...obs(check, "Bedroom", value, "in", "B: 4'-0\" x 2'-0\" SLIDING"), ...extra });
    const f = Object.fromEntries(
      drawingFindings(
        parseObservations({
          observations: [
            n("egressOpeningWidth", 48, { basis: "nominal", operation: "sliding" }),
            n("egressOpeningHeight", 24, { basis: "nominal", operation: "sliding" }),
            { ...obs("egressSillHeight", "Bedroom", 44, "in", '44" MAX'), basis: "note" },
            { ...obs("egressDoorWidth", "Entry", 36, "in", "3'-0\" x 6'-8\""), basis: "nominal" },
          ],
        }),
        "alameda-ca"
      ).map((x) => [x.id, x])
    );
    expect(f.f_drawing_egressOpeningArea.status).toBe("FAIL"); // 24" x 24" = 4 sqft < 5.0
    expect(f.f_drawing_egressOpeningWidth.status).toBe("NEEDS_REVIEW"); // 24" bound passes, not proof
    expect(f.f_drawing_egressSillHeight.status).toBe("NEEDS_REVIEW"); // a note, not a dimension
    expect(f.f_drawing_egressDoorWidth.status).toBe("PASS"); // 36" leaf -> ~33.5" clear
  });

  it("drops unknown checks and emits nothing for unobserved ones", () => {
    expect(facts.some((f) => f.key.includes("notACheck"))).toBe(false);
    expect(byId.f_drawing_hallwayWidth).toBeUndefined();
  });
});
