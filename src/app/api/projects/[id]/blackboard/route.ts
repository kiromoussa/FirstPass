import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { hgetAll, getRaw } from "@/lib/store";
import { loadProject } from "@/lib/project-persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The multi-agent blackboard (docs/REDIS_PLAN.md §3.1). The Python Band agents
// publish each research artifact to the Redis HASH project:{id}:blackboard via
// src/firstpass/redis_store.py; this route exposes it to the dashboard so the
// firm's shared memory is visible — not just files on the research box.
//
// Each artifact has a companion "{field}_at" ISO timestamp written alongside it.
// We split those out into a structured list the UI can render.

interface Artifact {
  field: string;
  text: string;
  at: string | null;
  chars: number;
}

function shape(hash: Record<string, string>): Artifact[] {
  return Object.keys(hash)
    .filter((k) => !k.endsWith("_at"))
    .map((field) => ({
      field,
      text: hash[field],
      at: hash[`${field}_at`] ?? null,
      chars: hash[field]?.length ?? 0,
    }))
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await loadProject(id);
  if (!project || project.ownerId !== userId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let hash = await hgetAll(`project:${id}:blackboard`);
  let source = id;

  // The Band run binds to a project via Redis `project:active` (orchestrator
  // --project-id). If this specific id has no artifacts yet but a run is active
  // under a different id, fall back to it so the demo still surfaces the board.
  if (Object.keys(hash).length === 0) {
    const active = await getRaw("project:active");
    if (active && active !== id) {
      const activeHash = await hgetAll(`project:${active}:blackboard`);
      if (Object.keys(activeHash).length > 0) {
        hash = activeHash;
        source = active;
      }
    }
  }

  const artifacts = shape(hash);
  return NextResponse.json({
    projectId: id,
    source, // which project id the artifacts actually came from
    count: artifacts.length,
    artifacts,
  });
}
