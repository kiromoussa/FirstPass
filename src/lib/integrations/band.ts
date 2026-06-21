// Band adapter (PLAN.md §5 Band). Band (band.ai) is the multi-agent message bus
// behind the Activity Feed. Messages ALWAYS flow through the local emitter the
// SSE stream reads — that is the feed the demo shows, and it is fully working.
//
// On top of that, when an orchestrator agent key is configured, a run now opens
// a REAL Band collaboration room (ported from the working firstpass research
// repo): validate the agent (/me), create a chat, add the human owner + the full
// FirstPass agent team (CEO, Planner, Code Synthesizer, Municipal + State
// researchers, Visual Analysis, Compare Codes, Solutions, Permit Report — see
// BAND_AGENTS.md / band-client.ts), and post a kickoff message that lays out the
// CEO-orchestrated workflow and @mentions them. Meaningful collaboration moments
// (disagreement / retry / done) are then forwarded into that room. All of it is
// best-effort and never blocks a run.
//
// Backward compatible: if no room is opened but BAND_CHAT_ID + BAND_MENTION_ID
// are set, forwarding falls back to that single hand-configured chat.
import type {
  AgentMessage,
  BandRoomMessage,
  MessageType,
  Project,
} from "../types";
import {
  BandClient,
  bandAgents,
  bandViewerKeys,
  type BandAgentDef,
  type BandMention,
  type RawBandMessage,
} from "./band-client";

export const BAND_LIVE = !!process.env.BAND_API_KEY;
// Legacy single-room forward path (pre-room behavior), kept as a fallback.
const BAND_FORWARD_LEGACY =
  BAND_LIVE && !!process.env.BAND_CHAT_ID && !!process.env.BAND_MENTION_ID;
const FORWARD_TYPES: MessageType[] = ["disagreement", "retry", "done"];

type Sink = (m: AgentMessage) => void;

interface LiveRoom {
  client: BandClient; // orchestrator — used to send
  viewers: BandClient[]; // one per agent key — used to read (mention-scoped)
  chatId: string;
  roster: BandAgentDef[]; // full configured roster, for name resolution
  mentions: BandMention[]; // delivery mentions (orchestrator excluded)
  ownerId: string | null; // the human account in the room
  selfId: string | null; // the orchestrator agent (FirstPass) itself
}

// Build the kickoff message that seeds the room. Encodes the FirstPass agentic
// workflow (BAND_AGENTS.md) as a numbered chain the CEO orchestrates:
//   CEO → Planner → Code Synthesizer → Municipal + State → Code Synthesizer
//       → Visual Analysis + Compare Codes → Solutions → Permit Report → CEO
// The CEO + Planner are the entry points; the message @mentions every configured
// agent so each step resolves to a real participant. Steps whose agent isn't
// configured (no resolved id → skipped from the roster) drop out automatically.
function kickoffMessage(project: Project | undefined, agents: BandAgentDef[]): string {
  const address = project?.address || "the project address";
  const type = (project?.projectType || "detached_adu").replace(/_/g, " ");
  const byRole = (r: BandAgentDef["role"]) => agents.find((a) => a.role === r);
  const ceo = byRole("ceo");
  const planner = byRole("planner");
  const synth = byRole("synthesizer");
  const researchers = agents.filter((a) => a.role === "researcher");
  const visual = byRole("visual");
  const compare = byRole("comparator");
  const solutions = byRole("solutions");
  const permit = byRole("permit");

  // Build the numbered workflow, skipping any step whose agent is unconfigured.
  const steps: string[] = [];
  const add = (who: BandAgentDef | undefined, what: string) => {
    if (who) steps.push(`${steps.length + 1}. @${who.name} — ${what}`);
  };
  const addMany = (who: BandAgentDef[], what: string) => {
    if (who.length) steps.push(`${steps.length + 1}. ${who.map((a) => `@${a.name}`).join(" + ")} — ${what}`);
  };
  add(planner, `${planner?.ask}. Write \`output/${planner?.report}\` and hand it to the synthesizer.`);
  add(synth, "From the brief, list the code questions to research, then hand off to the researchers.");
  addMany(
    researchers,
    "Research the applicable codes from Internet Archive (archive.org) — not paywalled ICC sites. " +
      researchers.map((a) => `${a.name.replace(/ Code Researcher$/, "")}: ${a.ask}`).join("; ") +
      `. Each writes its \`output/*.txt\` report.`
  );
  if (synth) steps.push(`${steps.length + 1}. @${synth.name} — Merge every researcher report into \`output/${synth.report}\` (the governing code set).`);
  addMany(
    [visual, compare].filter(Boolean) as BandAgentDef[],
    `Read the plan set, then ${compare?.ask ?? "flag where the design violates the governing codes, with citations"}.`
  );
  add(solutions, `${solutions?.ask}. Write \`output/${solutions?.report}\`.`);
  add(permit, `${permit?.ask}. Write \`output/${permit?.report}\` and post it in chat.`);
  add(ceo, "Review the report, confirm every finding is cited, and deliver the final permit-readiness sign-off.");

  const lead = [ceo, planner].filter(Boolean).map((a) => `@${a!.name}`).join(" ");
  const deliverables = agents.map((a) => a.report).filter(Boolean).join(", ");

  return `${lead}

New pre-submission permit review — run the standard FirstPass workflow. The CEO owns orchestration and the final sign-off.

**Address:** ${address}
**Project type:** ${type}

Workflow:

${steps.join("\n")}

Post progress in chat as each step completes. Deliverables: ${deliverables}.`;
}

