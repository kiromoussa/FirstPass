import { useCallback, useState } from "react";
import { analyzeFloorPlan } from "../api/client";

const ACCEPTED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".dwg"] as const;
const ACCEPTED_INPUT = ".pdf,.png,.jpg,.jpeg,.dwg,application/pdf,image/png,image/jpeg";

function isAcceptedFile(file: File): boolean {
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
  return extension ? ACCEPTED_EXTENSIONS.includes(extension as (typeof ACCEPTED_EXTENSIONS)[number]) : false;
}

interface UploadFormProps {
  onResult: (result: Awaited<ReturnType<typeof analyzeFloorPlan>>) => void;
  onError: (message: string) => void;
}

export function UploadForm({ onResult, onError }: UploadFormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!file) return;

      setLoading(true);
      try {
        const result = await analyzeFloorPlan(file);
        onResult(result);
      } catch (err) {
        onError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setLoading(false);
      }
    },
    [file, onResult, onError],
  );

  const handleFileSelect = useCallback(
    (selected: File | null) => {
      if (selected && isAcceptedFile(selected)) {
        setFile(selected);
      }
    },
    [],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      handleFileSelect(e.dataTransfer.files[0] ?? null);
    },
    [handleFileSelect],
  );

  return (
    <form className="upload-form" onSubmit={handleSubmit}>
      <div
        className={`dropzone ${dragOver ? "dropzone--active" : ""} ${file ? "dropzone--has-file" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <input
          id="file-input"
          type="file"
          accept={ACCEPTED_INPUT}
          onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
          hidden
        />
        <label htmlFor="file-input" className="dropzone-label">
          {file ? (
            <>
              <span className="dropzone-filename">{file.name}</span>
              <span className="dropzone-hint">Click or drop to replace</span>
            </>
          ) : (
            <>
              <span className="dropzone-title">Drop your floor plan here</span>
              <span className="dropzone-hint">
                PDF, PNG, JPG, or DWG — or click to browse
              </span>
            </>
          )}
        </label>
      </div>

      <button type="submit" className="btn-primary" disabled={!file || loading}>
        {loading ? "Analyzing…" : "Analyze Floor Plan"}
      </button>
    </form>
  );
}
