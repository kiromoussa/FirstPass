"use client";

import { useEffect, useState } from "react";
import { PROJECT_TYPES, type ProjectType } from "@/lib/types";

type CityOption = { slug: string; label: string };

type Props = {
  onCreated?: () => void;
};

export function NewProjectForm({ onCreated }: Props) {
  const [name, setName] = useState("92nd St. Detached ADU");
  const [address, setAddress] = useState("1216 E 92nd St, Los Angeles, CA 90002");
  const [projectType, setProjectType] = useState<ProjectType>("detached_adu");
  const [cities, setCities] = useState<CityOption[]>([]);
  const [citySlug, setCitySlug] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/cities")
      .then((r) => r.json())
      .then((j) => {
        const list: CityOption[] = (j.cities ?? []).map((c: { slug: string; label: string }) => ({
          slug: c.slug,
          label: c.label,
        }));
        setCities(list);
      })
      .catch(() => {});
  }, []);

  // Keep jurisdiction aligned with the address (LA address → los-angeles-ca).
  useEffect(() => {
    if (!cities.length || !address.trim()) return;
    const a = address.toLowerCase();
    const match = cities.find((c) => {
      const cityName = c.label.split(",")[0]?.trim().toLowerCase();
      return cityName && cityName.length > 2 && a.includes(cityName);
    });
    if (match) setCitySlug(match.slug);
  }, [address, cities]);

  async function start() {
    setBusy(true);
    setError(null);

    const name_l = file?.name.toLowerCase() ?? "";
    const isDwg = /\.(dwg|dxf)$/.test(name_l) || /acad|dxf/i.test(file?.type ?? "");
    const isVision = !!file && !isDwg && /\.(pdf|png|jpe?g)$/.test(name_l);

    try {
      let id: string;

      if (file && isDwg) {
        setStatusText("Uploading DWG to Autodesk APS…");
        const fd = new FormData();
        fd.append("file", file);
        const up = await fetch("/api/aps/upload", { method: "POST", body: fd });
        const upj = (await up.json()) as {
          ok?: boolean;
          urn?: string;
          error?: string;
          reason?: string;
        };
        if (!up.ok || !upj.ok || !upj.urn) {
          throw new Error(
            upj.error ??
              upj.reason ??
              "DWG upload to Autodesk failed — check APS credentials in .env.local"
          );
        }

        setStatusText("Creating project…");
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            address,
            citySlug: citySlug || undefined,
            projectType,
            apsUrn: upj.urn,
            dwgName: file.name,
          }),
        });
        const data = (await res.json()) as { id?: string; error?: string };
        if (!res.ok || !data.id) {
          throw new Error(data.error ?? "Could not create project");
        }
        id = data.id;

        setStatusText("Saving DWG to project…");
        const stageFd = new FormData();
        stageFd.append("file", file);
        stageFd.append("projectId", id);
        const stage = await fetch("/api/dwg/stage", { method: "POST", body: stageFd });
        const stageJ = (await stage.json()) as { ok?: boolean; reason?: string };
        if (!stage.ok || !stageJ.ok) {
          throw new Error(stageJ.reason ?? "Could not save DWG file to the project workspace");
        }
      } else {
        setStatusText("Creating project…");
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            address,
            citySlug: citySlug || undefined,
            projectType,
          }),
        });
        const data = (await res.json()) as { id?: string; error?: string };
        if (!res.ok || !data.id) {
          throw new Error(data.error ?? "Could not create project");
        }
        id = data.id;
      }

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

      onCreated?.();
      setStatusText("Opening project…");
      // Full navigation avoids dev-server HMR 404s mid-submit on /dashboard.
      window.location.assign(`/project/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="surface-card p-8 shadow-card">
      <div className="flex items-center gap-3 mb-6">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal/15 text-teal text-sm font-bold">
          +
        </span>
        <div>
          <h2 className="font-display text-lg font-bold text-ink">New project</h2>
          <p className="text-xs text-muted">Upload plans and start a permit review</p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-body mb-1.5">Project name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input-field"
            placeholder="e.g. Backyard ADU, 92nd St"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-body mb-1.5">Jurisdiction</label>
          <select
            value={citySlug}
            onChange={(e) => setCitySlug(e.target.value)}
            className="input-field"
          >
            {cities.length === 0 && <option value="">Loading jurisdictions…</option>}
            {cities.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-body mb-1.5">Project address</label>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="input-field"
            placeholder="Full street address"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-body mb-1.5">Project type</label>
          <select
            value={projectType}
            onChange={(e) => setProjectType(e.target.value as ProjectType)}
            className="input-field"
          >
            {PROJECT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-body mb-1.5">Plan set (PDF or DWG)</label>
          <label className="w-full border border-dashed border-hairline rounded-xl px-4 py-8 text-center text-sm text-muted cursor-pointer hover:border-teal/40 hover:bg-teal/5 transition-all block">
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.dwg,.dxf,application/pdf,application/acad,image/vnd.dwg,application/dxf"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <span className="text-teal font-medium">{file.name}</span>
            ) : (
              <>
                <span className="text-body">Drop your plan set here or click to browse</span>
                <div className="text-[11px] text-muted mt-2 max-w-xs mx-auto leading-relaxed">
                  <strong className="text-body/80">PDF recommended</strong>: Claude reads sheets directly.
                  DWG is translated via Autodesk APS. Optional. A reference set is used if none provided.
                </div>
              </>
            )}
          </label>
        </div>

        {error && (
          <p className="text-sm text-flag-fail bg-flag-fail/10 border border-flag-fail/30 rounded-xl px-4 py-3">
            {error}
          </p>
        )}

        <button onClick={start} disabled={busy} className="btn-primary w-full mt-2">
          {busy ? statusText || "Starting…" : "Run FirstPass →"}
        </button>
      </div>
    </div>
  );
}
