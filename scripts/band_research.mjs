#!/usr/bin/env node
// Drive the REAL Band research room from the command line: open a chat, add the
// registered code researchers, @mention them with a Los-Angeles research ask,
// then poll the room transcript and print/save every reply. Unlike the in-app
// BandChannel (which only forwards demo events), this asks the agents to POST
// THE VERBATIM CODE TEXT IN CHAT, because we can only read the room — not the
// agents' own machine's output/ folder.
//
// Usage: node scripts/band_research.mjs [pollSeconds]
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- load .env.local (KEY=VALUE, ignore comments/quotes) ---------------------
function loadEnv() {
  try {
    const txt = readFileSync(join(ROOT, ".env.local"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch (e) {
    console.error("could not read .env.local:", e.message);
  }
}
loadEnv();

const BASE = (process.env.BAND_REST_URL || "https://app.band.ai/api/v1/agent").replace(/\/+$/, "");
const ORCH = process.env.BAND_API_KEY;
if (!ORCH) { console.error("BAND_API_KEY not set"); process.exit(1); }

const AGENTS = [
  { id: process.env.BAND_AGENT_MUNICIPAL_ID, name: "Municipal Code Researcher",
    ask: "City of Los Angeles zoning code (LAMC): R1 §12.08 and §12.21.1 (max height in feet, Residential Floor Area / FAR ratio, lot coverage), §12.21 A.4 parking spaces per dwelling, R3 §12.10 (height, setbacks, density), and §12.22 A.33 ADU standards (max size sqft, height, setbacks)" },
  { id: process.env.BAND_AGENT_STATE_ID, name: "State Code Researcher",
    ask: "California state ADU law Gov. Code §66314/§66321/§66322/§66323 (height 16/18/25 ft conditions, 4 ft side & rear setbacks, 800/850/1000/1200 sqft size limits, transit parking exemption)" },
].filter((a) => a.id);

function api(key) {
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    try { const j = JSON.parse(text); return j && "data" in j ? j.data : j; } catch { return text; }
  };
}

const orch = api(ORCH);

const VIEWER_ENVS = ["BAND_API_KEY","BAND_AGENT_MUNICIPAL_KEY","BAND_AGENT_STATE_KEY","BAND_AGENT_COMPARE_KEY","BAND_AGENT_SYNTHESIZER_KEY","BAND_USER_API_KEY"];
const viewerKeys = [...new Set(VIEWER_ENVS.map((e) => process.env[e]).filter(Boolean))];

function kickoff() {
  const tasks = AGENTS.map((a) =>
    `@${a.name} — Research the ${a.ask}. Use official / Internet Archive sources. ` +
    `IMPORTANT: paste the VERBATIM provision text WITH the exact numbers AND the source URL directly into this chat (do not only write a file — I can only read this chat). Quote the code; do not summarize the numbers.`
  ).join("\n\n");
  return `Pre-submission permit research for **Los Angeles, CA** (single-family, multi-family, and ADU residential).\n\n${tasks}\n\nPost each provision as: section number + source URL + verbatim quoted text with the numeric standard.`;
}

async function main() {
  const pollSeconds = Number(process.argv[2] || 210);
  console.log(`BASE=${BASE}  agents=${AGENTS.map((a)=>a.name).join(", ")}  viewers=${viewerKeys.length}`);
  const me = await orch("GET", "/me");
  console.log("me:", JSON.stringify(me).slice(0, 200));
  const selfId = me.id ?? null;

  const chat = await orch("POST", "/chats", { chat: {} });
  const chatId = chat.id;
  console.log("chatId:", chatId);
  if (!chatId) throw new Error("no chat id");

  // add owner + agents
  if (me.owner_uuid) await orch("POST", `/chats/${chatId}/participants`, { participant: { participant_id: me.owner_uuid, role: "member" } }).catch((e)=>console.log("addOwner:", e.message));
  for (const a of AGENTS) {
    if (a.id === selfId) continue;
    await orch("POST", `/chats/${chatId}/participants`, { participant: { participant_id: a.id } }).catch((e)=>console.log(`add ${a.name}:`, e.message));
  }

  const mentions = AGENTS.filter((a)=>a.id!==selfId).map((a)=>({ id: a.id, name: a.name, handle: a.name.toLowerCase().replace(/\s+/g,"-") }));
  await orch("POST", `/chats/${chatId}/messages`, { message: { content: kickoff(), mentions } });
  console.log("kickoff sent. polling for", pollSeconds, "s …\n");

  const viewers = viewerKeys.map((k)=>api(k));
  const seen = new Map();
  const start = Date.now();
  while ((Date.now() - start) / 1000 < pollSeconds) {
    await new Promise((r)=>setTimeout(r, 15000));
    for (const v of viewers) {
      try {
        const data = await v("GET", `/chats/${chatId}/messages?status=all`);
        const arr = Array.isArray(data) ? data : (data.messages || data.items || []);
        for (const m of arr) {
          const id = String(m.id ?? "");
          if (!id || seen.has(id)) continue;
          seen.set(id, m);
          const author = m.sender_name || m.author?.name || m.sender?.name || m.author_name || m.participant_id || "?";
          const content = (m.content || m.text || m.message?.content || "").trim();
          if (content) console.log(`\n──── ${author} ────\n${content}\n`);
        }
      } catch (e) { /* throttled viewer */ }
    }
  }

  // save the full transcript to output/
  const outDir = join(ROOT, "output");
  mkdirSync(outDir, { recursive: true });
  const all = [...seen.values()].map((m)=>({ author: m.sender_name||m.author?.name||"?", content:(m.content||m.text||m.message?.content||"").trim() }));
  writeFileSync(join(outDir, "band_room_transcript.json"), JSON.stringify({ chatId, messages: all }, null, 2));
  console.log(`\nDONE. ${seen.size} messages. transcript -> output/band_room_transcript.json`);
}

main().catch((e)=>{ console.error("FATAL:", e.message); process.exit(1); });
