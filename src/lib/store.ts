// Redis-backed store with in-memory fallback (PLAN.md §Redis).
// Uses ioredis when REDIS_URL is set; otherwise a process-local Map so the
// app runs with zero infrastructure. Same interface either way.
import fs from "fs/promises";
import type Redis from "ioredis";
import type { ProjectState } from "./types";
import { ensureProjectDir, projectStatePath } from "./project-files";

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

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const r = await client();
  if (r) {
    try {
      const v = await r.get(key);
      if (v != null) return parseJson<T>(v);
    } catch (e) {
      warnMemoryFallback(`read failed: ${(e as Error).message}`);
    }
  }
  const m = mem.get(key);
  return m ? parseJson<T>(m) : null;
}

// Read a Redis HASH (all field/value pairs). Used for the multi-agent blackboard
// (project:{id}:blackboard), which the Python Band agents write with HSET — see
// src/firstpass/redis_store.py and docs/REDIS_PLAN.md. Returns {} when Redis is
// absent (the in-memory fallback Map is string-only and never holds hashes) or
// the key doesn't exist, so callers can treat empty as "no artifacts yet".
export async function hgetAll(key: string): Promise<Record<string, string>> {
  const r = await client();
  if (r) {
    try {
      return (await r.hgetall(key)) ?? {};
    } catch (e) {
      warnMemoryFallback(`hgetall failed: ${(e as Error).message}`);
    }
  }
  return {};
}

// Read a single Redis string key without JSON-parsing (project:active is a bare
// id string, not a JSON blob). Returns null when absent or in fallback mode.
export async function getRaw(key: string): Promise<string | null> {
  const r = await client();
  if (r) {
    try {
      return await r.get(key);
    } catch (e) {
      warnMemoryFallback(`get failed: ${(e as Error).message}`);
    }
  }
  return null;
}

// Issue a raw Redis command (e.g. FT.SEARCH on the RedisVL index built by
// scripts/index_codes_redisvl.py). Returns null when Redis is unavailable OR the
// command errors — notably FT.* on a Redis without the Search module — so the
// caller can cleanly fall back to lexical retrieval. We intentionally do NOT
// route this through warnMemoryFallback: a missing Search module is an expected,
// recoverable condition, not a persistence failure.
export async function redisCommand(
  ...args: (string | number)[]
): Promise<unknown | null> {
  const r = await client();
  if (!r) return null;
  try {
    return await r.call(args[0] as string, ...(args.slice(1) as string[]));
  } catch {
    return null;
  }
}

const stateKey = (id: string) => `state:${id}`;

export async function saveState(state: ProjectState): Promise<void> {
  await kvSet(stateKey(state.project.id), state);
  try {
    await ensureProjectDir(state.project.id);
    await fs.writeFile(projectStatePath(state.project.id), JSON.stringify(state), "utf-8");
  } catch {
    /* kv is primary; disk is for dev replay */
  }
}

export async function loadState(id: string): Promise<ProjectState | null> {
  const fromKv = await kvGet<ProjectState>(stateKey(id));
  if (fromKv?.project.status === "done") return fromKv;

  try {
    const raw = await fs.readFile(projectStatePath(id), "utf-8");
    const fromDisk = parseJson<ProjectState>(raw);
    if (fromDisk?.project.status === "done") return fromDisk;
    if (fromDisk && !fromKv) return fromDisk;
  } catch {
    /* no disk snapshot yet */
  }

  return fromKv;
}

const PROJECT_INDEX = "projects:index";

/** Track a new project id for listing (sorted by createdAt). */
export async function addToProjectIndex(id: string, createdAt: number): Promise<void> {
  const r = await client();
  if (r) {
    try {
      await r.zadd(PROJECT_INDEX, createdAt, id);
      return;
    } catch (e) {
      warnMemoryFallback(`index add failed: ${(e as Error).message}`);
    }
  }
  const idx = (await kvGet<{ id: string; createdAt: number }[]>(PROJECT_INDEX)) ?? [];
  if (!idx.some((e) => e.id === id)) {
    idx.unshift({ id, createdAt });
    await kvSet(PROJECT_INDEX, idx);
  }
}

/** All project ids, newest first. Also picks up projects missing from the index. */
export async function listProjectIds(): Promise<string[]> {
  const fromIndex = await listProjectIdsFromIndex();
  if (fromIndex.length > 0) return fromIndex;
  return scanProjectIds();
}

async function listProjectIdsFromIndex(): Promise<string[]> {
  const r = await client();
  if (r) {
    try {
      return (await r.zrevrange(PROJECT_INDEX, 0, -1)) ?? [];
    } catch (e) {
      warnMemoryFallback(`index list failed: ${(e as Error).message}`);
    }
  }
  const idx = (await kvGet<{ id: string; createdAt: number }[]>(PROJECT_INDEX)) ?? [];
  return idx.sort((a, b) => b.createdAt - a.createdAt).map((e) => e.id);
}

async function scanProjectIds(): Promise<string[]> {
  const r = await client();
  if (r) {
    try {
      const ids: string[] = [];
      let cursor = "0";
      do {
        const [next, keys] = (await r.scan(cursor, "MATCH", "proj:*", "COUNT", 100)) as [
          string,
          string[],
        ];
        cursor = next;
        for (const key of keys) {
          const id = key.slice("proj:".length);
          if (id) ids.push(id);
        }
      } while (cursor !== "0");
      return ids;
    } catch (e) {
      warnMemoryFallback(`scan failed: ${(e as Error).message}`);
    }
  }
  return [...mem.keys()]
    .filter((k) => k.startsWith("proj:"))
    .map((k) => k.slice("proj:".length));
}

export async function removeFromProjectIndex(id: string): Promise<void> {
  const r = await client();
  if (r) {
    try {
      await r.zrem(PROJECT_INDEX, id);
      return;
    } catch (e) {
      warnMemoryFallback(`index remove failed: ${(e as Error).message}`);
    }
  }
  const idx = (await kvGet<{ id: string; createdAt: number }[]>(PROJECT_INDEX)) ?? [];
  await kvSet(
    PROJECT_INDEX,
    idx.filter((e) => e.id !== id)
  );
}

export async function kvDel(key: string): Promise<void> {
  const r = await client();
  if (r) {
    try {
      await r.del(key);
      return;
    } catch (e) {
      warnMemoryFallback(`del failed: ${(e as Error).message}`);
    }
  }
  mem.delete(key);
}

/** Remove all persisted data for a project. */
export async function deleteProject(id: string): Promise<void> {
  await removeFromProjectIndex(id);
  await kvDel(`proj:${id}`);
  await kvDel(stateKey(id));
  await kvDel(`plan:${id}`);
  await kvDel(`plot:${id}`);

  const r = await client();
  if (r) {
    try {
      const plotKeys = await r.keys(`plot:${id}:*`);
      if (plotKeys.length) await r.del(...plotKeys);
      await r.del(`project:${id}:blackboard`);
    } catch (e) {
      warnMemoryFallback(`project delete failed: ${(e as Error).message}`);
    }
  } else {
    for (const key of [...mem.keys()]) {
      if (key.startsWith(`plot:${id}:`)) mem.delete(key);
    }
  }
}
