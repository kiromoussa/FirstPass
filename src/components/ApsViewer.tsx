"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    Autodesk?: any;
  }
}

const VIEWER_VERSION = "7.*";
const CSS = `https://developer.api.autodesk.com/modelderivative/v2/viewers/${VIEWER_VERSION}/style.min.css`;
const JS = `https://developer.api.autodesk.com/modelderivative/v2/viewers/${VIEWER_VERSION}/viewer3D.min.js`;

function loadScriptOnce(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Autodesk?.Viewing) return resolve();
    if (!document.querySelector(`link[href="${CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = CSS;
      document.head.appendChild(link);
    }
    const existing = document.querySelector(`script[src="${JS}"]`) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject());
      if (window.Autodesk?.Viewing) resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = JS;
    s.onload = () => resolve();
    s.onerror = () => reject();
    document.head.appendChild(s);
  });
}

// Renders the translated DWG via the Autodesk Viewer. Polls translation status,
// then initializes the viewer with a viewables:read token from our API route.
export function ApsViewer({ urn }: { urn: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"translating" | "loading" | "ready" | "error">("translating");
  const [progress, setProgress] = useState("0%");

  useEffect(() => {
    let cancelled = false;
    let viewer: any = null;

    async function run() {
      // 1. Wait for translation to finish.
      for (let i = 0; i < 60 && !cancelled; i++) {
        const r = await fetch(`/api/aps/status?urn=${encodeURIComponent(urn)}`).then((x) => x.json());
        setProgress(r.progress || "");
        if (r.status === "success") break;
        if (r.status === "failed" || r.status === "timeout") {
          setPhase("error");
          return;
        }
        await new Promise((res) => setTimeout(res, 4000));
      }
      if (cancelled) return;
      setPhase("loading");

      // 2. Load the viewer and the document.
      try {
        await loadScriptOnce();
      } catch {
        setPhase("error");
        return;
      }
      const Autodesk = window.Autodesk;
      Autodesk.Viewing.Initializer(
        {
          env: "AutodeskProduction",
          api: "streamingV2",
          getAccessToken: (cb: (t: string, e: number) => void) =>
            fetch("/api/aps/token")
              .then((r) => r.json())
              .then((t) => cb(t.access_token, t.expires_in))
              .catch(() => setPhase("error")),
        },
        () => {
          if (cancelled || !ref.current) return;
          viewer = new Autodesk.Viewing.GuiViewer3D(ref.current);
          viewer.start();
          Autodesk.Viewing.Document.load(
            `urn:${urn}`,
            (doc: any) => {
              const node = doc.getRoot().getDefaultGeometry();
              viewer.loadDocumentNode(doc, node).then(() => setPhase("ready"));
            },
            () => setPhase("error")
          );
        }
      );
    }
    run();
    return () => {
      cancelled = true;
      try {
        viewer?.finish();
      } catch {
        /* noop */
      }
    };
  }, [urn]);

  return (
    <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden border border-ink-700 bg-ink-900">
      <div ref={ref} className="absolute inset-0" />
      {phase !== "ready" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center blueprint-grid text-sm text-blue-200/80">
          {phase === "error" ? (
            <span className="text-flag-warn">Viewer unavailable — showing findings only.</span>
          ) : (
            <>
              <span className="pulse w-3 h-3 rounded-full bg-accent mb-3" />
              <span>{phase === "translating" ? `Autodesk translating DWG… ${progress}` : "Loading model…"}</span>
            </>
          )}
        </div>
      )}
      <div className="absolute top-3 left-3 text-[10px] text-blue-200/70 font-mono pointer-events-none">
        AUTODESK APS · SVF2
      </div>
    </div>
  );
}
