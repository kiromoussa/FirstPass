// Band adapter (PLAN.md §5 Band). Band (band.ai) is the multi-agent message bus
// behind the Activity Feed. Messages ALWAYS flow through the local emitter the
// SSE stream reads — that is the feed the demo shows, and it is fully working.
//
// Forwarding onto a Band chat room uses the Agent REST API:
//   POST https://app.band.ai/api/v1/agent/chats/{chatId}/messages
//   header  X-API-Key: <agent key band_a_...>
//   body    { message: { content: "@Name ...", mentions: [{ id, name, handle }] } }
// A message must @mention an existing room participant, so forwarding is gated on
// BAND_CHAT_ID + BAND_MENTION_ID. We forward only the meaningful collaboration
// moments (disagreement / retry / done) so the room isn't spammed. Without those
// IDs, forwarding is skipped (never an error). See docs.band.ai/api/agent-api.
import type { AgentMessage, MessageType } from "../types";

export const BAND_LIVE = !!process.env.BAND_API_KEY;
const BAND_FORWARD =
  BAND_LIVE && !!process.env.BAND_CHAT_ID && !!process.env.BAND_MENTION_ID;
const FORWARD_TYPES: MessageType[] = ["disagreement", "retry", "done"];

type Sink = (m: AgentMessage) => void;

// A Band "channel" scoped to one project run. The orchestrator publishes; the
// SSE route subscribes. Forwarding to Band is best-effort and never blocks.
export class BandChannel {
  private sinks: Sink[] = [];
  readonly buffer: AgentMessage[] = [];

  constructor(public readonly projectId: string) {}

  subscribe(sink: Sink): () => void {
    this.sinks.push(sink);
    return () => {
      this.sinks = this.sinks.filter((s) => s !== sink);
    };
  }

  publish(m: AgentMessage): void {
    this.buffer.push(m);
    for (const s of this.sinks) {
      try {
        s(m);
      } catch {
        /* a dead subscriber must not break the run */
      }
    }
    if (BAND_FORWARD && FORWARD_TYPES.includes(m.type)) void this.forward(m);
  }

  // Forward a meaningful message onto a Band chat room via the Agent REST API.
  // Gated on BAND_CHAT_ID + BAND_MENTION_* (see header note). Best-effort.
  private async forward(m: AgentMessage): Promise<void> {
    try {
      const name = process.env.BAND_MENTION_NAME || "team";
      const handle = process.env.BAND_MENTION_HANDLE || name;
      await fetch(
        `https://app.band.ai/api/v1/agent/chats/${process.env.BAND_CHAT_ID}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": process.env.BAND_API_KEY!,
          },
          body: JSON.stringify({
            message: {
              content: `@${name} [FirstPass · ${m.from}${m.to ? " → " + m.to : ""}] ${m.text}`,
              mentions: [
                { id: process.env.BAND_MENTION_ID, name, handle },
              ],
            },
          }),
        }
      );
    } catch {
      /* best-effort — the local feed is the source of truth for the demo */
    }
  }
}
