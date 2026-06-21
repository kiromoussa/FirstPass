"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import type { ProjectState } from "@/lib/types";
import { projectTypeLabel } from "@/lib/types";
import { ScoreGauge } from "@/components/ScoreGauge";
import { StatusPill } from "@/components/FindingsList";

export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<ProjectState | null>(null);

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => r.json())
      .then(setState)
      .catch(() => {});
  }, [id]);

  const report = state?.report;
  const sourceById = (sid?: string) => state?.sources.find((s) => s.id === sid);

  return (
    <main className="min-h-screen">
      <header className="flex items-center justify-between px-6 py-3 border-b border-ink-700 print:hidden">
        <Link href={`/project/${id}`} className="flex items-center gap-2 group">
          <Image src="/firstpass-mark.png" alt="FirstPass logo" width={24} height={24} priority className="h-6 w-6 object-contain" />
          <span className="text-ink font-bold tracking-tight">FirstPass</span>
        </Link>
        <button
          onClick={() => window.print()}
          className="bg-ink-700 hover:bg-ink-600 text-ink rounded-lg px-4 py-2 text-sm"
        >
          Download / Print PDF
        </button>
      </header>

      <div className="max-w-3xl mx-auto px-8 py-10">
        {!report ? (
          <div className="text-muted">Loading report… (run the project first if this is empty)</div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-6 mb-8">
              <div>
                <h1 className="text-2xl font-semibold text-ink">Permit-Readiness Report</h1>
                <p className="text-sm text-body mt-1">
                  {state?.project.name} · {state?.project.address} · {projectTypeLabel(state?.project.projectType)}
                </p>
                <p className="text-[11px] text-faint mt-1">
                  Generated {new Date(report.generatedAt).toLocaleString()}
                </p>
              </div>
              <ScoreGauge score={report.score} />
            </div>

            <div className="rounded-xl border border-ink-700 bg-ink-900 p-5 mb-8">
              <h2 className="text-xs uppercase tracking-widest text-muted mb-2">Executive summary</h2>
              <p className="text-sm text-body leading-relaxed">{report.summary}</p>
            </div>

            <h2 className="text-xs uppercase tracking-widest text-muted mb-3">Findings</h2>
            <div className="space-y-3 mb-8">
              {report.sections.map((s, i) => {
                const src = sourceById(s.citationSourceId);
                return (
                  <div key={i} className="rounded-lg border border-ink-700 bg-ink-900 p-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <h3 className="text-sm font-medium text-ink">{s.heading}</h3>
                      {s.status && <StatusPill status={s.status} />}
                    </div>
                    <p className="text-sm text-body leading-relaxed">{s.body}</p>
                    {src && (
                      <div className="mt-2 text-[11px] text-faint border-t border-ink-800 pt-2">
                        Cited:{" "}
                        <a href={src.url} target="_blank" rel="noreferrer" className="text-teal hover:underline">
                          {src.title}
                        </a>{" "}
                        · retrieved {new Date(src.retrievedAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <h2 className="text-xs uppercase tracking-widest text-muted mb-3">Required documents</h2>
            <div className="rounded-lg border border-ink-700 bg-ink-900 p-4 mb-8 space-y-2">
              {state?.checklist.map((c) => (
                <div key={c.item} className="flex items-center justify-between text-sm">
                  <span className="text-body">{c.item}</span>
                  <span className={c.present ? "text-accent" : "text-flag-review"}>
                    {c.present ? "✓ present" : "missing"}
                  </span>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-faint leading-relaxed border-t border-ink-700 pt-4">
              {report.disclaimer}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
