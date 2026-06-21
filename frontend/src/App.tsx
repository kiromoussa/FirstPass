import { useEffect, useState } from "react";
import { checkHealth } from "./api/client";
import { ReportView } from "./components/ReportView";
import { UploadForm } from "./components/UploadForm";
import type { AnalysisResponse } from "./types";

export default function App() {
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);

  useEffect(() => {
    checkHealth().then(setApiOnline);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <span className="brand-mark">FP</span>
            <div>
              <h1>FirstPass</h1>
              <p>AI floor plan reviewer</p>
            </div>
          </div>
          <div className={`status-pill ${apiOnline ? "online" : "offline"}`}>
            {apiOnline === null ? "…" : apiOnline ? "API online" : "API offline"}
          </div>
        </div>
      </header>

      <main className="main">
        <section className="hero card">
          <h2>Upload a residential floor plan</h2>
          <p>
            FirstPass accepts PDF, PNG, JPG, or DWG floor plans, converts them to an
            image, extracts rooms, doors, windows, and stairs with a vision model,
            then automatically generates code violations and fix recommendations.
          </p>
          <UploadForm
            onResult={(r) => {
              setError(null);
              setResult(r);
            }}
            onError={setError}
          />
          {error && <p className="error-banner">{error}</p>}
        </section>

        {result && <ReportView result={result} />}
      </main>

      <footer className="footer">
        <p>
          FirstPass is for informational purposes only — not a substitute for
          licensed professional review.
        </p>
      </footer>
    </div>
  );
}
