// Persist extracted plan facts so the same APS URN / project doesn't re-run vision.
import type { PlanFact, Project } from "./types";
import { kvGet, kvSet } from "./store";
import { getCachedPlanFacts } from "./plan-facts-cache";
import { decodeUrn } from "./integrations/aps";

const projectKey = (id: string) => `planfacts:${id}`;

function urnKey(urn: string): string | null {
  const decoded = decodeUrn(urn);
  const id = decoded?.key ?? urn;
  return `planfacts:urn:${id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160)}`;
}

export async function persistPlanFacts(project: Project, facts: PlanFact[]): Promise<void> {
  const hasValues = facts.some((f) => f.key !== "sheets" && f.value != null);
  if (!hasValues) return;
  await kvSet(projectKey(project.id), facts);
  if (project.apsUrn) {
    const uk = urnKey(project.apsUrn);
    if (uk) await kvSet(uk, facts);
  }
}

export async function loadPersistedPlanFacts(project: Project): Promise<PlanFact[] | null> {
  if (project.apsUrn) {
    const uk = urnKey(project.apsUrn);
    if (uk) {
      const byUrn = await kvGet<PlanFact[]>(uk);
      if (byUrn?.some((f) => f.key !== "sheets" && f.value != null)) return byUrn;
    }
  }
  const byProject = await kvGet<PlanFact[]>(projectKey(project.id));
  if (byProject?.some((f) => f.key !== "sheets" && f.value != null)) return byProject;
  return null;
}

export async function resolvePlanFacts(
  project: Project,
  facts: PlanFact[],
  extractedFacts: boolean
): Promise<{ facts: PlanFact[]; extractedFacts: boolean; source?: string }> {
  const hasValues = facts.some((f) => f.key !== "sheets" && f.value != null);
  if (hasValues) {
    await persistPlanFacts(project, facts);
    return { facts, extractedFacts: true };
  }

  const persisted = await loadPersistedPlanFacts(project);
  if (persisted) return { facts: persisted, extractedFacts: true, source: "persisted" };

  const cached = getCachedPlanFacts(project);
  if (cached) return { facts: cached, extractedFacts: true, source: "validated" };

  return { facts, extractedFacts: false };
}
