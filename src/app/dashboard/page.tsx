"use client";

import { useState } from "react";
import { DISCLAIMER } from "@/lib/types";
import { SiteHeader } from "@/components/SiteHeader";
import { NewProjectForm } from "@/components/NewProjectForm";
import { ProjectHistory } from "@/components/ProjectHistory";

export default function DashboardPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="min-h-screen canvas-grid flex flex-col">
      <SiteHeader />

      <main className="flex-1 py-12 lg:py-16">
        <div className="max-w-[1180px] mx-auto px-6 lg:px-10">
          <div className="mb-10">
            <div className="font-mono text-[12px] tracking-[0.14em] uppercase text-teal mb-3">Dashboard</div>
            <h1 className="font-display text-[34px] font-bold text-ink tracking-[-0.03em]">
              Run a pre-submission review.
            </h1>
            <p className="mt-2 text-body text-[15px] max-w-xl">
              Create a new permit review or open a previous project.
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-8 lg:gap-12 items-start">
            <div id="projects">
              <ProjectHistory refreshKey={refreshKey} />
            </div>
            <div id="new-project" className="lg:sticky lg:top-24">
              <NewProjectForm onCreated={() => setRefreshKey((k) => k + 1)} />
            </div>
          </div>
        </div>
      </main>

      <footer className="mt-auto border-t border-hairline bg-deep/60">
        <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-6">
          <p className="text-[11px] text-muted leading-relaxed max-w-3xl">{DISCLAIMER}</p>
        </div>
      </footer>
    </div>
  );
}
