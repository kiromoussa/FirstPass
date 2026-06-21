import ReactMarkdown from "react-markdown";
import type { AnalysisResponse, IssueSeverity } from "../types";

interface ReportViewProps {
  result: AnalysisResponse;
}

const SEVERITY_CLASS: Record<IssueSeverity, string> = {
  info: "badge-info",
  warning: "badge-warning",
  critical: "badge-critical",
};

export function ReportView({ result }: ReportViewProps) {
  const { extracted_elements: elements, issues, violations, recommendations } = result;

  return (
    <div className="report">
      <header className="report-header">
        <h2>{result.filename}</h2>
        <p className="report-meta">
          {result.pages_analyzed} page{result.pages_analyzed !== 1 ? "s" : ""} analyzed
          · ID {result.analysis_id.slice(0, 8)}
        </p>
      </header>

      <div className="report-grid">
        <section className="card">
          <h3>Extracted Elements</h3>
          <dl className="stats">
            <div>
              <dt>Rooms</dt>
              <dd>{elements.rooms.length}</dd>
            </div>
            <div>
              <dt>Doors</dt>
              <dd>{elements.doors.length}</dd>
            </div>
            <div>
              <dt>Windows</dt>
              <dd>{elements.windows.length}</dd>
            </div>
            <div>
              <dt>Stairs</dt>
              <dd>{elements.stairs.length}</dd>
            </div>
          </dl>

          {elements.rooms.length > 0 && (
            <ul className="element-list">
              {elements.rooms.map((room) => (
                <li key={room.name}>
                  <strong>{room.name}</strong>
                  {room.approximate_area_sqft != null && (
                    <span> — ~{room.approximate_area_sqft} sq ft</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h3>Issues ({issues.length})</h3>
          {issues.length === 0 ? (
            <p className="muted">No issues identified.</p>
          ) : (
            <ul className="issue-list">
              {issues.map((issue, i) => (
                <li key={i} className="issue-item">
                  <span className={`badge ${SEVERITY_CLASS[issue.severity]}`}>
                    {issue.severity}
                  </span>
                  <strong>{issue.title}</strong>
                  <p>{issue.description}</p>
                  {issue.recommendation && (
                    <p className="recommendation">{issue.recommendation}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card">
        <h3>Code Violations ({violations.length})</h3>
        {violations.length === 0 ? (
          <p className="muted">No violations detected for recommendation generation.</p>
        ) : (
          <ul className="issue-list">
            {violations.map((violation, i) => (
              <li key={i} className="issue-item">
                <span className="badge badge-warning">{violation.severity}</span>
                <strong>{violation.issue}</strong>
                <p>
                  {violation.code_section !== "unclear" && (
                    <span>Code: {violation.code_section}. </span>
                  )}
                  {violation.evidence}
                </p>
              </li>
            ))}
          </ul>
        )}
        {result.recommendations_error && (
          <p className="error-banner">{result.recommendations_error}</p>
        )}
      </section>

      <section className="card">
        <h3>Recommendations ({recommendations.length})</h3>
        {recommendations.length === 0 ? (
          <p className="muted">No recommendations generated.</p>
        ) : (
          <ul className="issue-list">
            {recommendations.map((rec, i) => (
              <li key={i} className="issue-item">
                <span className="badge badge-info">{rec.confidence}</span>
                <strong>{rec.violation}</strong>
                <p>{rec.recommended_fix}</p>
                <p className="recommendation">{rec.design_adjustment}</p>
                {rec.drawing_location.annotation_text && (
                  <p className="muted">Drawing note: {rec.drawing_location.annotation_text}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card report-markdown">
        <h3>Full Report</h3>
        <ReactMarkdown>{result.report_markdown}</ReactMarkdown>
      </section>

      <details className="json-panel">
        <summary>Raw JSON</summary>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}
