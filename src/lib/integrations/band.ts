// Band adapter — multi-agent message bus. Runs open up to 3 phased chats that
// mimic a real architecture firm: Intake & Code → Design Review → Closeout.
import type { AgentMessage, BandRoomMessage, MessageType, Project } from "../types";
import { outputFresh } from "../band-output";
import {
  BandClient,
  bandAgents,
  bandViewerKeys,
  type BandAgentDef,
  type BandMention,
  type RawBandMessage,
} from "./band-client";

export const BAND_LIVE = !!process.env.BAND_API_KEY;
const BAND_FORWARD_LEGACY =
  BAND_LIVE && !!process.env.BAND_CHAT_ID && !!process.env.BAND_MENTION_ID;
const FORWARD_TYPES: MessageType[] = ["disagreement", "retry", "done"];

type Sink = (m: AgentMessage) => void;

interface PhaseChat {
  id: string;
  label: string;
}

interface LiveRoom {
  client: BandClient;
  viewers: BandClient[];
  phases: PhaseChat[];
  roster: BandAgentDef[];
  ownerId: string | null;
  selfId: string | null;
  designOpened: boolean;
  closeoutOpened: boolean;
}

function byRole(agents: BandAgentDef[], role: BandAgentDef["role"]) {
  return agents.find((a) => a.role === role);
}

function mentionOf(a: BandAgentDef): BandMention {
  return { id: a.id, name: a.name, handle: a.handle };
}

/** Chat 1 — CEO assigns; PPM must be in Band `mentions` (sender is the CEO key). */
function phase1Kickoff(
  project: Project | undefined,
  ceo: BandAgentDef,
  ppm: BandAgentDef
): { content: string; mentions: BandMention[] } {
  const address = project?.address || "the project address";
  const type = (project?.projectType || "detached_adu").replace(/_/g, " ");
  return {
    content: `@${ceo.bandHandle} → @${ppm.bandHandle}

**Chat 1 — Intake & Code Research**

New project for FirstPass pre-submission review.

**Address:** ${address}
**Project type:** ${type}

@${ppm.bandHandle} — The CEO has approved scope. Write \`output/planner_brief.txt\`, then @mention @varbtw/code-synthesizer **once**. One handoff at a time.`,
    // Band only delivers to agents listed in `mentions`. The orchestrator sends
    // using the CEO API key, so @mentioning the CEO alone never wakes anyone.
    mentions: [mentionOf(ppm)],
  };
}

function phase2Kickoff(planner: BandAgentDef): { content: string; mentions: BandMention[] } {
  return {
    content: `**Chat 2 — Design Review**

Code research is complete (\`output/final_summary.txt\`).

@${planner.bandHandle} — Open the design review phase. @mention @varbtw/vis-agent to read \`plans/\` and write \`output/plan_facts.txt\`, then @mention @varbtw/compare-codes for plan vs code.`,
    mentions: [mentionOf(planner)],
  };
}

function phase3Kickoff(compare: BandAgentDef, solutions?: BandAgentDef, permit?: BandAgentDef): {
  content: string;
  mentions: BandMention[];
} {
  const solutionsHandle = solutions?.bandHandle ?? "@varbtw/solutions-agent";
  const permitHandle = permit?.bandHandle ?? "@varbtw/permit-report-agent";
  const next = solutions
    ? `${solutionsHandle} for design fixes, then ${permitHandle}, then @varbtw/ceo-boss for final sign-off.`
    : `@varbtw/ceo-boss for executive review (register Solutions + Permit agents to extend closeout).`;
  return {
    content: `**Chat 3 — Closeout**

Comparison saved (\`output/plan_vs_code.txt\`).

@${compare.bandHandle} — Hand off closeout: ${next}`,
    mentions: [mentionOf(compare)],
  };
}

export class BandChannel {
  private sinks: Sink[] = [];
  private room: LiveRoom | null = null;
  readonly buffer: AgentMessage[] = [];
  readonly ready: Promise<void>;

  constructor(public readonly projectId: string, project?: Project) {
    this.ready = this.bootstrapRoom(project).catch(() => undefined);
  }

  static open(projectId: string, project?: Project): BandChannel {
    return new BandChannel(projectId, project);
  }

  get roomId(): string | null {
    return this.room?.phases[0]?.id ?? null;
  }

  get roomIds(): string[] {
    return this.room?.phases.map((p) => p.id) ?? [];
  }

