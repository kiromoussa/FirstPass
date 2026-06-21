"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Project, Phase } from "@/lib/types";
import { PROJECT_TYPES } from "@/lib/types";
import { scoreColor } from "@/lib/ui";

const PHASE_LABELS: Record<Phase, string> = {
  created: "Created",
  jurisdiction: "Jurisdiction",
  research: "Research",
  read: "Plan reading",
  comply: "Compliance",
  review: "Review",
  report: "Report",
  done: "Complete",
  error: "Error",
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function projectTypeLabel(type: Project["projectType"]): string {
  return PROJECT_TYPES.find((t) => t.value === type)?.label ?? type;
}

type Props = {
  refreshKey?: number;
};

export function ProjectHistory({ refreshKey }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      setProjects(data.projects ?? []);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function handleDelete(id: string) {
    setDeleting(id);
    try {
      await fetch(`/api/projects/${id}`, { method: "DELETE" });
      setProjects((prev) => prev.filter((p) => p.id !== id));
      setConfirmId(null);
    } catch {
      /* ignore */
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="surface-card p-8 shadow-card">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-rich text-teal text-sm">
            ◫
          </span>
          <div>
            <h2 className="font-display text-lg font-bold text-ink">Your projects</h2>
            <p className="text-xs text-muted">
              {loading ? "Loading…" : `${projects.length} project${projects.length === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="btn-ghost text-xs"
          aria-label="Refresh projects"
        >
          Refresh
        </button>
      </div>

      {loading && projects.length === 0 && (
        <div className="py-12 text-center text-muted text-sm">Loading projects…</div>
      )}

      {!loading && projects.length === 0 && (
        <div className="py-12 text-center border border-dashed border-hairline rounded-xl">
          <p className="text-body text-sm">No projects yet</p>
          <p className="text-muted text-xs mt-1">Create your first review above to get started.</p>
        </div>
      )}

      <ul className="space-y-3">
        {projects.map((p) => (
          <li
            key={p.id}
            className="group flex flex-col sm:flex-row sm:items-center gap-4 p-4 rounded-xl border border-hairline bg-deep/40 hover:border-teal/25 hover:bg-rich/20 transition-all"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-medium text-ink truncate">{p.name}</h3>
                <StatusBadge status={p.status} />
                {p.score != null && (
                  <span
                    className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={{
                      color: scoreColor(p.score),
                      background: `${scoreColor(p.score)}18`,
                    }}
                  >
                    {p.score}%
                  </span>
                )}
              </div>
              <p className="text-xs text-muted mt-1 truncate">{p.address}</p>
              <p className="text-[11px] text-muted/70 mt-0.5">
                {projectTypeLabel(p.projectType)} · {formatDate(p.createdAt)}
              </p>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {confirmId === p.id ? (
                <>
                  <span className="text-xs text-flag-fail mr-1">Delete?</span>
                  <button
                    onClick={() => handleDelete(p.id)}
                    disabled={deleting === p.id}
                    className="text-xs px-3 py-1.5 rounded-lg bg-flag-fail/20 text-flag-fail hover:bg-flag-fail/30 transition-colors disabled:opacity-50"
                  >
                    {deleting === p.id ? "Deleting…" : "Confirm"}
                  </button>
                  <button
                    onClick={() => setConfirmId(null)}
                    className="btn-ghost text-xs py-1.5"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <Link
                    href={`/project/${p.id}`}
                    className="text-xs px-4 py-2 rounded-lg bg-teal/15 text-teal hover:bg-teal/25 font-medium transition-colors"
                  >
                    Open →
                  </Link>
                  {p.status === "done" && (
                    <Link
                      href={`/project/${p.id}/report`}
                      className="btn-ghost text-xs py-2"
                    >
                      Report
                    </Link>
                  )}
                  <button
                    onClick={() => setConfirmId(p.id)}
                    className="text-xs px-3 py-2 rounded-lg text-muted hover:text-flag-fail hover:bg-flag-fail/10 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label={`Delete ${p.name}`}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: Phase }) {
  const done = status === "done";
  const error = status === "error";
  const inProgress = !done && !error && status !== "created";

  return (
    <span
      className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-medium ${
        done
          ? "bg-teal/15 text-teal"
          : error
            ? "bg-flag-fail/15 text-flag-fail"
            : inProgress
              ? "bg-flag-review/15 text-flag-review blink"
              : "bg-rich text-muted"
      }`}
    >
      {PHASE_LABELS[status] ?? status}
    </span>
  );
}
