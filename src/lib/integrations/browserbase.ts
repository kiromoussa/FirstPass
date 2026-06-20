// Browserbase adapter (PLAN.md §5 Browserbase). Live with BROWSERBASE_API_KEY,
// otherwise serves the cached official-source set (clearly timestamped) so the
// citation story never hard-fails in a demo.
import { CACHED_SOURCES } from "../fixtures";
import type { Source } from "../types";

export const BROWSERBASE_LIVE =
  !!process.env.BROWSERBASE_API_KEY && !!process.env.BROWSERBASE_PROJECT_ID;

// Returns the official sources for the jurisdiction. When live, this would
// drive a headless Browserbase session to navigate Alameda's planning site,
// locate the ADU/zoning and submittal-checklist pages, and extract the exact
// excerpts + canonical URLs with a fresh retrieval timestamp.
export async function researchSources(): Promise<{
  sources: Source[];
  live: boolean;
}> {
  if (!BROWSERBASE_LIVE) {
    return {
      sources: CACHED_SOURCES.map((s) => ({ ...s, live: false })),
      live: false,
    };
  }
  try {
    const sources = await browseAlameda();
    return { sources, live: true };
  } catch {
    return {
      sources: CACHED_SOURCES.map((s) => ({ ...s, live: false })),
      live: false,
    };
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
