// Arize adapter (PLAN.md §5 Arize). Evaluates findings across four dimensions
// and traces the run. Evals are computed deterministically from the rule/fact/
// source graph so they are reproducible for the demo set piece; when ARIZE keys
// are present each evaluation is emitted as a real OTLP span (with the eval
// scores as attributes) so the Arize dashboard shows the before/after.
import { SpanStatusCode } from "@opentelemetry/api";
import type { Finding, Rule, Source, PlanFact, EvalResult } from "../types";
import { getTracer } from "./otel";

export const ARIZE_LIVE =
  !!process.env.ARIZE_API_KEY && !!process.env.ARIZE_SPACE_ID;

interface EvalInput {
  finding: Finding;
  rule: Rule | undefined;
  fact: PlanFact | undefined;
  source: Source | undefined;
  projectSubtype: string;
}

// The applicability eval is the one that catches the scripted bug: a rule whose
// appliesTo does not match the project subtype scores low and fails.
export function evaluateFinding(input: EvalInput): EvalResult[] {
  const { rule, source, fact, projectSubtype } = input;
  const results: EvalResult[] = [];

  // Rule applicability — the differentiator.
  const applies = rule
    ? rule.appliesTo === "any" || rule.appliesTo === projectSubtype
    : false;
  results.push({
    dimension: "applicability",
    score: applies ? 0.97 : 0.18,
    passed: applies,
    rationale: rule
      ? applies
        ? `Rule applies to ${projectSubtype}.`
        : `Rule targets "${rule.appliesTo}" but project is "${projectSubtype}" — inapplicable.`
      : "No rule resolved for this finding.",
  });

  // Source authority — official domain signal.
  const auth = source?.authorityScore ?? 0;
  results.push({
    dimension: "authority",
    score: auth,
    passed: auth >= 0.8,
    rationale: source
      ? `Source ${source.id} authority ${(auth * 100).toFixed(0)}%.`
      : "No source attached.",
  });

  // Citation correctness — does the cited excerpt mention the rule's subject?
  const subj = rule?.unit === "sqft" ? "square feet" : rule?.unit === "ft" ? "feet" : "";
  const cited = source ? source.excerpt.toLowerCase() : "";
  const citationOk = !!source && (subj === "" || cited.includes(subj.split(" ")[0]));
  results.push({
    dimension: "citation",
    score: citationOk ? 0.94 : 0.4,
    passed: citationOk,
    rationale: citationOk
      ? "Cited excerpt supports the finding."
      : "Cited excerpt does not clearly support the finding.",
  });

  // Hallucination risk — is the finding grounded in an extracted fact?
  const grounded = !!fact && fact.confidence >= 0.75;
  results.push({
    dimension: "hallucination",
    score: grounded ? 0.92 : 0.5,
    passed: grounded,
    rationale: grounded
      ? "Grounded in a high-confidence extracted fact."
      : "Weakly grounded — extracted fact missing or low confidence.",
  });

  if (ARIZE_LIVE) {
    const appliesOk = results.find((r) => r.dimension === "applicability")?.passed ?? true;
    emitSpan(input.finding, input.rule, results, appliesOk);
  }
  return results;
}

// Emit one OTLP span per finding evaluation. The span name and attributes are
// OpenInference-flavored so the finding (and its eval scores) render in Arize;
// a failed applicability eval marks the span ERROR — that is the trace the demo
// shows being caught, then corrected on the re-run.
function emitSpan(
  finding: Finding,
  rule: Rule | undefined,
  evals: EvalResult[],
  ok: boolean
): void {
  const tracer = getTracer();
  if (!tracer) return;
  try {
    const span = tracer.startSpan(`compliance.eval:${finding.ruleKey}`);
    span.setAttribute("openinference.span.kind", "EVALUATOR");
    span.setAttribute("finding.id", finding.id);
    span.setAttribute("finding.rule_key", finding.ruleKey);
    span.setAttribute("finding.title", finding.title);
    span.setAttribute("finding.status", finding.status);
    span.setAttribute("finding.corrected", !!finding.corrected);
    if (rule) {
      span.setAttribute("rule.applies_to", rule.appliesTo);
      span.setAttribute("rule.source_id", rule.sourceId);
    }
    for (const e of evals) {
      span.setAttribute(`eval.${e.dimension}.score`, e.score);
      span.setAttribute(`eval.${e.dimension}.passed`, e.passed);
      span.setAttribute(`eval.${e.dimension}.rationale`, e.rationale);
    }
    span.setStatus({
      code: ok ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      message: ok ? undefined : "Rule applicability eval failed",
    });
    span.end();
  } catch {
    /* best-effort telemetry */
  }
}
