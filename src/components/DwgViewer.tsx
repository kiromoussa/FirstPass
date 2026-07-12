"use client";

import { useCallback, useState } from "react";
import { ApsSheetViewer } from "./ApsSheetViewer";
import { PlanSheetViewer } from "./PlanSheetViewer";

// Plan viewer for a DWG-backed project: the interactive Autodesk pan/zoom
// viewer first, and if APS can't display the translation (translation failed,
// no 2D geometry, SDK blocked), it falls back to the plotted-PNG sheet viewer -
// which is also what PDF uploads (no URN) always use. The PNG path shows the
// exact AutoCAD-plotted sheets the plan reader measured, so the fallback is a
// genuine viewer, not a dead end.
export function DwgViewer({ projectId, urn }: { projectId: string; urn: string }) {
  const [apsFailed, setApsFailed] = useState(false);
  const onUnavailable = useCallback(() => setApsFailed(true), []);

  if (apsFailed) return <PlanSheetViewer projectId={projectId} />;
  return <ApsSheetViewer urn={urn} onUnavailable={onUnavailable} />;
}
