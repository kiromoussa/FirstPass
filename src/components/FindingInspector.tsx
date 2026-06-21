"use client";

import type { Finding, Source } from "@/lib/types";
import { STATUS_META } from "@/lib/ui";
import { StatusPill } from "./FindingsList";

export function FindingInspector({
  finding,
  source,
  onClose,
}: {
  finding: Finding | null;
  source: Source | undefined;
  onClose: () => void;
}) {
  if (!finding) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <aside className="fixed right-0 top-0 h-full w-[400px] max-w-[92vw] bg-ink-900 border-l border-ink-700 z-50 overflow-y-auto scrollbar-thin">
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-700 sticky top-0 bg-ink-900">
          <h3 className="text-sm font-semibold text-ink">{finding.title}</h3>
          <button onClick={onClose} className="text-muted hover:text-ink text-lg leading-none">×</button>
        </div>

        <div className="px-5 py-4 space-y-5">
          <div className="flex items-center gap-2">
            <StatusPill status={finding.status} />
            {finding.corrected && finding.previousStatus && (
              <span className="text-[11px] text-body">
                corrected from{" "}
                <span style={{ color: STATUS_META[finding.previousStatus].color }}>
                  {STATUS_META[finding.previousStatus].label}
                </span>{" "}
                by Reviewer
              </span>
            )}
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted mb-1">Result</div>
            <p className="text-sm text-body">{finding.message}</p>
          </div>

          {finding.suggestedCorrection && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-muted mb-1">Suggested correction</div>
              <p className="text-sm text-accent leading-relaxed">{finding.suggestedCorrection}</p>
            </div>
          )}

          {finding.codeText && (
            <div className="rounded-lg border border-ink-700 bg-ink-800/50 p-3">
              <div className="text-[10px] uppercase tracking-widest text-muted mb-1">
                Retrieved code · Hybrid RAG · RedisVL
              </div>
              {finding.codeSection && (
                <div className="text-xs font-medium text-body mb-1">{finding.codeSection}</div>
              )}
              <p className="text-xs text-body italic border-l-2 border-accent/40 pl-2">
                “{finding.codeText}”
              </p>
            </div>
          )}

          {source && (
            <div className="rounded-lg border border-ink-700 bg-ink-800/50 p-3">
              <div className="text-[10px] uppercase tracking-widest text-muted mb-1">Evidence · official source</div>
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-teal hover:underline break-words"
              >
                {source.title}
              </a>
              <p className="text-xs text-body mt-2 italic border-l-2 border-ink-600 pl-2">
                “{source.excerpt}”
              </p>
              <div className="flex items-center justify-between mt-2 text-[10px] text-faint">
                <span>{source.live ? "fetched live" : "cached"}</span>
                <span>retrieved {new Date(source.retrievedAt).toLocaleString()}</span>
              </div>
              <div className="mt-1 text-[10px] text-faint">
                authority {(source.authorityScore * 100).toFixed(0)}%
              </div>
            </div>
          )}

          {finding.evals && finding.evals.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-muted mb-2">Arize evals</div>
              <div className="space-y-1.5">
                {finding.evals.map((e) => (
                  <div key={e.dimension} className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${e.passed ? "bg-accent" : "bg-flag-fail"}`} />
                    <span className="text-xs text-body capitalize w-24">{e.dimension}</span>
                    <span className="text-xs font-mono text-body">{(e.score * 100).toFixed(0)}%</span>
                    <span className="text-[10px] text-faint flex-1 truncate" title={e.rationale}>
                      {e.rationale}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
