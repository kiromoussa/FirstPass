// OpenTelemetry → Arize tracer (PLAN.md §5 Arize). Lazily initializes a tracer
// provider that exports spans to Arize over OTLP/HTTP. SimpleSpanProcessor
// exports each span on end so traces flush even in short-lived serverless
// invocations. No-op unless ARIZE_API_KEY + ARIZE_SPACE_ID are set.
import { trace, type Tracer } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const ARIZE_LIVE = !!process.env.ARIZE_API_KEY && !!process.env.ARIZE_SPACE_ID;

let provider: NodeTracerProvider | null = null;
let tracer: Tracer | null = null;

export function getTracer(): Tracer | null {
  if (!ARIZE_LIVE) return null;
  if (tracer) return tracer;
  try {
    const exporter = new OTLPTraceExporter({
      url: "https://otlp.arize.com/v1/traces",
      headers: {
        space_id: process.env.ARIZE_SPACE_ID!,
        api_key: process.env.ARIZE_API_KEY!,
      },
    });
    provider = new NodeTracerProvider({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: "firstpass",
        model_id: "firstpass",
        "openinference.project.name": "firstpass",
      }),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    tracer = provider.getTracer("firstpass");
    return tracer;
  } catch {
    return null;
  }
}

export async function flushTraces(): Promise<void> {
  try {
    await provider?.forceFlush();
  } catch {
    /* best-effort */
  }
}
