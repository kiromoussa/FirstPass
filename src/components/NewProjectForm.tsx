"use client";

import { useEffect, useState } from "react";
import { upload } from "@vercel/blob/client";
import { PROJECT_TYPES, DEFAULT_PROJECT_TYPE, type ProjectType } from "@/lib/types";

type CityOption = { slug: string; label: string };

const FALLBACK_CITIES: CityOption[] = [
  { slug: "los-angeles-ca", label: "Los Angeles, CA" },
  { slug: "alameda-ca", label: "Alameda, CA" },
];

const STEPS = [
  { title: "Project", hint: "Name and type" },
  { title: "Location", hint: "Address and jurisdiction" },
  { title: "Plans", hint: "Upload the plan set" },
  { title: "Run", hint: "Review and start" },
] as const;

type Props = {
  onCreated?: () => void;
};

export function NewProjectForm({ onCreated }: Props) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>(DEFAULT_PROJECT_TYPE);
  const [cities, setCities] = useState<CityOption[]>([]);
  const [citySlug, setCitySlug] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (!cancelled) {
        setCities((prev) => (prev.length ? prev : FALLBACK_CITIES));
      }
    }, 4_000);

    fetch("/api/cities", { signal: AbortSignal.timeout(8_000) })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const list: CityOption[] = (j.cities ?? []).map((c: { slug: string; label: string }) => ({
          slug: c.slug,
          label: c.label,
        }));
        setCities(list.length ? list : FALLBACK_CITIES);
      })
      .catch(() => {
        if (!cancelled) setCities(FALLBACK_CITIES);
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
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

  const stepValid = (s: number): boolean => {
    if (s === 0) return name.trim().length > 0;
    if (s === 1) return address.trim().length > 0 && !!citySlug;
    if (s === 2) return !!file;
    return true;
  };

  const next = () => {
    setError(null);
    if (!stepValid(step)) {
      setError(
        step === 0
          ? "Give the project a name to continue."
          : step === 1
            ? "Enter the project address and pick a jurisdiction."
            : "Attach the plan set (PDF or DWG). FirstPass measures your actual drawings - it cannot check a project without them."
      );
      return;
    }
    setStep((v) => Math.min(v + 1, STEPS.length - 1));
  };
  const back = () => {
    setError(null);
    setStep((v) => Math.max(v - 1, 0));
  };

  async function start() {
    // A plan set is required. Running without one used to fall back to the
    // demo reference facts and grade numbers the user never uploaded.
    if (!file) {
      setError("Attach the plan set before running.");
      setStep(2);
      return;
    }
    setBusy(true);
    setError(null);

    const name_l = file.name.toLowerCase();
    const isDwg = /\.(dwg|dxf)$/.test(name_l) || /acad|dxf/i.test(file.type ?? "");
    const isVision = !isDwg && /\.(pdf|png|jpe?g)$/.test(name_l);

    try {
      let id: string;

      if (isDwg) {
        setStatusText("Uploading DWG…");
        // Uploaded straight to Blob from the browser (not through a Function
        // body) since Vercel caps request bodies at 4.5MB and real DWGs
        // routinely exceed that.
        const blob = await upload(`dwg-uploads/${Date.now()}-${file.name}`, file, {
          access: "private",
          handleUploadUrl: "/api/blob/dwg-token",
        });

        setStatusText("Translating DWG in Autodesk APS…");
        const up = await fetch("/api/aps/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blobUrl: blob.url, fileName: file.name }),
        });
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
        const stage = await fetch("/api/dwg/stage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blobUrl: blob.url, fileName: file.name, projectId: id }),
        });
        const stageJ = (await stage.json()) as { ok?: boolean; reason?: string };
        if (!stage.ok || !stageJ.ok) {
          throw new Error(stageJ.reason ?? "Could not save DWG file to the project workspace");
        }
      } else if (isVision) {
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

        // The upload must succeed before the run starts. Swallowing a failure
        // here used to let the pipeline run with no plan attached and report
        // reference-set numbers as if they were measured off this project.
        setStatusText("Uploading plan set for the reader…");
        const fd = new FormData();
        fd.append("file", file);
        fd.append("projectId", id);
        const upRes = await fetch("/api/plans/upload", { method: "POST", body: fd });
        const upJson = (await upRes.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
        if (!upRes.ok || !upJson.ok) {
          throw new Error(
            upJson.reason ?? "Plan upload failed — the run was not started. Try again or use a smaller PDF."
          );
        }
      } else {
        throw new Error("Unsupported file type. Upload a PDF, PNG, JPG, DWG, or DXF plan set.");
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
      <div className="mb-6">
        <h2 className="font-display text-lg font-bold text-ink">New project</h2>
        <p className="text-xs text-muted">
          Step {step + 1} of {STEPS.length}: {STEPS[step].hint}
        </p>
      </div>

      <ol className="flex items-center gap-2 mb-6" aria-label="Steps">
        {STEPS.map((s, i) => {
          const reachable = i <= step || STEPS.slice(0, i).every((_, j) => stepValid(j));
          return (
            <li key={s.title} className="flex-1">
              <button
                type="button"
                onClick={() => reachable && !busy && setStep(i)}
                className={`w-full cursor-pointer rounded-lg px-2 py-2 text-center border transition-all ${
                  i === step
                    ? "border-teal/60 bg-teal/10 text-teal"
                    : i < step
                      ? "border-hairline bg-teal/5 text-body"
                      : "border-hairline text-muted"
                }`}
              >
                <span className="block font-mono text-[10px] tracking-[0.12em] uppercase">
                  {i + 1}
                </span>
                <span className="block text-[11px] font-medium">{s.title}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="space-y-4">
        {step === 0 && (
          <>
            <div>
              <label className="block text-xs font-medium text-body mb-1.5">Project name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input-field"
                placeholder="e.g. Oak St. TI, 92nd St Addition"
                autoFocus
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
          </>
        )}

        {step === 1 && (
          <>
            <div>
              <label className="block text-xs font-medium text-body mb-1.5">Project address</label>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="input-field"
                placeholder="Full street address"
                autoFocus
              />
              <p className="text-[11px] text-muted mt-1.5">
                The address picks the jurisdiction whose code your plans are checked against.
              </p>
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
                {cities.length > 0 && !citySlug && <option value="">Select jurisdiction…</option>}
              </select>
            </div>
          </>
        )}

        {step === 2 && (
          <div>
            <label className="block text-xs font-medium text-body mb-1.5">
              Plan set (PDF or DWG) - required
            </label>
            <label className="w-full border border-dashed border-hairline rounded-xl px-4 py-8 text-center text-sm text-muted cursor-pointer hover:border-teal/40 hover:bg-teal/5 transition-all block">
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.dwg,.dxf,application/pdf,application/acad,image/vnd.dwg,application/dxf"
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <span className="text-teal font-medium">{file.name}</span>
              ) : (
                <>
                  <span className="text-body">Drop your plan set here or click to browse</span>
                  <div className="text-[11px] text-muted mt-2 max-w-xs mx-auto leading-relaxed">
                    <strong className="text-body/80">PDF recommended</strong>: the plan reader reads
                    sheets directly. DWG is translated via Autodesk APS. Include the site plan -
                    setbacks and lot coverage can only be verified from it.
                  </div>
                </>
              )}
            </label>
          </div>
        )}

        {step === 3 && (
          <dl className="rounded-xl border border-hairline divide-y divide-hairline text-sm">
            {[
              ["Project", name.trim() || "-"],
              ["Type", PROJECT_TYPES.find((t) => t.value === projectType)?.label ?? projectType],
              ["Address", address.trim() || "-"],
              ["Jurisdiction", cities.find((c) => c.slug === citySlug)?.label ?? "-"],
              ["Plan set", file?.name ?? "-"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="text-body text-right truncate">{v}</dd>
              </div>
            ))}
          </dl>
        )}

        {error && (
          <p className="text-sm text-flag-fail bg-flag-fail/10 border border-flag-fail/30 rounded-xl px-4 py-3">
            {error}
          </p>
        )}

        <div className="flex gap-3 mt-2">
          {step > 0 && (
            <button
              onClick={back}
              disabled={busy}
              className="cursor-pointer rounded-xl border border-hairline px-5 py-2.5 text-sm font-medium text-body hover:bg-teal/5 transition-all"
            >
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button onClick={next} disabled={busy} className="btn-primary flex-1 cursor-pointer">
              Continue
            </button>
          ) : (
            <button onClick={start} disabled={busy} className="btn-primary flex-1 cursor-pointer">
              {busy ? statusText || "Starting…" : "Run FirstPass →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