  /** Open chat 2/3 when prior phase deliverables land on disk. */
  async advancePhases(runStartedMs: number): Promise<void> {
    const room = this.room;
    if (!room) return;

    const roster = room.roster;
    const planner = byRole(roster, "planner");
    const visual = byRole(roster, "visual");
    const compare = byRole(roster, "comparator");
    const ceo = byRole(roster, "ceo");
    const solutions = byRole(roster, "solutions");
    const permit = byRole(roster, "permit");

    if (
      !room.designOpened &&
      planner &&
      visual &&
      compare &&
      (await outputFresh("final_summary.txt", runStartedMs))
    ) {
      const chat = await room.client.createChat();
      if (chat.id) {
        await room.client.addOwner(chat.id).catch(() => null);
        for (const a of [ceo, planner, visual, compare].filter(Boolean) as BandAgentDef[]) {
          if (a.id === room.selfId) continue;
          await room.client.addParticipant(chat.id!, a.id).catch(() => null);
        }
        const kick = phase2Kickoff(planner);
        await room.client.sendMessage(chat.id, kick.content, kick.mentions).catch(() => null);
        room.phases.push({ id: chat.id, label: "Chat 2 · Design Review" });
        room.designOpened = true;
      }
    }

    if (
      !room.closeoutOpened &&
      compare &&
      (await outputFresh("plan_vs_code.txt", runStartedMs))
    ) {
      const chat = await room.client.createChat();
      if (chat.id) {
        await room.client.addOwner(chat.id).catch(() => null);
        const participants = [ceo, compare, solutions, permit].filter(Boolean) as BandAgentDef[];
        for (const a of participants) {
          if (a.id === room.selfId) continue;
          await room.client.addParticipant(chat.id!, a.id).catch(() => null);
        }
        const kick = phase3Kickoff(compare, solutions, permit);
        await room.client.sendMessage(chat.id, kick.content, kick.mentions).catch(() => null);
        room.phases.push({ id: chat.id, label: "Chat 3 · Closeout" });
        room.closeoutOpened = true;
      }
    }
  }

  private async bootstrapRoom(project?: Project): Promise<void> {
    const key = process.env.BAND_API_KEY;
    if (!key) return;
    try {
      const client = new BandClient(key);
      const profile = await client.me();
      const roster = bandAgents();
      const selfId = profile.id ?? null;
      const ceo = byRole(roster, "ceo");
      const ppm = byRole(roster, "planner");
      if (!ceo || !ppm) return;

      const chat = await client.createChat();
      if (!chat.id) return;
      const owner = await client.addOwner(chat.id).catch(() => null);

      const phase1Agents = roster.filter((a) =>
        ["ceo", "planner", "synthesizer", "researcher"].includes(a.role)
      );
      for (const a of phase1Agents) {
        if (a.id === selfId) continue;
        await client.addParticipant(chat.id, a.id).catch(() => null);
      }

      const kick = phase1Kickoff(project, ceo, ppm);
      await client.sendMessage(chat.id, kick.content, kick.mentions).catch(() => null);

      this.room = {
        client,
        viewers: bandViewerKeys().map((k) => new BandClient(k)),
        phases: [{ id: chat.id, label: "Chat 1 · Intake & Code Research" }],
        roster,
        ownerId: owner?.id ?? profile.owner_uuid ?? null,
        selfId,
        designOpened: false,
        closeoutOpened: false,
      };
    } catch {
      /* best-effort */
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
        /* ignore */
      }
    }
    if ((this.room || BAND_FORWARD_LEGACY) && FORWARD_TYPES.includes(m.type)) {
      void this.forward(m);
    }
  }

  private async forward(m: AgentMessage): Promise<void> {
    const text = `[FirstPass · ${m.from}${m.to ? " → " + m.to : ""}] ${m.text}`;
    try {
      if (this.room?.phases[0]) {
        const roster = this.room.roster.filter((a) => a.id !== this.room!.selfId);
        const tag = roster.map((x) => `@${x.name}`).join(" ");
        await this.room.client.sendMessage(
          this.room.phases[0].id,
          `${tag}\n${text}`,
          roster
        );
      }
    } catch {
      /* best-effort */
    }
  }

  async roomTranscript(): Promise<BandRoomMessage[]> {
    if (!this.room) return [];
    const byId = new Map<string, BandRoomMessage>();
    for (const phase of this.room.phases) {
      for (const viewer of this.room.viewers) {
        try {
          const raw = await viewer.listMessages(phase.id);
          for (const m of raw) {
            const id = String(m.id ?? "");
            if (!id || byId.has(id)) continue;
            const norm = this.normalizeRoomMessage(m, phase.label);
            if (norm.content) byId.set(id, norm);
          }
        } catch {
          /* skip throttled viewer */
        }
      }
    }
    return [...byId.values()].sort((a, b) => a.ts - b.ts);
  }

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

  private normalizeRoomMessage(m: RawBandMessage, chatLabel: string): BandRoomMessage {
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
    return {
      id: String(m.id ?? `${authorId}:${ts}:${content.slice(0, 24)}`),
      author,
      content,
      ts,
      kind,
      chatLabel,
    };
  }
}
