// Band adapter (PLAN.md §5 Band). Band (band.ai) is the multi-agent message bus
// behind the Activity Feed. Messages ALWAYS flow through the local emitter the
// SSE stream reads — that is the feed the demo shows, and it is fully working.
//
// On top of that, when an orchestrator agent key is configured, a run now opens
// a REAL Band collaboration room (ported from the working firstpass research
// repo): validate the agent (/me), create a chat, add the human owner + the
// three registered research agents, and post a kickoff message that @mentions
// them. Meaningful collaboration moments (disagreement / retry / done) are then
// forwarded into that room. All of it is best-effort and never blocks a run.
//
// Backward compatible: if no room is opened but BAND_CHAT_ID + BAND_MENTION_ID
// are set, forwarding falls back to that single hand-configured chat.
import type { AgentMessage, MessageType, Project } from "../types";
import { BandClient, bandAgents, type BandMention } from "./band-client";

export const BAND_LIVE = !!process.env.BAND_API_KEY;
// Legacy single-room forward path (pre-room behavior), kept as a fallback.
const BAND_FORWARD_LEGACY =
  BAND_LIVE && !!process.env.BAND_CHAT_ID && !!process.env.BAND_MENTION_ID;
const FORWARD_TYPES: MessageType[] = ["disagreement", "retry", "done"];

type Sink = (m: AgentMessage) => void;

interface LiveRoom {
  client: BandClient;
  chatId: string;
  mentions: BandMention[];
}

// Build the kickoff message that seeds the room. Mirrors the Python
// orchestrator's build_kickoff_message, adapted to ADU compliance research.
function kickoffMessage(project?: Project): string {
  const address = project?.address || "the project address";
  const type = (project?.projectType || "detached_adu").replace(/_/g, " ");
  return [
    `FirstPass code-research kickoff — ${type} at ${address}.`,
    "",
    "@Municipal Code Researcher — find municipal/zoning ADU code (size, height, setbacks, required docs) for this jurisdiction. Cite section + source URL.",
    "@State Code Researcher — find the governing state ADU code and any ceiling/floor that overrides local limits. Cite section + source URL.",
    "@Code Synthesizer — once both researchers finish, merge the excerpts into a single set of applicable rules with citations and post the summary here.",
  ].join("\n");
}

// A Band "channel" scoped to one project run. The orchestrator publishes; the
// SSE route subscribes. Forwarding to Band is best-effort and never blocks.
export class BandChannel {
  private sinks: Sink[] = [];
  private room: LiveRoom | null = null;
  readonly buffer: AgentMessage[] = [];

  constructor(public readonly projectId: string) {}

  // Open a channel and, when Band is configured, bootstrap a real room. Always
  // resolves to a usable channel — room creation failures are swallowed so the
  // local feed (and the demo) keep working.
  static async open(projectId: string, project?: Project): Promise<BandChannel> {
    const ch = new BandChannel(projectId);
    await ch.bootstrapRoom(project);
    return ch;
  }

  // The id of the real Band room created for this run, if any.
  get roomId(): string | null {
    return this.room?.chatId ?? null;
  }

  private async bootstrapRoom(project?: Project): Promise<void> {
    const key = process.env.BAND_API_KEY;
    if (!key) return; // no agent key → local feed only (demo default)
    try {
      const client = new BandClient(key);
      await client.me(); // validate the orchestrator connection
      const chat = await client.createChat(this.projectId);
      const chatId = chat.id;
      if (!chatId) return;
      await client.addOwner(chatId).catch(() => null); // human joins (best-effort)
      const mentions = bandAgents();
      for (const a of mentions) {
        await client.addParticipant(chatId, a.id).catch(() => null);
      }
      await client
        .sendMessage(chatId, kickoffMessage(project), mentions)
        .catch(() => null);
      this.room = { client, chatId, mentions };
    } catch {
      /* best-effort — local feed remains the source of truth */
    }
  }

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
    const shouldForward =
      (this.room || BAND_FORWARD_LEGACY) && FORWARD_TYPES.includes(m.type);
    if (shouldForward) void this.forward(m);
  }

  // Forward a meaningful message onto the Band room. Prefers the live room
  // created for this run; otherwise falls back to the legacy env-configured
  // chat. Best-effort — failures are swallowed.
  private async forward(m: AgentMessage): Promise<void> {
    const text = `[FirstPass · ${m.from}${m.to ? " → " + m.to : ""}] ${m.text}`;
    try {
      if (this.room) {
        const tag = this.room.mentions.map((x) => `@${x.name}`).join(" ");
        await this.room.client.sendMessage(
          this.room.chatId,
          `${tag}\n${text}`,
          this.room.mentions
        );
        return;
      }
      // Legacy single-mention path (BAND_CHAT_ID + BAND_MENTION_ID).
      const name = process.env.BAND_MENTION_NAME || "team";
      const handle = process.env.BAND_MENTION_HANDLE || name;
      const restBase = (
        process.env.BAND_REST_URL || "https://app.band.ai/api/v1/agent"
      ).replace(/\/+$/, "");
      await fetch(
        `${restBase}/chats/${process.env.BAND_CHAT_ID}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": process.env.BAND_API_KEY!,
          },
          body: JSON.stringify({
            message: {
              content: `@${name} ${text}`,
              mentions: [{ id: process.env.BAND_MENTION_ID, name, handle }],
            },
          }),
        }
      );
    } catch {
      /* best-effort — the local feed is the source of truth for the demo */
    }
  }
}
