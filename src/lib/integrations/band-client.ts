// Band Agent REST client — a faithful TypeScript port of the working Python
// client in the firstpass research repo (src/firstpass/band_client.py). Band
// (band.ai) is the multi-agent message bus. This client lets FirstPass spin up
// a REAL collaboration room at run start: validate the orchestrator agent,
// create a chat, add the human owner, add the registered research agents, and
// post a kickoff message that @mentions them. Everything is best-effort — the
// local SSE feed is the source of truth for the demo, so a Band outage never
// breaks a run (see band.ts).
//
// REST surface (base https://app.band.ai/api/v1/agent, override BAND_REST_URL):
//   GET  /me                         -> { data: { owner_uuid, name, id, ... } }
//   POST /chats         body {chat:{task_id?}}            -> { data: { id } }
//   POST /chats/{id}/participants  body {participant:{participant_id, role?}}
//   GET  /chats/{id}/participants
//   POST /chats/{id}/messages      body {message:{content, mentions}}
// Auth header: X-API-Key: <agent key, e.g. band_a_...>.

export interface BandMention {
  id: string;
  name: string;
  handle: string;
}

// A configured agent in the room: a mention plus its research role and the
// one-line ask used to seed the kickoff message.
export interface BandAgentDef extends BandMention {
  role: "researcher" | "comparator" | "synthesizer";
  ask: string; // research/compare goal — what this agent should produce
  report: string; // output/<file> the agent must write (drives ingest_band_output)
}

const DEFAULT_BASE = "https://app.band.ai/api/v1/agent";

// The full researcher roster, mirroring the friend's orchestrator (main branch:
// src/firstpass/orchestrator.py AGENT_NAMES). The friend's engine now researches
// every code layer, not just municipal+state. The CORE THREE are pre-registered
// at app.band.ai (ids below); the four extra code-layer researchers have no
// fallback id, so they are AUTOMATICALLY SKIPPED until you register them and set
// their env id — exactly the "skipped if agent_id is empty" rule in their
// firstpass.config.yaml.example. Override any id via env.
const AGENT_DEFS = [
  {
    envId: "BAND_AGENT_MUNICIPAL_ID",
    name: "Municipal Code Researcher",
    fallbackId: "28e83f6c-4362-4539-8e53-0f31477d99c1",
    role: "researcher",
    ask: "Municipal ADU / zoning codes (size, setbacks, parking, submittal)",
    report: "municipal_codes.txt",
  },
  {
    envId: "BAND_AGENT_STATE_ID",
    name: "State Code Researcher",
    fallbackId: "0d05ac9f-7998-4030-86d2-72381854ebd3",
    role: "researcher",
    ask: "California state ADU standards that preempt local limits (Gov. Code 65852 / 66310, Title 24)",
    report: "state_codes.txt",
  },
  {
    envId: "BAND_AGENT_BUILDING_ID",
    name: "Building Code Researcher",
    fallbackId: "",
    role: "researcher",
    ask: "California Building Code (CBC) occupancy, fire separation, egress for dwellings",
    report: "building_codes.txt",
  },
  {
    envId: "BAND_AGENT_RESIDENTIAL_ID",
    name: "Residential Code Researcher",
    fallbackId: "",
    role: "researcher",
    ask: "California Residential Code (CRC) ceiling height, smoke/CO alarms, escape openings",
    report: "residential_codes.txt",
  },
  {
    envId: "BAND_AGENT_PLUMBING_ID",
    name: "Plumbing Code Researcher",
    fallbackId: "",
    role: "researcher",
    ask: "California Plumbing Code (CPC) minimum fixtures and water heater requirements",
    report: "plumbing_codes.txt",
  },
  {
    envId: "BAND_AGENT_GREEN_ID",
    name: "Green Code Researcher",
    fallbackId: "",
    role: "researcher",
    ask: "CALGreen water-efficiency, EV-ready, and waste-reduction mandatory measures",
    report: "green_codes.txt",
  },
  {
    // New agent (friend's account): compares the project's plan set against the
    // applicable codes the researchers found, flagging where the design
    // violates them — a compliance comparison, before the synthesizer merges.
    envId: "BAND_AGENT_COMPARE_ID",
    name: "Compare Codes",
    fallbackId: "50d5fafe-b84a-49a7-b902-1558d4deeee3",
    role: "comparator",
    ask: "compare the project's plan set against the applicable codes the researchers found and flag where the design violates them, with the governing citation",
    report: "plan_vs_code.txt",
  },
  {
    envId: "BAND_AGENT_SYNTHESIZER_ID",
    name: "Code Synthesizer",
    fallbackId: "94d50391-87a6-4285-a8b7-03faf165722e",
    role: "synthesizer",
    ask: "",
    report: "final_summary.txt",
  },
] as const;

// Every CONFIGURED agent (handle = kebab-cased name, matching the Python
// build_mentions()). Agents without a resolved id are skipped, so registering
// only the core three keeps the room working while leaving room to grow.
export function bandAgents(): BandAgentDef[] {
  const out: BandAgentDef[] = [];
  for (const a of AGENT_DEFS) {
    const id = process.env[a.envId] || a.fallbackId;
    if (!id) continue; // unconfigured optional researcher → skip
    out.push({
      id,
      name: a.name,
      handle: a.name.toLowerCase().replace(/\s+/g, "-"),
      role: a.role,
      ask: a.ask,
      report: a.report,
    });
  }
  return out;
}

