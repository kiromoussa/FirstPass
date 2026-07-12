"use client";

import { useEffect, useRef, useState } from "react";

// Interactive Autodesk APS (Forge) viewer with native pan/zoom for the
// translated DWG, restored to match the approach that works in CADAI. Two bugs
// sank the previous FirstPass attempt (removed in d739d7e): it initialized with
// env "AutodeskProduction" (the SVF v1 runtime) while the DWG is translated to
// SVF2, and it grabbed root.search({type:"geometry"})[0] - the first geometry
// node, unfiltered - instead of a real 2D sheet. Both produced the "we can't
// display this item" page. This version uses the SVF2 environment and selects
// role:"2d" geometry, exactly like CADAI's ForgeViewer.
//
// On any hard failure it calls onUnavailable so the parent can fall back to the
// plotted-PNG viewer (which also covers PDF uploads, where there is no URN).

declare global {
  interface Window {
    Autodesk?: any;
  }
}

const VIEWER_VERSION = "7.*";
const CSS = `https://developer.api.autodesk.com/modelderivative/v2/viewers/${VIEWER_VERSION}/style.min.css`;
const JS = `https://developer.api.autodesk.com/modelderivative/v2/viewers/${VIEWER_VERSION}/viewer3D.min.js`;

// SVF2 sheets load with modelSpace geometry; preserveView false so each sheet
// fits fresh. Matches CADAI's LOAD_2D_OPTIONS.
const LOAD_2D_OPTIONS = { preserveView: false, modelSpace: true } as const;

function loadViewerSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    if (window.Autodesk?.Viewing) return resolve();
    if (!document.querySelector(`link[href="${CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = CSS;
      document.head.appendChild(link);
    }
    const existing = document.querySelector(`script[src="${JS}"]`) as HTMLScriptElement | null;
    if (existing) {
      if (window.Autodesk?.Viewing) return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("sdk load error")));
      return;
    }
    const s = document.createElement("script");
    s.src = JS;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("sdk load error"));
    document.head.appendChild(s);
  });
}

interface Sheet {
  name: string;
  node: any;
}

// Best-effort 2D navigation polish (each is guarded - method availability
// varies across viewer 7.x builds). GuiViewer3D already gives drag-pan and
// scroll-zoom out of the box; these just make zoom track the cursor.
function tune2dNavigation(viewer: any): void {
  const nav = viewer?.navigation;
  if (!nav) return;
  try { nav.setZoomTowardsPivot?.(true); } catch { /* noop */ }
  try { nav.setReverseZoomDirection?.(false); } catch { /* noop */ }
  try { nav.setNavigationLock?.(false); } catch { /* noop */ }
}

function nodeName(node: any, index: number): string {
  try {
    const n = typeof node?.name === "function" ? node.name() : node?.data?.name;
    if (typeof n === "string" && n.trim()) return n.trim();
  } catch {
    /* fall through */
  }
  return `Sheet ${index + 1}`;
}

export function ApsSheetViewer({
  urn,
  onUnavailable,
}: {
  urn: string;
  onUnavailable?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const docRef = useRef<any>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [active, setActive] = useState(0);
  const [phase, setPhase] = useState<"translating" | "loading" | "ready" | "error">("translating");
  const [progress, setProgress] = useState("");

  useEffect(() => {
    let cancelled = false;
    let sized = false;
    let resizeObs: ResizeObserver | null = null;

    const fail = () => {
      if (cancelled) return;
      setPhase("error");
      onUnavailable?.();
    };

    async function run() {
      // 1. Wait for Autodesk translation to finish (kicked off at upload).
      for (let i = 0; i < 75 && !cancelled; i++) {
        let r: { status?: string; progress?: string } = {};
        try {
          r = await fetch(`/api/aps/status?urn=${encodeURIComponent(urn)}`).then((x) => x.json());
        } catch {
          /* transient - retry */
        }
        setProgress(r.progress ?? "");
        if (r.status === "success") break;
        if (r.status === "failed" || r.status === "timeout") return fail();
        await new Promise((res) => setTimeout(res, 4000));
      }
      if (cancelled) return;

      // 2. The container must have real size before the viewer boots, or the
      //    canvas comes up 0x0 and never recovers.
      await new Promise<void>((resolve) => {
        const el = containerRef.current;
        if (!el) return resolve();
        if (el.clientWidth >= 40 && el.clientHeight >= 40) {
          sized = true;
          return resolve();
        }
        resizeObs = new ResizeObserver(() => {
          const c = containerRef.current;
          if (c && c.clientWidth >= 40 && c.clientHeight >= 40 && !sized) {
            sized = true;
            resolve();
          }
        });
        resizeObs.observe(el);
      });
      if (cancelled) return;
      setPhase("loading");

      // 3. Load the SDK and initialize against the SVF2 runtime.
      try {
        await loadViewerSdk();
      } catch {
        return fail();
      }
      const Autodesk = window.Autodesk;
      if (!Autodesk?.Viewing) return fail();

      Autodesk.Viewing.Initializer(
        {
          env: "AutodeskProduction2",
          api: "streamingV2",
          getAccessToken: (cb: (t: string, e: number) => void) =>
            fetch("/api/aps/token")
              .then((r) => r.json())
              .then((t) => cb(t.access_token, t.expires_in))
              .catch(() => fail()),
        },
        () => {
          if (cancelled || !containerRef.current) return;
          const viewer = new Autodesk.Viewing.GuiViewer3D(containerRef.current, { extensions: [] });
          viewerRef.current = viewer;
          viewer.start();
          try { viewer.setTheme?.("dark-theme"); } catch { /* noop */ }

          Autodesk.Viewing.Document.load(
            `urn:${urn}`,
            (doc: any) => {
              if (cancelled) return;
              docRef.current = doc;
              const root = doc.getRoot();
              // Every renderable 2D sheet - paper layouts AND the model-space
              // "2D Views" node (which is how the model-space drawings show up).
              let nodes: any[] =
                root.search?.({ type: "geometry", role: "2d" }, true) ??
                root.search?.({ type: "geometry", role: "2d" }) ??
                [];
              if (!nodes.length) {
                const def = root.getDefaultGeometry?.();
                if (def) nodes = [def];
              }
              if (!nodes.length) return fail();

              const list: Sheet[] = nodes.map((node, i) => ({ name: nodeName(node, i), node }));
              setSheets(list);
              setActive(0);
              viewer
                .loadDocumentNode(doc, list[0].node, LOAD_2D_OPTIONS)
                .then(() => {
                  if (cancelled) return;
                  tune2dNavigation(viewer);
                  setPhase("ready");
                })
                .catch(() => fail());
            },
            () => fail()
          );
        },
        () => fail()
      );

      // 4. Keep the viewer canvas matched to its container.
      if (containerRef.current) {
        const ro = new ResizeObserver(() => {
          try { viewerRef.current?.resize?.(); } catch { /* noop */ }
        });
        ro.observe(containerRef.current);
        resizeObs = ro;
      }
    }

    void run();
    return () => {
      cancelled = true;
      resizeObs?.disconnect();
      try { viewerRef.current?.finish?.(); } catch { /* noop */ }
      viewerRef.current = null;
    };
  }, [urn, onUnavailable]);

  // Switch sheets without re-loading the whole document.
  const showSheet = (i: number) => {
    const viewer = viewerRef.current;
    const doc = docRef.current;
    const sheet = sheets[i];
    if (!viewer || !doc || !sheet) return;
    setActive(i);
    viewer
      .loadDocumentNode(doc, sheet.node, LOAD_2D_OPTIONS)
      .then(() => tune2dNavigation(viewer))
      .catch(() => {
        /* keep the current sheet up; switching failed */
      });
  };

  return (
    <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden border border-ink-700 bg-deep-900">
      <div className="absolute inset-0 flex flex-col">
        <div ref={containerRef} className="relative flex-1 min-h-0 blueprint-grid" />
        {phase === "ready" && sheets.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-thin px-3 py-2 bg-deep-800 border-t border-ink-700">
            {sheets.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => showSheet(i)}
                className={`text-[10px] font-mono whitespace-nowrap px-2 py-1 rounded cursor-pointer ${
                  i === active ? "bg-accent text-white" : "text-muted hover:text-ink bg-ink-700"
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {phase !== "ready" && phase !== "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center blueprint-grid text-sm text-blue-200/80 pointer-events-none">
          <span className="pulse w-3 h-3 rounded-full bg-accent mb-3" />
          <span>
            {phase === "translating"
              ? `Autodesk translating DWG${progress ? ` - ${progress}` : ""}…`
              : "Loading interactive drawing…"}
          </span>
        </div>
      )}

      <div className="absolute top-3 left-3 text-[10px] text-blue-200/70 font-mono pointer-events-none">
        AUTODESK APS · SVF2 · drag to pan, scroll to zoom
      </div>
    </div>
  );
}
