import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadCityChunks, seedCodeChunks } from "@/lib/code-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

// Ingest a city's researched building code and turn it into a committed,
// chunked corpus the compliance engine can run against.
//
// This is the endpoint the Code Synthesizer (or the local research scraper)
// calls once a city's code has been gathered:
//   1. store the raw research docs under data/cities/<slug>/raw/*.txt + meta.json
//   2. run scripts/chunk_codes.py to chunk them into data/cities/<slug>/chunks.json
//   3. seed the chunks so checks retrieve only the relevant unit (token-cheap)
// After this runs once and the result is committed, that city is instant: the
// app loads chunks.json straight from the codebase on every future request.
//
// Body: {
//   slug: string,                // kebab city id, e.g. "oakland-ca"
//   city: string, state: string,
//   jurisdictionId?: string,
//   projectTypes?: string[],
//   sources?: { id: string; url: string; title: string }[],
//   documents: { name: string; content: string }[]   // raw research .txt files
// }
interface IngestBody {
  slug?: string;
  city?: string;
  state?: string;
  jurisdictionId?: string;
  projectTypes?: string[];
  sources?: { id: string; url: string; title: string }[];
  documents?: { name: string; content: string }[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

// Reduce an arbitrary document name to a safe "<base>.txt" basename (no paths).
function safeTxtName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const stem = base.replace(/\.[^.]*$/, "") || "doc";
  return `${stem}.txt`;
}

export async function POST(req: NextRequest) {
  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const slug = (body.slug || "").trim();
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json(
      { error: "slug must be kebab-case [a-z0-9-], 2-64 chars" },
      { status: 400 }
    );
  }
  if (!Array.isArray(body.documents) || body.documents.length === 0) {
    return NextResponse.json(
      { error: "documents[] is required (raw research .txt content)" },
      { status: 400 }
    );
  }

  const root = process.cwd();
  const cityDir = path.join(root, "data", "cities", slug);
  const rawDir = path.join(cityDir, "raw");

  try {
    await fs.mkdir(rawDir, { recursive: true });

    // 1. Write raw research documents.
    const written: string[] = [];
    for (const doc of body.documents) {
      if (!doc || typeof doc.content !== "string") continue;
      const fname = safeTxtName(doc.name || `doc-${written.length + 1}`);
      await fs.writeFile(path.join(rawDir, fname), doc.content, "utf-8");
      written.push(`raw/${fname}`);
    }
    if (written.length === 0) {
      return NextResponse.json(
        { error: "no document had string content" },
        { status: 400 }
      );
    }

    // meta.json — city identity + source citations.
    const meta = {
      slug,
      city: body.city || slug,
      state: body.state || "",
      jurisdictionId: body.jurisdictionId || slug,
      projectTypes: body.projectTypes || ["detached_adu"],
      sources: body.sources || [],
      ingestedDocs: written,
    };
    await fs.writeFile(
      path.join(cityDir, "meta.json"),
      JSON.stringify(meta, null, 2) + "\n",
      "utf-8"
    );

    // 2. Run the Python chunker (Claude-authored, deterministic). It reads the
    //    raw docs we just wrote and emits data/cities/<slug>/chunks.json.
    const script = path.join(root, "scripts", "chunk_codes.py");
    const python = process.env.PYTHON_BIN || "python3";
    const { stdout, stderr } = await execFileAsync(python, [script, slug], {
      cwd: root,
      timeout: 60_000,
    });

    // 3. Load + seed the freshly chunked corpus.
    const chunks = loadCityChunks(slug);
    const seeded = await seedCodeChunks(slug);

    return NextResponse.json({
      ok: true,
      slug,
      rawFiles: written,
      chunks: chunks?.length ?? 0,
      seeded,
      chunkFile: `data/cities/${slug}/chunks.json`,
      chunker: stdout.trim(),
      ...(stderr.trim() ? { chunkerWarnings: stderr.trim() } : {}),
      note: "Commit data/cities/" + slug + "/ to make this city work straight from the codebase.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "ingest failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
