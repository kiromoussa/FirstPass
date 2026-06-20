// Redis-backed store with in-memory fallback (PLAN.md §Redis).
// Uses ioredis when REDIS_URL is set; otherwise a process-local Map so the
// app runs with zero infrastructure. Same interface either way.
import type Redis from "ioredis";
import type { ProjectState } from "./types";

let redis: Redis | null = null;
let redisTried = false;
const mem = new Map<string, string>();

export const REDIS_LIVE = !!process.env.REDIS_URL;

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
    redis.on("error", () => {}); // never crash the demo on a redis blip
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
    } catch {
      /* fall through to memory */
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
    } catch {
      /* fall through */
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
