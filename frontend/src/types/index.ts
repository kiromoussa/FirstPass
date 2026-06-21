export type IssueSeverity = "info" | "warning" | "critical";

export interface Room {
  name: string;
  label?: string | null;
  approximate_area_sqft?: number | null;
  notes?: string | null;
}

export interface Door {
  location: string;
  connects: string[];
  swing_direction?: string | null;
  notes?: string | null;
}

export interface Window {
  location: string;
  room?: string | null;
  notes?: string | null;
}

export interface Stair {
  location: string;
  direction?: string | null;
  notes?: string | null;
}

export interface Dimension {
  label: string;
  value: string;
  unit: string;
  location?: string | null;
}

export interface ExtractedElements {
  rooms: Room[];
  doors: Door[];
  windows: Window[];
  stairs: Stair[];
  dimensions: Dimension[];
  potential_issues: string[];
}

export interface Issue {
  category: string;
  severity: IssueSeverity;
  title: string;
  description: string;
  recommendation?: string | null;
  code_reference?: string | null;
}

export interface DrawingLocation {
  sheet: string;
  area: string;
  bbox: number[] | null;
  annotation_text: string;
}

export interface Recommendation {
  violation: string;
  code_section: string;
  severity: string;
  recommended_fix: string;
  design_adjustment: string;
  drawing_location: DrawingLocation;
  confidence: string;
  notes: string;
}

export interface Violation {
  code_section: string;
  issue: string;
  location?: string | null;
  evidence?: string | null;
  severity: string;
}

export interface AnalysisResponse {
  analysis_id: string;
  filename: string;
  pages_analyzed: number;
  extracted_elements: ExtractedElements;
  issues: Issue[];
  violations: Violation[];
  recommendations: Recommendation[];
  recommendations_error?: string | null;
  report_markdown: string;
}