function base(): string {
  return (process.env.BAND_REST_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

// Band's messages API is mention-scoped per agent: each key only sees messages
// that @mention it. To reconstruct the FULL room transcript we read with every
// available agent key and union the results. These are the read-only "viewer"
// keys (the orchestrator BAND_API_KEY is what actually sends). Distinct, so a
// shared orchestrator/agent key isn't queried twice.
const VIEWER_KEY_ENVS = [
  "BAND_API_KEY",
  "BAND_AGENT_MUNICIPAL_KEY",
  "BAND_AGENT_STATE_KEY",
  "BAND_AGENT_BUILDING_KEY",
  "BAND_AGENT_RESIDENTIAL_KEY",
  "BAND_AGENT_PLUMBING_KEY",
  "BAND_AGENT_GREEN_KEY",
  "BAND_AGENT_COMPARE_KEY",
  "BAND_AGENT_SYNTHESIZER_KEY",
] as const;

export function bandViewerKeys(): string[] {
  const seen = new Set<string>();
  for (const env of VIEWER_KEY_ENVS) {
    const k = process.env[env];
    if (k) seen.add(k);
  }
  return [...seen];
}

export class BandClient {
  private headers: Record<string, string>;

  constructor(
    private apiKey: string,
    private baseUrl: string = base()
  ) {
    this.headers = { "Content-Type": "application/json", "X-API-Key": apiKey };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Never let a slow/hanging Band call stall a run — Band is best-effort.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(`Band ${method} ${path} → ${res.status} ${detail}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    if (res.status === 204) return {} as T;
    const json = (await res.json()) as { data?: unknown };
    // Band wraps successful payloads in { data: ... }.
    return ((json && "data" in json ? json.data : json) ?? json) as T;
  }

  me(): Promise<{ owner_uuid?: string; name?: string; id?: string }> {
    return this.request("GET", "/me");
  }

  createChat(taskId?: string): Promise<{ id?: string }> {
    const chat: Record<string, string> = {};
    if (taskId) chat.task_id = taskId;
    return this.request("POST", "/chats", { chat });
  }

  addParticipant(
    chatId: string,
    participantId: string,
    role?: string
  ): Promise<unknown> {
    const participant: Record<string, string> = { participant_id: participantId };
    if (role) participant.role = role;
    return this.request("POST", `/chats/${chatId}/participants`, { participant });
  }

  // Add the human account that owns this agent so they can chat in the room
  // from app.band.ai. 409 (already a participant) is treated as success.
  async addOwner(chatId: string): Promise<{ id: string } | null> {
    const profile = await this.me();
    const ownerId = profile.owner_uuid;
    if (!ownerId) return null;
    try {
      await this.addParticipant(chatId, ownerId, "member");
      return { id: ownerId };
    } catch (e) {
      if ((e as { status?: number }).status === 409) return { id: ownerId };
      throw e;
    }
  }

  sendMessage(
    chatId: string,
    content: string,
    mentions: BandMention[]
  ): Promise<unknown> {
    return this.request("POST", `/chats/${chatId}/messages`, {
      message: { content, mentions },
    });
  }

  // Read the full room transcript. `?status=all` returns every message (not the
  // mention-filtered subset /context gives the agent); Band documents this
  // endpoint as the one "for diagnostics and dashboards", which is exactly the
  // live room view FirstPass shows. The wire shape isn't pinned in the docs, so
  // callers normalize defensively — here we just unwrap the common envelopes.
  async listMessages(chatId: string): Promise<RawBandMessage[]> {
    const data = await this.request<unknown>(
      "GET",
      `/chats/${chatId}/messages?status=all`
    );
    if (Array.isArray(data)) return data as RawBandMessage[];
    if (data && typeof data === "object") {
      const obj = data as { messages?: unknown; items?: unknown };
      if (Array.isArray(obj.messages)) return obj.messages as RawBandMessage[];
      if (Array.isArray(obj.items)) return obj.items as RawBandMessage[];
    }
    return [];
  }
}

// Loose shape for a Band message. The agent API doesn't publish an exact schema,
// so every field is optional and consumers probe the common alternatives.
export interface RawBandMessage {
  id?: string | number;
  content?: string;
  text?: string;
  message?: { content?: string };
  // author identity arrives under several names depending on message origin.
  // Band's live shape uses sender_id + sender_name; older/other shapes nest it.
  author?: { id?: string; name?: string };
  sender?: { id?: string; name?: string };
  sender_id?: string;
  sender_name?: string;
  participant_id?: string;
  author_name?: string;
  // Phoenix/Elixir backend → timestamps are usually inserted_at
  created_at?: string;
  inserted_at?: string;
  timestamp?: string | number;
  // Band embeds the id→name map for the @[[uuid]] markers in the content here.
  metadata?: { mentions?: { id?: string; name?: string }[] };
}
