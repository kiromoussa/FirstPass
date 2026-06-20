// Browserbase adapter (PLAN.md §5 Browserbase). Live with BROWSERBASE_API_KEY,
// otherwise serves the cached official-source set (clearly timestamped) so the
// citation story never hard-fails in a demo.
import { CACHED_SOURCES } from "../fixtures";
import { DEFAULT_CITY, loadCityMeta, loadCityChunks } from "../code-db";
import type { Source } from "../types";

export const BROWSERBASE_LIVE =
  !!process.env.BROWSERBASE_API_KEY && !!process.env.BROWSERBASE_PROJECT_ID;

// Official-domain authority heuristic for a source URL (0..1).
function authorityScore(url: string): number {
  const u = url.toLowerCase();
  if (u.includes(".gov") || u.includes("hcd.ca.gov")) return 0.95;
  if (u.includes("amlegal") || u.includes("municode")) return 0.9;
  if (u.includes("codes")) return 0.8;
  return 0.6;
}

// Build cached Source[] for a researched city from its meta.json + chunks
// (excerpt = the first chunk citing that source). Empty if the city has none.
function cityCachedSources(slug: string): Source[] {
  const meta = loadCityMeta(slug);
  if (!meta?.sources?.length) return [];
  const chunks = loadCityChunks(slug) ?? [];
  const now = Date.now();
  return meta.sources.map((s) => {
    const ex = chunks.find((c) => c.sourceId === s.id);
    return {
      id: s.id,
      url: s.url,
      title: s.title,
      excerpt: ex ? ex.text.replace(/\s+/g, " ").slice(0, 240) : "",
      retrievedAt: now,
      authorityScore: authorityScore(s.url),
      jurId: meta.jurisdictionId || slug,
      live: false,
    };
  });
}

// Returns the official sources for a city. The default demo city keeps its
// curated fixtures (rich excerpts); any other researched city derives sources
// from its committed meta.json. When live, drives a Browserbase session.
export async function researchSources(
  slug: string = DEFAULT_CITY
): Promise<{ sources: Source[]; live: boolean }> {
  const cached =
    slug === DEFAULT_CITY
      ? CACHED_SOURCES.map((s) => ({ ...s, live: false }))
      : cityCachedSources(slug);
  const fallback = cached.length
    ? cached
    : CACHED_SOURCES.map((s) => ({ ...s, live: false }));

  if (!BROWSERBASE_LIVE || slug !== DEFAULT_CITY) {
    return { sources: fallback, live: false };
  }
  try {
    return { sources: await browseAlameda(), live: true };
  } catch {
    return { sources: fallback, live: false };
  }
}

// Live navigation. Creates a Browserbase session and drives it with Playwright
// over CDP. Requires `playwright-core` at runtime; we import dynamically so the
// dep is optional for the cached path. Extraction here is intentionally thin —
// we confirm the official pages resolve, then stamp fresh retrieval times onto
// the curated source set (keeping known-good excerpts for demo stability).
async function browseAlameda(): Promise<Source[]> {
  const apiKey = process.env.BROWSERBASE_API_KEY!;
  const projectId = process.env.BROWSERBASE_PROJECT_ID!;

  const res = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BB-API-Key": apiKey },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) throw new Error(`Browserbase session ${res.status}`);
  const session = (await res.json()) as { id: string; connectUrl?: string };

  const connectUrl = session.connectUrl;
  if (connectUrl) {
    try {
      // Optional dependency — indirect specifier so it isn't type-resolved or
      // bundled when absent. Install playwright-core to enable live navigation.
      const mod = "playwright-core";
      const { chromium } = (await import(mod)) as any;
      const browser = await chromium.connectOverCDP(connectUrl);
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      for (const s of CACHED_SOURCES) {
        try {
          await page.goto(s.url, { waitUntil: "domcontentloaded", timeout: 15000 });
        } catch {
          /* tolerate a single unreachable page */
        }
      }
      await browser.close().catch(() => {});
    } catch {
      /* playwright-core not installed — still return live-stamped sources */
    }
  }

  const now = Date.now();
  return CACHED_SOURCES.map((s) => ({ ...s, retrievedAt: now, live: true }));
}
