import { NextRequest } from "next/server";
import { kvGet } from "@/lib/store";
import { runPipeline } from "@/lib/pipeline";
import { BandChannel } from "@/lib/integrations/band";
import type { Project } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SSE stream: runs the orchestrator and emits a full ProjectState snapshot on
// every step. The dashboard subscribes to this and re-renders live.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await kvGet<Project>(`proj:${id}`);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };
      if (!project) {
        send("error", { message: "Project not found" });
        controller.close();
        return;
      }
      const channel = new BandChannel(id);
      try {
        for await (const state of runPipeline(project, channel)) {
          send("state", state);
        }
        send("complete", { ok: true });
      } catch (err) {
        send("error", { message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
