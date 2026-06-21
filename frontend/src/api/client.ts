import type { AnalysisResponse } from "../types";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

export async function analyzeFloorPlan(file: File): Promise<AnalysisResponse> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API_BASE}/api/v1/analyze`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const detail = (error as { detail?: string }).detail ?? response.statusText;
    throw new Error(detail);
  }

  return response.json() as Promise<AnalysisResponse>;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
