import { NextRequest, NextResponse } from "next/server";
import { resolveProjectForCompare } from "@/lib/project-persistence";
import {
  projectHasPlanInput,
  runPlanComplianceAgent,
} from "@/lib/plan-compliance-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// DWG plot + vision can take several minutes — match /api/run/[id].
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { projectId?: string };
  const project = await resolveProjectForCompare(body.projectId);
  if (!project) {
    return NextResponse.json(
      { ok: false, error: "No active project — start a run from the FirstPass UI first." },
      { status: 404 }
    );
  }

  if (!projectHasPlanInput(project)) {
    return NextResponse.json({
      ok: false,
      error: "No plan on file — upload a PDF or DWG when creating the project.",
      projectId: project.id,
    });
  }

  const result = await runPlanComplianceAgent(project);
  const failCount = result.findings.filter((f) => f.status === "FAIL").length;
  const reviewCount = result.findings.filter((f) => f.status === "NEEDS_REVIEW").length;
  const passCount = result.findings.filter((f) => f.status === "PASS").length;

  const summary = result.ok
    ? `Compare Codes finished for ${project.address}. ` +
      `${failCount} likely violation(s), ${reviewCount} need review, ${passCount} pass. ` +
      `Wrote output/plan_facts.txt and output/plan_vs_code.txt.`
    : `Compare Codes failed: ${result.error ?? "unknown error"}`;

  return NextResponse.json({
    ok: result.ok,
    summary,
    projectId: project.id,
    failCount,
    reviewCount,
    passCount,
    planFactsPath: result.planFactsPath,
    planVsCodePath: result.planVsCodePath,
    error: result.error,
  });
}
