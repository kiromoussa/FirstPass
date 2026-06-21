// Redis-backed store with in-memory fallback (PLAN.md §Redis).
// Uses ioredis when REDIS_URL is set; otherwise a process-local Map so the
// app runs with zero infrastructure. Same interface either way.
import type Redis from "ioredis";
import type { ProjectState } from "./types";

let redis: Redis | null = null;
let redisTried = false;
let warnedFallback = false;
const mem = new Map<string, string>();

export const REDIS_LIVE = !!process.env.REDIS_URL;

// On serverless (Vercel) the in-memory Map is per-instance and per-cold-start,
// so a project written on one invocation can be missing on the next → spurious
// "Project not found". Memory is only safe for zero-infra local dev. Surface the
// fallback loudly (once) so a misconfigured/unreachable Redis in production is
// diagnosable instead of silent.
function warnMemoryFallback(reason: string): void {
  if (warnedFallback) return;
  warnedFallback = true;
  const msg = `[store] Using in-memory store (${reason}). Data will NOT persist across instances — set a reachable REDIS_URL in production.`;
  if (process.env.NODE_ENV === "production") console.error(msg);
  else console.warn(msg);
}

if (process.env.NODE_ENV === "production" && !process.env.REDIS_URL) {
  warnMemoryFallback("REDIS_URL is not set");
}

async function client(): Promise<Redis | null> {
  if (!process.env.REDIS_URL) return null;
  if (redis || redisTried) return redis;
  redisTried = true;
  try {
    const { default: IORedis } = await import("ioredis");
    redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
    // Never crash on a Redis blip, but don't swallow it silently either — a
    // persistent connection error in production means data isn't persisting.
    redis.on("error", (err: Error) => warnMemoryFallback(`Redis error: ${err.message}`));
  } catch {
    redis = null;
  }
  return redis;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  const r = await client();
  if (r) {
    try {
      await r.set(key, json, "EX", 60 * 60 * 6); // 6h TTL
      return;
    } catch (e) {
      warnMemoryFallback(`write failed: ${(e as Error).message}`);
    }
  }
  mem.set(key, json);
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const r = await client();
  if (r) {
    try {
      const v = await r.get(key);
      if (v != null) return JSON.parse(v) as T;
    } catch (e) {
      warnMemoryFallback(`read failed: ${(e as Error).message}`);
    }
  }
  const m = mem.get(key);
  return m ? (JSON.parse(m) as T) : null;
}

const stateKey = (id: string) => `state:${id}`;

export async function saveState(state: ProjectState): Promise<void> {
  await kvSet(stateKey(state.project.id), state);
}

export async function loadState(id: string): Promise<ProjectState | null> {
  return kvGet<ProjectState>(stateKey(id));
}
