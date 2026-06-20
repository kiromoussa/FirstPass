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

const DEFAULT_BASE = "https://app.band.ai/api/v1/agent";

// The three research agents already registered at app.band.ai. The ids match
// the firstpass.config.yaml the room was first built with so the room works
// against the same agents out of the box; override any of them via env.
const AGENT_DEFS = [
  {
    envId: "BAND_AGENT_MUNICIPAL_ID",
    name: "Municipal Code Researcher",
    fallbackId: "28e83f6c-4362-4539-8e53-0f31477d99c1",
  },
  {
    envId: "BAND_AGENT_STATE_ID",
    name: "State Code Researcher",
    fallbackId: "0d05ac9f-7998-4030-86d2-72381854ebd3",
  },
  {
    envId: "BAND_AGENT_SYNTHESIZER_ID",
    name: "Code Synthesizer",
    fallbackId: "94d50391-87a6-4285-a8b7-03faf165722e",
  },
] as const;

// Mention list for the registered research agents (handle = kebab-cased name,
// matching the Python build_mentions()).
export function bandAgents(): BandMention[] {
  return AGENT_DEFS.map((a) => ({
    id: process.env[a.envId] || a.fallbackId,
    name: a.name,
    handle: a.name.toLowerCase().replace(/\s+/g, "-"),
  }));
}

function base(): string {
  return (process.env.BAND_REST_URL || DEFAULT_BASE).replace(/\/+$/, "");
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
}
