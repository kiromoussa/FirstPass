#!/usr/bin/env node
// Harvest REAL research from the Band rooms your friend's orchestrator drives.
// Lists every chat, unions messages across all available agent keys, keeps only
// substantive posts BY the researcher agents (not the app's own kickoff/forwarded
// events), groups them by code layer, and writes Band-format output/<layer>.txt
// files that `scripts/ingest_band_output.py` then chunks into the LA corpus.
//
// Run AFTER the friend's engine has produced agent replies:
//   node scripts/band_harvest.mjs
//   python3 scripts/ingest_band_output.py --slug los-angeles-ca --city "Los Angeles" --state CA --commit
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const txt = readFileSync(join(ROOT, ".env.local"), "utf8");
for (const l of txt.split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v; } }

const B = (process.env.BAND_REST_URL || "https://app.band.ai/api/v1/agent").replace(/\/+$/, "");
const keys = [...new Set(["BAND_API_KEY","BAND_AGENT_MUNICIPAL_KEY","BAND_AGENT_STATE_KEY","BAND_AGENT_BUILDING_KEY","BAND_AGENT_RESIDENTIAL_KEY","BAND_AGENT_PLUMBING_KEY","BAND_AGENT_GREEN_KEY","BAND_AGENT_COMPARE_KEY","BAND_AGENT_SYNTHESIZER_KEY","BAND_USER_API_KEY"].map((e) => process.env[e]).filter(Boolean))];

// researcher display name -> output report filename (mirrors band-client AGENT_DEFS)
const REPORT = {
  "Municipal Code Researcher": "municipal_codes.txt",
  "State Code Researcher": "state_codes.txt",
  "Building Code Researcher": "building_codes.txt",
  "Residential Code Researcher": "residential_codes.txt",
  "Plumbing Code Researcher": "plumbing_codes.txt",
  "Green Code Researcher": "green_codes.txt",
};

async function get(key, path) {
  const r = await fetch(B + path, { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  const j = await r.json(); return j && "data" in j ? j.data : j;
}

const chats = (await get(process.env.BAND_API_KEY, "/chats")) || [];
console.log(`scanning ${chats.length} chats …`);
const byAuthor = new Map(); // author -> [contents]
for (const c of chats) {
  const seen = new Map();
  for (const k of keys) { try { const d = await get(k, `/chats/${c.id}/messages`); const arr = Array.isArray(d) ? d : (d.messages || d.items || []); for (const m of arr) { const id = String(m.id ?? ""); if (id && !seen.has(id)) seen.set(id, m); } } catch {} }
  for (const m of seen.values()) {
    const author = m.sender_name || m.author?.name || m.author_name || "?";
    const content = (m.content || m.text || m.message?.content || "").trim();
    // Keep only substantive researcher posts: skip the app's kickoff + forwarded events.
    if (!REPORT[author]) continue;
    if (!content || content.length < 200) continue;
    if (content.includes("[FirstPass ·") || content.startsWith("Research building codes for this pre-submission")) continue;
    if (!byAuthor.has(author)) byAuthor.set(author, []);
    byAuthor.get(author).push(content);
  }
}

if (byAuthor.size === 0) {
  console.log("\nNo substantive researcher posts found yet. Is the friend's orchestrator running and have the agents replied? Re-run once they post.");
  process.exit(2);
}

const outDir = join(ROOT, "output");
mkdirSync(outDir, { recursive: true });
for (const [author, posts] of byAuthor) {
  const file = REPORT[author];
  const header = `FirstPass Code Research Report — ${author}\nHarvested from the live Band research room.\n${"=".repeat(80)}\n\n`;
  writeFileSync(join(outDir, file), header + posts.join("\n\n---\n\n") + "\n");
  console.log(`wrote output/${file}  (${posts.length} post(s), ${posts.join("").length} chars)`);
}
console.log("\nNext: python3 scripts/ingest_band_output.py --slug los-angeles-ca --city \"Los Angeles\" --state CA --commit");
