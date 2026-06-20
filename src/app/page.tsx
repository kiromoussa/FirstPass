"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DISCLAIMER } from "@/lib/types";

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState("Maple St. Detached ADU");
  const [address, setAddress] = useState("1421 Maple St, Alameda, CA 94501");
  const [pdfName, setPdfName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, address, pdfName }),
    });
    const { id } = await res.json();
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

            <label className="block text-sm text-slate-300 mb-1">Plan set (PDF)</label>
            <label className="w-full border border-dashed border-ink-600 rounded-lg px-3 py-6 mb-6 text-center text-sm text-slate-400 cursor-pointer hover:border-accent block">
              <input
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => setPdfName(e.target.files?.[0]?.name ?? null)}
              />
              {pdfName ? (
                <span className="text-accent">{pdfName}</span>
              ) : (
                <span>Drag &amp; drop or click to upload your ADU plan set</span>
              )}
              <div className="text-[11px] text-ink-600 mt-1">
                Optional for the demo — a sample Alameda ADU set is used if none is provided.
              </div>
            </label>

            <button
              onClick={start}
              disabled={busy}
              className="w-full bg-accent hover:bg-accent-600 text-ink-950 font-semibold rounded-lg px-4 py-3 text-sm disabled:opacity-60"
            >
              {busy ? "Starting…" : "Run FirstPass →"}
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
