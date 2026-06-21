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

// A configured agent in the room: a mention plus its workflow role and the
// one-line ask used to seed the kickoff message. Roles map to the FirstPass
// agentic workflow (BAND_AGENTS.md):
//   ceo → planner → synthesizer → researcher(s) → synthesizer
//       → visual + comparator → solutions → permit → ceo
export type BandRole =
  | "ceo"
  | "planner"
  | "synthesizer"
  | "researcher"
  | "visual"
  | "comparator"
  | "solutions"
  | "permit";

export interface BandAgentDef extends BandMention {
  role: BandRole;
  ask: string; // workflow goal — what this agent should produce
  report: string; // output/<file> the agent must write (drives ingest_band_output)
  bandHandle: string; // @varbtw/... handle used in kickoff @mentions
}

const DEFAULT_BASE = "https://app.band.ai/api/v1/agent";

// The full FirstPass agent team (BAND_AGENTS.md), ordered to match the agentic
// workflow: CEO → Planner → Code Synthesizer → Municipal + State researchers →
// Code Synthesizer → Visual Analysis + Compare Codes → Solutions → Permit Report
// → CEO. Each agent's id resolves from env (override) or the fallback below;
// agents with no resolved id are AUTOMATICALLY SKIPPED from the room — so the
// not-yet-registered Solutions / Permit Report agents drop out cleanly until you
// set their env id. Override any id via the env var named in `envId`.
const AGENT_DEFS = [
  {
    envId: "BAND_AGENT_CEO_ID",
    name: "CEO Boss",
    bandHandle: "varbtw/ceo-boss",
    fallbackId: "c684bd1c-36f1-462c-8bd4-f3ea1bc039bf",
    role: "ceo",
    ask: "acknowledge the address, delegate to the Project and Property Manager, monitor phases, and summarize when compare-codes finishes",
    report: "",
  },
  {
    envId: "BAND_AGENT_PROJECT_PROPERTY_MANAGER_ID",
    name: "Project and Property Manager",
    bandHandle: "varbtw/project-property-intake",
    fallbackId: "58eb4a6e-e34f-49fe-97ce-eb51c3113266",
    role: "planner",
    ask: "intake the property, write the project brief, and @mention each specialist in order through compare-codes",
    report: "planner_brief.txt",
  },
  {
    envId: "BAND_AGENT_SYNTHESIZER_ID",
    name: "Code Synthesizer",
    bandHandle: "varbtw/code-synthesizer",
    fallbackId: "94d50391-87a6-4285-a8b7-03faf165722e",
    role: "synthesizer",
    ask: "scope code research questions, then merge municipal + state reports into the governing code set",
    report: "final_summary.txt",
  },
  {
    envId: "BAND_AGENT_MUNICIPAL_ID",
    name: "Municipal Code Researcher",
    bandHandle: "varbtw/municipal-researcher",
    fallbackId: "28e83f6c-4362-4539-8e53-0f31477d99c1",
    role: "researcher",
    ask: "scrape municipal ADU/zoning code from Internet Archive only — size, setbacks, parking, submittal",
    report: "municipal_codes.txt",
  },
  {
    envId: "BAND_AGENT_STATE_ID",
    name: "State Code Researcher",
    bandHandle: "varbtw/state-code-researcher",
    fallbackId: "0d05ac9f-7998-4030-86d2-72381854ebd3",
    role: "researcher",
    ask: "scrape California Gov Code + Title 24 ADU standards from Internet Archive only",
    report: "state_codes.txt",
  },
  {
    envId: "BAND_AGENT_VISUAL_ID",
    name: "Visual Analysis",
    bandHandle: "varbtw/vis-agent",
    fallbackId: "4a985a13-5b35-4092-84a4-240a94a5f8b8",
    role: "visual",
    ask: "read the plan set with Claude vision and extract unit size, height, and setbacks",
    report: "plan_facts.txt",
  },
  {
    envId: "BAND_AGENT_COMPARE_ID",
    name: "Compare Codes",
    bandHandle: "varbtw/compare-codes",
    fallbackId: "50d5fafe-b84a-49a7-b902-1558d4deeee3",
    role: "comparator",
    ask: "read the DWG/PDF (APS + vision), compare plan facts against governing codes, and write plan_facts.txt + plan_vs_code.txt",
    report: "plan_vs_code.txt",
  },
  {
    envId: "BAND_AGENT_SOLUTIONS_ID",
    name: "Improve Agent",
    bandHandle: "varbtw/improve-agent",
    fallbackId: "6422cc1d-e37c-488b-9801-c23eefca4c44",
    role: "solutions",
    ask: "research design fixes on the web with Browserbase for each flagged violation and write solutions_report.txt",
    report: "solutions_report.txt",
  },
  {
    envId: "BAND_AGENT_PERMIT_ID",
    name: "Permit Agent",
    bandHandle: "varbtw/permit-report-agent",
    fallbackId: "349ec1e2-4fa4-422b-a3a2-53f4f9668320",
    role: "permit",
    ask: "research the city's permit portal with Browserbase, compare the plan set to the submittal checklist, and compile the pre-submission package",
    report: "permit_report.txt",
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
      handle: a.bandHandle.split("/").pop() ?? a.name.toLowerCase().replace(/\s+/g, "-"),
      role: a.role,
      ask: a.ask,
      report: a.report,
      bandHandle: a.bandHandle,
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
  "BAND_AGENT_CEO_KEY",
  "BAND_AGENT_PROJECT_PROPERTY_MANAGER_KEY",
  "BAND_AGENT_SYNTHESIZER_KEY",
  "BAND_AGENT_MUNICIPAL_KEY",
  "BAND_AGENT_STATE_KEY",
  "BAND_AGENT_VISUAL_KEY",
  "BAND_AGENT_COMPARE_KEY",
  "BAND_AGENT_SOLUTIONS_KEY",
  "BAND_AGENT_PERMIT_KEY",
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
