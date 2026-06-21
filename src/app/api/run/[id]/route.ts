import { NextRequest } from "next/server";
import { kvGet } from "@/lib/store";
import { runPipeline } from "@/lib/pipeline";
import { BandChannel } from "@/lib/integrations/band";
import type { Project } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// This single route drives the whole orchestration (Claude + Browserbase + APS
// translate + Design Automation). A DWG run polls Design Automation for up to
// ~240s before tiling/vision, so the default cap would kill it mid-run. 300s is
// the value supported on every Vercel plan; on Fluid Compute (Pro) this can be
// raised toward 800s, and heavy DWG sets ultimately want a durable background
// job rather than a single long request.
export const maxDuration = 300;

// SSE stream: runs the orchestrator and emits a full ProjectState snapshot on
// every step. The dashboard subscribes to this and re-renders live.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await kvGet<Project>(`proj:${id}`);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      // Enqueue is a no-op once the client has disconnected (and never throws),
      // so an orphaned connection — e.g. React Strict Mode's first, immediately
      // closed EventSource in dev — can't crash the run.
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      };
      // Stop promptly when the browser drops the connection.
      req.signal.addEventListener("abort", () => {
        closed = true;
      });
      if (!project) {
        send("error", { message: "Project not found" });
        controller.close();
        return;
      }

      // Open a Band channel. This is NON-BLOCKING — the real room (validate →
      // create chat → add agents → kickoff @mentions) bootstraps in the
      // background so a slow/throttled Band never stalls the run. The local feed
      // streams immediately; the room/transcript fill in when ready.
      const channel = BandChannel.open(id, project);
      // Announce the room id as soon as bootstrap finishes (success or not).
      void channel.ready.then(() => {
        if (!closed && channel.roomId) send("band", { roomId: channel.roomId });
      });

      // Poll the room transcript and stream the actual agent-to-agent
      // conversation as `band-room` events — the live view used to double-check
      // what the agents are really saying. Each poll unions several mention-
      // scoped agent views, so we poll gently (6s) to stay under Band's rate
      // limit, and only emit when the transcript changes. roomTranscript() never
      // throws, so this can't break a run.
      let lastSig = "";
      const pollRoom = async () => {
        if (closed || !channel.roomId) return;
        const msgs = await channel.roomTranscript();
        const sig = `${msgs.length}:${msgs[msgs.length - 1]?.id ?? ""}`;
        if (sig !== lastSig) {
          lastSig = sig;
          if (!closed) send("band-room", { messages: msgs });
        }
      };
      const roomTimer = setInterval(() => void pollRoom(), 6000);

      try {
        for await (const state of runPipeline(project, channel)) {
          if (closed) return; // client gone — stop the orphaned run
          send("state", state);
        }
        // The deterministic pipeline is done, but the Band agents may still be
        // posting. Give the room a grace window so the final replies land in the
        // transcript before we close the stream.
        for (let i = 0; i < 5 && channel.roomId; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          await pollRoom();
        }
        send("complete", { ok: true });
      } catch (err) {
        send("error", { message: (err as Error).message });
      } finally {
        closed = true;
        clearInterval(roomTimer);
        try {
          controller.close();
        } catch {
          /* already closed by client disconnect */
        }
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
