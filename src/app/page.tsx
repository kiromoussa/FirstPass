"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DISCLAIMER } from "@/lib/types";

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState("Maple St. Detached ADU");
  const [address, setAddress] = useState("1421 Maple St, Alameda, CA 94501");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("");

  async function start() {
    setBusy(true);
    const name_l = file?.name.toLowerCase() ?? "";
    const isDwg = /\.(dwg|dxf)$/.test(name_l) || /acad|dxf/i.test(file?.type ?? "");
    const isVision = !!file && !isDwg && /\.(pdf|png|jpe?g)$/.test(name_l);

    let apsUrn: string | undefined;
    // 1. If a DWG was provided, upload it to Autodesk APS and start translation.
    if (file && isDwg) {
      try {
        setStatusText("Uploading DWG to Autodesk APS…");
        const fd = new FormData();
        fd.append("file", file);
        const up = await fetch("/api/aps/upload", { method: "POST", body: fd });
        const upj = await up.json();
        if (upj.ok && upj.urn) apsUrn = upj.urn;
      } catch {
        /* fall back to the reference set */
      }
    }
    // 2. Create the project (with the URN if we have one).
    setStatusText("Starting FirstPass…");
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, address, dwgName: isDwg ? file?.name : undefined, apsUrn }),
    });
    const { id } = await res.json();

    // 3. A PDF/image plan set is read natively by Claude vision — upload it and
    //    attach to the project before we navigate to the run.
    if (file && isVision) {
      try {
        setStatusText("Uploading plan set for Claude to read…");
        const fd = new FormData();
        fd.append("file", file);
        fd.append("projectId", id);
        await fetch("/api/plans/upload", { method: "POST", body: fd });
      } catch {
        /* fall back to reference facts */
      }
    }
    router.push(`/project/${id}`);
  }

  return (
    <main className="min-h-screen flex flex-col">
      <header className="px-8 py-5 flex items-center justify-between border-b border-ink-700">
        <div className="flex items-center gap-2">
          <span className="text-accent text-xl font-bold tracking-tight">◢ FirstPass</span>
          <span className="text-xs text-ink-600 bg-ink-800 px-2 py-0.5 rounded-full">pre-submission</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-400">
          {["Browserbase", "Band", "Redis", "Arize", "Claude"].map((s) => (
            <span key={s} className="opacity-70">{s}</span>
          ))}
        </div>
      </header>

      <div className="flex-1 grid lg:grid-cols-2">
        <section className="px-8 lg:px-16 py-16 flex flex-col justify-center max-w-2xl">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            Catch permit problems<br />before the city does.
          </h1>
          <p className="mt-5 text-slate-400 text-lg leading-relaxed">
            Upload your residential plans and get a cited, sheet-by-sheet
            permit-readiness report — likely violations, official citations,
            a readiness score, and the missing documents — before you submit.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-slate-400">
            <li>● Multi-agent research of the real Alameda ADU rules</li>
            <li>● Deterministic compliance checks with visible citations</li>
            <li>● Agents that audit and correct each other on screen</li>
          </ul>
        </section>

        <section className="px-8 lg:px-16 py-16 flex flex-col justify-center bg-ink-900 border-l border-ink-700">
          <div className="max-w-md w-full">
            <h2 className="text-sm uppercase tracking-widest text-slate-500 mb-6">New project</h2>

            <label className="block text-sm text-slate-300 mb-1">Project name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2.5 mb-4 text-sm focus:border-accent outline-none"
            />

            <label className="block text-sm text-slate-300 mb-1">Project address</label>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2.5 mb-4 text-sm focus:border-accent outline-none"
            />

            <label className="block text-sm text-slate-300 mb-1">Project type</label>
            <div className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2.5 mb-4 text-sm text-slate-400 flex items-center justify-between">
              <span>Detached ADU</span>
              <span className="text-xs text-ink-600">Alameda, CA</span>
            </div>

            <label className="block text-sm text-slate-300 mb-1">Plan set (PDF or DWG)</label>
            <label className="w-full border border-dashed border-ink-600 rounded-lg px-3 py-6 mb-6 text-center text-sm text-slate-400 cursor-pointer hover:border-accent block">
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.dwg,.dxf,application/pdf,application/acad,image/vnd.dwg,application/dxf"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <span className="text-accent">{file.name}</span>
              ) : (
                <span>Drag &amp; drop or click to upload your plan set</span>
              )}
              <div className="text-[11px] text-ink-600 mt-1">
                <strong className="text-slate-400">PDF (recommended):</strong> Claude reads the sheets
                directly and measures dimensions. <strong className="text-slate-400">DWG:</strong> translated
                by Autodesk APS for viewing. Optional — a validated reference set is used if none is provided.
              </div>
            </label>

            <button
              onClick={start}
              disabled={busy}
              className="w-full bg-accent hover:bg-accent-600 text-ink-950 font-semibold rounded-lg px-4 py-3 text-sm disabled:opacity-60"
            >
              {busy ? statusText || "Starting…" : "Run FirstPass →"}
            </button>
          </div>
        </section>
      </div>

      <footer className="px-8 py-4 text-[11px] text-ink-600 border-t border-ink-700 leading-relaxed">
        {DISCLAIMER}
      </footer>
    </main>
  );
}