// A Band "channel" scoped to one project run. The orchestrator publishes; the
// SSE route subscribes. Forwarding to Band is best-effort and never blocks.
export class BandChannel {
  private sinks: Sink[] = [];
  private room: LiveRoom | null = null;
  readonly buffer: AgentMessage[] = [];
  // Resolves once room bootstrap finishes (success OR failure). The run never
  // awaits this before streaming — Band is best-effort and must not block.
  readonly ready: Promise<void>;

  constructor(public readonly projectId: string, project?: Project) {
    this.ready = this.bootstrapRoom(project).catch(() => undefined);
  }

  // Open a channel. Returns immediately; room bootstrap runs in the background
  // (await `channel.ready` only if you specifically need the room to exist).
  static open(projectId: string, project?: Project): BandChannel {
    return new BandChannel(projectId, project);
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
      const profile = await client.me(); // validate + learn our own identity
      // NOTE: do NOT pass our internal project id as task_id — Band validates
      // task_id as a reference to an existing Band task and 422s otherwise
      // ("does not exist"), which silently killed room creation. Create an
      // untethered chat instead.
      const chat = await client.createChat();
      const chatId = chat.id;
      if (!chatId) return;
      const owner = await client.addOwner(chatId).catch(() => null); // human joins
      const selfId = profile.id ?? null;
      const roster = bandAgents();
      // Add every configured agent EXCEPT the orchestrator itself — it is
      // already in the room as the creator/owner (matches the friend's
      // orchestrator, which skips its own id). Without this, when the
      // orchestrator key == a researcher (e.g. State), self-add errors.
      for (const a of roster) {
        if (a.id === selfId) continue;
        await client.addParticipant(chatId, a.id).catch(() => null);
      }
      // Mentions for delivery exclude the orchestrator (a self-mention 422s as
      // mentioned_participant_not_in_room since it joined as owner, not member).
      const mentions: BandMention[] = roster.filter((a) => a.id !== selfId);
      await client
        .sendMessage(chatId, kickoffMessage(project, roster), mentions)
        .catch(() => null);
      // Read-only viewers: one client per distinct agent key. The full room
      // transcript is the union of each agent's mention-scoped view.
      const viewers = bandViewerKeys().map((k) => new BandClient(k));
      this.room = {
        client,
        viewers,
        chatId,
        roster,
        mentions,
        ownerId: owner?.id ?? profile.owner_uuid ?? null,
        selfId,
      };
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

  // Read the live transcript of the real Band room so the UI can showcase the
  // actual conversation between the research agents (to double-check the run).
  //
  // Band's messages API is mention-scoped per agent, so no single key sees the
  // whole room. We read with every viewer key and UNION by message id to
  // reconstruct the full conversation. Viewers are queried sequentially (not in
  // parallel) to stay under Band's rate limit. Returns [] when no room is open;
  // a failed/throttled viewer is skipped, never throwing.
  async roomTranscript(): Promise<BandRoomMessage[]> {
    if (!this.room) return [];
    const byId = new Map<string, RawBandMessage>();
    for (const viewer of this.room.viewers) {
      try {
        const raw = await viewer.listMessages(this.room.chatId);
        for (const m of raw) {
          const id = String(m.id ?? "");
          if (id && !byId.has(id)) byId.set(id, m);
        }
      } catch {
        /* throttled/forbidden viewer — skip, the others still contribute */
      }
    }
    return [...byId.values()]
      .map((m) => this.normalizeRoomMessage(m))
      .filter((m) => m.content)
      .sort((a, b) => a.ts - b.ts);
  }

  // Band encodes @mentions in message text as `@[[<uuid>]]`. Turn those into
  // readable `@Name` using the per-message mention map (falling back to the
  // room's known agents), so the transcript reads like a real conversation.
  private cleanMentions(
    text: string,
    msgMentions?: { id?: string; name?: string }[]
  ): string {
    if (!text.includes("@[[")) return text;
    const names = new Map<string, string>();
    for (const a of this.room?.roster ?? []) names.set(a.id, a.name);
    for (const mm of msgMentions ?? []) {
      if (mm.id && mm.name) names.set(mm.id, mm.name);
    }
    return text.replace(/@\[\[([0-9a-f-]+)\]\]/gi, (_, id: string) =>
      names.has(id) ? `@${names.get(id)}` : "@"
    );
  }

  private normalizeRoomMessage(m: RawBandMessage): BandRoomMessage {
    const room = this.room!;
    const authorId =
      m.author?.id ?? m.sender?.id ?? m.sender_id ?? m.participant_id ?? "";
    const agent = room.roster.find((a) => a.id === authorId);
    let kind: BandRoomMessage["kind"] = "agent";
    let author =
      agent?.name ??
      m.author?.name ??
      m.sender?.name ??
      m.sender_name ??
      m.author_name ??
      "";
    if (agent) {
      kind = "agent";
      author = agent.name;
    } else if (authorId && authorId === room.selfId) {
      kind = "orchestrator";
      author = author || "FirstPass Orchestrator";
    } else if (authorId && authorId === room.ownerId) {
      kind = "human";
      author = author || "You";
    } else {
      author = author || "Participant";
    }
    const raw = (m.content ?? m.text ?? m.message?.content ?? "").trim();
    const content = this.cleanMentions(raw, m.metadata?.mentions);
    const rawTs = m.created_at ?? m.inserted_at ?? m.timestamp;
    let ts = 0;
    if (typeof rawTs === "number") ts = rawTs < 1e12 ? rawTs * 1000 : rawTs;
    else if (typeof rawTs === "string") {
      const parsed = Date.parse(rawTs);
      if (!Number.isNaN(parsed)) ts = parsed;
    }
    return { id: String(m.id ?? `${authorId}:${ts}:${content.slice(0, 24)}`), author, content, ts, kind };
  }
}
