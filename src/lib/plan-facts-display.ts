import type { PlanFact } from "./types";

/** ADU runs only need size/height/setbacks — hide empty SFH metrics from the UI. */
export function factsForDisplay(facts: PlanFact[], projectType: string): PlanFact[] {
  const isAdu = projectType === "detached_adu" || projectType === "attached_adu";
  const aduKeys = new Set(["unitSize", "height", "setbackSide", "setbackRear", "sheets"]);
  return facts.filter((f) => {
    if (f.key === "sheets") return false;
    if (f.value == null) return false;
    if (isAdu && !aduKeys.has(f.key)) return false;
    return true;
  });
}
