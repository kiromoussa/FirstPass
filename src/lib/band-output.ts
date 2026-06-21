import fs from "fs/promises";
import path from "path";

export const OUTPUT_DIR = path.join(process.cwd(), "output");

export async function outputFresh(filename: string, sinceMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(OUTPUT_DIR, filename));
    return stat.mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

// Every per-run deliverable the workflow phases key off. Global on disk (the
// Python agents hardcode output/), so a new run can falsely "see" a previous
// run's files and skip the live agent work. clearStaleDeliverables removes the
// leftovers from PRIOR runs at run start.
const RUN_DELIVERABLES = [
  "planner_brief.txt",
  "municipal_codes.txt",
  "municipal_requirements.json",
  "state_codes.txt",
  "state_requirements.json",
  "final_summary.txt",
  "plan_facts.txt",
  "plan_vs_code.txt",
  "solutions_report.txt",
  "permit_report.txt",
  "compliance_report.json",
];

/**
 * Delete deliverable files left over from PRIOR runs (mtime < runStartedMs) so
 * outputFresh() reflects only THIS run. Files this run already produced
 * (mtime >= runStartedMs) are preserved, so an SSE reconnect can't wipe progress.
 */
export async function clearStaleDeliverables(runStartedMs: number): Promise<void> {
  await Promise.all(
    RUN_DELIVERABLES.map(async (f) => {
      const p = path.join(OUTPUT_DIR, f);
      try {
        const st = await fs.stat(p);
        if (st.mtimeMs < runStartedMs) await fs.rm(p, { force: true });
      } catch {
        /* missing → nothing to clear */
      }
    })
  );
}
